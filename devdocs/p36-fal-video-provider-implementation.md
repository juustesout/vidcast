# P36 FAL.ai Video Provider — Implementation

Status: IMPLEMENTED. `FalVideoGenerationProvider` is added behind the existing
`VideoGenerationProvider` interface, with `fal` provider-id plumbing across the
run policy, registry, service normalization and API schema. **No real FAL.ai
request was made, no paid generation ran, and no credential value was read,
printed or logged. The ~$50 FAL.ai reserve is untouched.**

Baseline: branch `main`, HEAD `309f4ba` ("feat(production): add opt-in background
music to production runs"), == `origin/main`. P35 recon
(`p35-fal-video-provider-readiness-recon.md`) was followed as the checklist and
re-verified against the current tree and the live official FAL.ai documentation.

---

## 1. Repository and scope

- Verified branch `main`, HEAD `309f4ba`, working tree clean apart from the
  untracked recon reports (`p29*`, `p29.2*`, `p31*`, `p33*`, `p35*`), which were
  left untouched.
- Scope kept to the video-provider integration: one new adapter, the `fal`
  provider id in existing enums/parse/policy/registry paths, the run-start API
  enum, `.env.example` placeholders, and tests. No changes to TTS, music, image
  generation, the compositor, MCP or the UI.
- No second job store, no new pipeline, no webhook infrastructure.

## 2. Changed files

New:

- `lib/ai/video-generation/fal-provider.ts` — the adapter.
- `tests/fal-video-provider.test.ts` — adapter unit tests (injected `fetch`).
- `tests/fal-video-service.test.ts` — scene-service integration with the real
  adapter and an injected `fetch` (submit → poll → download → save).
- `tests/fal-video-storage.integration.test.ts` — real FFmpeg fixture →
  download → real media store → FFmpeg/FFprobe decode.
- `p36-fal-video-provider-implementation.md` — this report.

Modified:

- `lib/ai/video-generation/registry.ts` — `getProvider('fal')`; added
  `falConfigured` to the config status.
- `lib/production/run-types.ts` — `VideoRunProvider` now `'local' | 'openai' | 'fal'`.
- `lib/types/generation.ts` — `GenerationProvider` now includes `'fal'`.
- `lib/production/run-policy.ts` — `parseVideoProvider`, `isRealProvider`,
  `normalizeRequestedProvider` (manual video), `assertRealProviderCredentials`
  and `assertRunPolicyPreflight` all understand `fal` and require `FAL_KEY` in
  real mode.
- `lib/generation/video-generation-service.ts` — `normalizeProviderNameForGeneration`
  maps `fal → fal` (previously `fal` would have normalized to `other`).
- `lib/production/run-registry.ts` — log sanitizer also redacts
  `Authorization: Key <token>` (FAL) in addition to `Bearer`/`sk-`.
- `app/api/projects/[id]/production-runs/route.ts` — run-start schema accepts
  `providers.video: 'fal'`.
- `.env.example` — `FAL_KEY` + optional `FAL_VIDEO_*` placeholders.
- `tests/video-provider-registry.test.ts`, `tests/run-policy.test.ts`,
  `tests/run-recovery.test.ts`, `tests/run-registry.test.ts` — extended coverage.

## 3. Architecture decisions

- **Adapter behind the existing interface.** `FalVideoGenerationProvider`
  implements `VideoGenerationProvider` (`providerId='fal'`, `submit`,
  `getStatus`, `download`, `cancel`). The existing submit/poll/download/store
  flow, per-scene/attempt locks, run duplicate suppression and recovery are
  reused unchanged.
- **Durable composite job id (`fal:{endpoint}:{request_id}`).** The registry
  builds a fresh provider instance per call and `getStatus`/`download` receive
  only the provider job id, so the endpoint is encoded in the job id. This is
  persisted on the attempt by the existing service and survives process restart,
  guaranteeing poll/download use the same endpoint as submit. A raw legacy id
  still falls back to the configured endpoint.
- **Deterministic endpoint from config.** `FAL_VIDEO_ENDPOINT` defaults to
  `minimax/h3-max-turbo/text-to-video`. A scene-level `request.model` may
  override it, but only if it matches an anchored path-safe pattern (no
  traversal/protocol injection).
- **Text-to-video only (phase 1).** The pipeline marks all references
  `role:'reference'` with no proven `start_frame` semantics, so reference images
  are rejected explicitly (`REFERENCE_ERROR`) rather than silently dropped.
- **Capability validation.** Aspect ratio is validated against the app's
  `16:9 | 1:1 | 9:16`; duration is validated to `1..15` whole seconds
  (`UNSUPPORTED` otherwise). `prompt_expansion_mode` is always sent (default
  `disabled`) and validated.
- **Adapter-owned timeout.** Each request uses an `AbortController` deadline
  (`FAL_VIDEO_TIMEOUT_MS`, default 120000 ms), mirroring
  `lib/ai/music/elevenlabs-provider.ts`. A timeout maps to
  `PROVIDER_FAILED (504)`. No unbounded automatic retries (FAL's own server-side
  retry still applies; we do not add more).
- **Real default unchanged.** `resolveProviderDefaults('real').video` stays
  `openai`; `fal` is an explicitly selectable real provider. This preserves
  backward compatibility and avoids silently routing real runs to a newly added
  provider. (P35 explicitly allowed this.)

## 4. Verified official FAL.ai contract

Sources (fetched during this implementation):

- Queue API: <https://fal.ai/docs/documentation/model-apis/inference/queue>
- Endpoint schema:
  <https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max-turbo/text-to-video>
- Model page: <https://fal.ai/models/minimax/h3-max-turbo/text-to-video/api>

Confirmed and implemented:

- Auth header: `Authorization: Key $FAL_KEY` (existence-only check of `FAL_KEY`;
  the value is used solely in the request header and never logged).
- Submit: `POST https://queue.fal.run/{endpoint}` →
  `{ request_id, status? , response_url, status_url, cancel_url, queue_position }`.
- Status: `GET https://queue.fal.run/{endpoint}/requests/{request_id}/status?logs=1`
  → `{ status: IN_QUEUE | IN_PROGRESS | COMPLETED, queue_position?, error?, error_type?, ... }`.
- Result: `GET https://queue.fal.run/{endpoint}/requests/{request_id}` →
  `{ video: { url, content_type, file_name, file_size }, expanded_prompt?, timings? }`.
- Cancel: `PUT .../requests/{request_id}/cancel`.
- Status mapping: `IN_QUEUE → queued`, `IN_PROGRESS → generating`,
  `COMPLETED → generated` (or `failed` when an `error`/`error_type` is present).
  Unknown statuses are kept as `generating` so a live job is never abandoned.
- Media URLs (`https://v3.fal.media/...`) are public and expire → downloaded
  immediately on the `generated` poll. The API key is deliberately **not** sent
  to the media host.
- Model input schema: `prompt` (required), `prompt_expansion_mode` (required,
  default `balanced`), `duration` (0.92–15, default 5), `resolution`
  (`480P|768P|1080P`), `aspect_ratio` (`21:9|16:9|4:3|1:1|3:4|9:16`), `seed`,
  `enable_safety_checker`, `sync_mode`, `target_audio_url`. Output `video.url`.

## 5. Payment safety

- `fal` is classified as a real provider (`isRealProvider`), so a real request
  requires `mode:'real'` **and** `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true`
  **and** `FAL_KEY`, enforced by the existing `resolveManualGenerationProvider` /
  `assertRunPolicyPreflight` before any request is built.
- Mock mode only allows the `local` video provider; `fal` is rejected at policy
  resolution, before the registry/provider is ever reached. The adapter also
  throws `NOT_CONFIGURED` with no network if `FAL_KEY` is absent.
- Recovery still suppresses a real-mode `video_submit` when an active attempt has
  no persisted `providerJobId`, so a possibly-accepted paid job is never blindly
  resubmitted. A poll timeout preserves the persisted job id (identity survives),
  keeping the job diagnosable/resumable.
- No paid smoke test, provider probe or startup call was added.

## 6. Tests and results

Commands and outcomes:

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean (no warnings/errors).
- `npm run build` — succeeded.
- `npx vitest run` — **81 files / 546 tests passed** (baseline was 78 / 515).
- Real local FFmpeg was available and executed:
  `tests/fal-video-storage.integration.test.ts` generated a real decodable MP4,
  ran it through the provider download → real `mediaStore.saveGeneratedVideo` →
  real `ffmpeg` decode → real `ffprobe`, asserting a 160x120 video stream and a
  non-zero on-disk asset. The FFmpeg-based tests are not skipped in this run.

Coverage mapped to the P36 requirements:

1. Provider registration/selection — `tests/video-provider-registry.test.ts`.
2. Mock mode cannot reach FAL — `tests/fal-video-service.test.ts` (asserts
   `getProvider` is never called and no network) + policy tests.
3. Real mode without opt-in/credentials blocked pre-request —
   `tests/run-policy.test.ts`.
4. Submit request shape + safe request-id handling —
   `tests/fal-video-provider.test.ts`.
5. Poll/download use the submit endpoint — adapter tests + composite-id tests.
6. Persist/resume keep provider + endpoint identity —
   `tests/fal-video-service.test.ts` (persisted `provider='fal'` and composite
   job id), `tests/run-recovery.test.ts` (fal job left for polling).
7. Submit timeout does not resubmit — `tests/fal-video-service.test.ts`.
8. Poll timeout keeps the job id (resumable) — `tests/fal-video-service.test.ts`.
9. HTTP errors / malformed / missing output / unknown statuses —
   `tests/fal-video-provider.test.ts`.
10. Download → storage chain yields a usable asset —
    `tests/fal-video-storage.integration.test.ts`.
11. Render-chain compatibility — real FFmpeg decode + FFprobe of the stored FAL
    asset.
12. No key/authorization header in logs or errors — adapter error-message test +
    `tests/run-registry.test.ts` (`Authorization: Key` redaction).

## 7. Remaining limitations

- Image-to-video / start-frame support is intentionally out of scope; reference
  images are rejected (`REFERENCE_ERROR`).
- The model name/pricing on fal.ai can change; re-verify before any real pilot.
- Unknown FAL statuses are treated as `generating` (bounded by the run's poll
  limit) to avoid abandoning a live job; they are surfaced as `providerStatus`.
- The real-provider pilot (a single gated, capped real FAL request) remains a
  separate, explicitly-approved step and was **not** executed here.

## 8. Confirmation

No real FAL.ai API calls were made, no paid generation ran, and no credential
value was read, printed or logged during this phase. The existing ~$50 FAL.ai
reserve is untouched. All verification used injected `fetch` mocks or local
FFmpeg fixtures only.
