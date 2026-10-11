# P28 Real-Provider Readiness Recon

Status: RECON ONLY. No application code, tests, schema, config, dependencies,
MCP tools or UI were changed. No paid API calls were made and no credentials were
verified by real requests. No commits or pushes. Existing P27 changes and all
untracked recon/report files were preserved.

Evidence tags used throughout: **Verified by test / Code-inspected / Unverified /
Potential risk**.

Baseline: branch `main`, HEAD `99bb619...` plus the P27 working-tree changes
(`lib/production/run-service.ts`, `tests/production-run-lifecycle.test.ts`).

Environment probe (existence only — values never read or printed):
`OPENAI_API_KEY=SET`, `ELEVENLABS_API_KEY=UNSET`,
`PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=UNSET`, `PRODUCTION_RUN_DEFAULT_MODE=UNSET`,
`OPENAI_IMAGE_MODEL=UNSET`, `OPENAI_VIDEO_MODEL=UNSET`,
`ELEVENLABS_TTS_MODEL=UNSET`.

---

## 1. Summary and readiness verdict

The application has a complete, fail-closed provider policy plus real adapters
for OpenAI (image, video) and ElevenLabs (TTS, music). In **this** environment it
is hard-wired to mock mode: `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS` is unset, so
`resolveRunPolicyServerConfig` forces `defaultMode = 'mock'`
(`lib/production/run-policy.ts:79-88`). No real provider call is possible today
without an explicit config change.

Readiness by modality:

| Modality | Adapter | Mock | Policy gate | Adapter tests | Real bytes → store → render chain |
| --- | --- | --- | --- | --- | --- |
| Image (OpenAI) | Real | fake | solid | yes (mocked HTTP) | **not proven** |
| Narration (ElevenLabs) | Real | fake | solid | yes (mocked HTTP) | proven for fake WAV; not for real MP3 |
| Music (ElevenLabs) | Real, most hardened | fake | solid | yes (mocked HTTP) | not proven; excluded from runs |
| Video (OpenAI) | Real, **placeholder-like contract** | fake stub | solid | **none** | not proven; mock stub non-decodable |

Verdict:

- **Overall: not yet ready for a real end-to-end pilot across all modalities.**
  The policy/credential layer is production-shaped, but no real provider output
  has ever been proven to flow into the media store, FFmpeg render, and final
  composition (that portion is only mocked).
- **Image generation is the most suitable first pilot** (Section 6): its real
  adapter is exercised by tests against mocked HTTP, the credential
  (`OPENAI_API_KEY`) is present in this environment, and it is the first stage of
  every explainer video (image → scene render → composition).
- **Video is the least ready**: the OpenAI video adapter targets an unverified
  endpoint/model contract, has zero tests, no timeout, and its fake counterpart
  produces a non-decodable stub.

---

## 2. Provider matrix

Provider selection authority: `lib/production/run-policy.ts`. Defaults per mode —
`resolveProviderDefaults` (`run-policy.ts:90-106`): mock = `image:fake`,
`video:local`, `narration:fake`, `music:fake`; real = `image:openai`,
`video:openai`, `narration:elevenlabs`, `music:elevenlabs`.

| Modality | Provider id | Adapter | Kind | Real HTTP call site | Credentials / config | Output format | Timeout / abort | Retry | Job id |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Image | `openai` | `OpenAiImageGenerationProvider` (`lib/ai/image-generation/openai-provider.ts:53`) | REAL | `POST /images/generations`, `POST /images/edits` (`:98`,`:89`) | `OPENAI_API_KEY`; `OPENAI_IMAGE_MODEL` (default `gpt-image-1`) | `image/png` (b64_json → Buffer) | external signal only; **no timeout** | none | `x-request-id` |
| Image | `fake` | `FakeImageGenerationProvider` (`fake-provider.ts:6`) | FAKE/LOCAL | none (`sharp` PNG 1280x720) | — | `image/png` | none | none | `fake-<hash>` |
| Video | `openai` | `OpenAiVideoGenerationProvider` (`video-generation/openai-provider.ts:50`) | REAL (contract unverified) | `POST /videos/generations`, `GET /videos/generations/{id}`, `GET outputUrl` (`:98`,`:127`,`:162`) | `OPENAI_API_KEY`; `OPENAI_VIDEO_MODEL` (default `sora-1`) | content-type else `video/mp4` | **none** (no signal/timeout) | none | raw `body.id` |
| Video | `fake`/`local` | `FakeVideoGenerationProvider` (`fake-provider.ts:17`) | FAKE/LOCAL | none | — | `video/mp4` header over a **24-byte non-decodable stub** (`:15`) | none | none | `fake-video-job-<hash>` |
| Narration | `elevenlabs` | `ElevenLabsTextToSpeechProvider` (`text-to-speech/elevenlabs-provider.ts:42`) | REAL | `POST /text-to-speech/{voiceId}` (`:69`) | `ELEVENLABS_API_KEY`; `ELEVENLABS_TTS_MODEL` (default `eleven_multilingual_v2`) | `wav`→wav; `mp3`/`m4a`→`mp3_44100_128`, `audio/mpeg` | external signal only; **no timeout** | none | `request-id` |
| Narration | `fake` | `FakeTextToSpeechProvider` (`fake-provider.ts:16`) | FAKE/LOCAL | none (silent WAV) | `TTS_DEFAULT_*` | `audio/wav` | none | none | `fake-request-id` |
| Music | `elevenlabs` | `ElevenLabsMusicProvider` (`music/elevenlabs-provider.ts:144`) | REAL | `POST /music?output_format=` (`:200`) | `ELEVENLABS_API_KEY`; `ELEVENLABS_MUSIC_MODEL`; `ELEVENLABS_MUSIC_BASE_URL`; `ELEVENLABS_MUSIC_TIMEOUT_MS` | `audio/mpeg` | **own AbortController + 300s deadline** (`:116-142`) | none | `request-id` + `song-id` |
| Music | `fake` | `FakeMusicProvider` (`music/fake-provider.ts:7`) | FAKE/LOCAL | none (silent WAV) | — | `audio/wav` | none | none | `fake-music-request-id` |

Registry/config-status functions report "configured" as a **boolean** only
(`Boolean(process.env.*_API_KEY)`) — `lib/ai/image-generation/registry.ts:34`,
`video-generation/registry.ts:34`, `text-to-speech/registry.ts:34`,
`music/registry.ts:37`. Only the image status is exposed over HTTP
(`app/api/image-generation/status/route.ts`).

**Verified by test** (mocked HTTP): OpenAI image, ElevenLabs TTS, ElevenLabs
music adapters. **Unverified**: OpenAI video adapter (no test anywhere).

### Policy / configuration route

- `resolveRunPolicyServerConfig` (`run-policy.ts:79-88`): `defaultMode` is forced
  to `mock` unless `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS` is truthy.
- `resolveRunPolicy` (`run-policy.ts:152-241`): real mode denied with
  `POLICY_DENIED` 403 if not allowed; mock mode rejects any non-fake/local
  provider (`PROVIDER_NOT_ALLOWED` 403); real mode requires **all four**
  providers real.
- `assertRunPolicyPreflight` (`run-policy.ts:268-335`): requires
  `OPENAI_API_KEY` for image/video actions and `ELEVENLABS_API_KEY` for narration
  actions; **no music check** (music is not a run action).
- `resolveManualGenerationProvider` (`run-policy.ts:411-444`): honors
  `options.mode`; normalizes a single modality; asserts credentials in real mode.
  JSDoc claims callers "may only request a provider, never a mode"
  (`:406-407`), but the music route and the MCP music tool pass a client `mode`
  (see risks).

Influence surfaces:

- **Production run** REST `POST /api/projects/[id]/production-runs`
  (`app/api/projects/[id]/production-runs/route.ts:12-32`): accepts `mode` and
  `providers {image,video,narration}` — **no `music`**.
- **Manual** routes: image/video accept only `regenerate` (server default
  provider); narration accepts `provider` (no `mode`); music accepts `provider`
  **and `mode`** (`app/api/projects/[id]/music/route.ts:45-88`).
- **UI**: no surface sends provider/mode for image/video/narration; the background
  music panel also omits it; the scene provider dropdown writes display-only
  metadata (`scene.visual.generation.provider`) that is not used for execution.
- **MCP**: `run_production` mirrors the run schema (no `music`);
  `manage_project_music` exposes `provider` and `mode`.

Required configuration for a real provider: `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS`
truthy, plus the modality key (`OPENAI_API_KEY` and/or `ELEVENLABS_API_KEY`), and
optionally `PRODUCTION_RUN_DEFAULT_MODE=real` (otherwise a caller must pass
`mode:'real'`).

---

## 3. End-to-end pipeline findings

No real provider output has been proven to reach the MP4. The links below state
where proof stops.

**Image** — entry `app/api/projects/[id]/scenes/[sceneId]/generate-image/route.ts`
→ `image-generation-service.ts`; adapter proven with mocked HTTP; service logic
proven with a **mocked media store** (`tests/image-generation-service.test.ts`).
The real writer `mediaStore.saveGeneratedImage` (`lib/storage/media-store.ts:272-310`)
maps MIME→extension (`webp|jpg|png`) and probes metadata — **Code-inspected,
untested with real bytes**. Render/compose of images is proven with fake PNG
(`tests/fake-image-provider-render.test.ts`). → chain **not proven for real**.

**Narration** — service proven with mocked media; the **fake-WAV** path is proven
to disk including format/MIME/extension/duration agreement
(`tests/narration-fake-provider.integration.test.ts`). Real ElevenLabs MP3/M4A →
store is Code-inspected only. `m4a` requests are served as MP3 and labeled
`audio/mpeg` (truthful, but no M4A is ever produced).

**Music** — adapter proven with mocked HTTP; service proven with mocked media;
real-store path Code-inspected. Music is **not** part of production runs.

**Video** — weakest: adapter untested; fake stub is a 24-byte non-decodable file
(`lib/ai/video-generation/fake-provider.ts:15`), so a mock-mode video asset cannot
be decoded by scene render/ffprobe; the submit→poll→download→store→render chain is
Code-inspected at best.

**Render / composition** — proven: `lib/render/renderer.ts` `validateOutputFile`
(size + ffprobe dims/duration + h264/mp4) via `tests/local-ffmpeg-renderer.test.ts`;
final compose + artifact path via `tests/video-composition-service.integration.test.ts`
and `tests/video-compositor-audio.integration.test.ts`. These tests fabricate
renders/audio directly and bypass the generation services, so they prove
render→compose but **not** provider→render.

**Asset path/MIME/extension** — extension is derived from the **provider-reported
MIME**, not byte sniffing (`media-store.ts:275,315,356,395`). This works for the
current adapters but means a mislabeled provider MIME (e.g. ElevenLabs `m4a`
→`audio/mpeg`) silently determines the stored extension.

**Run status/logging/recovery** — proven for mock runs (P27 lifecycle tests +
`tests/run-recovery.test.ts`); real-mode run execution is untested.

---

## 4. Concrete blockers, ranked

1. **OpenAI video adapter is unverified** (`lib/ai/video-generation/openai-provider.ts`):
   endpoint `/videos/generations` + default model `sora-1` do not match OpenAI's
   documented video API, and there is **zero test coverage** (no test imports it).
   **Potential risk / Unverified**.
2. **No request timeouts/abort for paid calls (image, TTS, video).** Only the music
   adapter has an internal AbortController + deadline; image/TTS forward an
   external signal that the services never supply
   (`lib/generation/image-generation-service.ts:251`,
   `narration-service.ts:240`), and video has none. A stalled paid request can hang
   the worker. **Code-inspected / Potential risk**.
3. **Real bytes → real media store → render → compose is unproven.** All modality
   service tests inject a mocked media store; only the fake-WAV narration path
   uses the real writer. **Code-inspected**.
4. **Fake video provider emits a non-decodable stub**
   (`fake-provider.ts:15`) — mock-mode video cannot render, and no test catches it.
   **Code-inspected / Potential risk**.
5. **Client-controllable `mode` on music and production runs** when real providers
   are allowed: `resolveManualGenerationProvider` honors `options.mode`
   (`run-policy.ts:417`), the music route forwards `body.mode`
   (`app/api/projects/[id]/music/route.ts:87`), and the run route accepts `mode`.
   Escalation is still gated by `allowRealProviders`, but it is asymmetric with
   image/video/narration and can trigger paid calls a client toggles.
   **Code-inspected / Potential risk**.
6. **No MIME/extension byte-sniffing guarantees** for real provider output; storage
   trusts the reported content-type. **Code-inspected**.
7. **Video polling has no backoff** — bounded only by `maxIterations` (default 24)
   and `maxVideoPolls` (default 120). **Code-inspected**.
8. **Music excluded from production runs; `seed` silently dropped**
   (`music/elevenlabs-provider.ts:186-187`). **Code-inspected**.

---

## 5. Cost, security and reliability risks

Cost / request safety (no paid calls executed):

- **Retries:** no adapter retries paid generation. The production runner does not
  auto-retry a failed paid action — failures are recorded in `failedActionIds` and
  the planner marks them `failed`. Manual `regenerate` or a repeated user action
  **does** trigger a new paid request. **Code-inspected**.
- **Duplicate actions:** per-scene submit/poll locks
  (`lib/generation/video-generation-service.ts:16-17,232-237,394-399`), a
  project-level music lock (`music-service.ts:148-152`), and P27 run-start
  coalescing (`run-service.ts` `pendingStarts`) prevent concurrent duplicates;
  a completed/failed request followed by a new user action is a new charge.
  **Verified by test / Code-inspected**.
- **Timeout after success:** image/TTS have no timeout, so a hung connection is
  never abandoned; video download re-calls `getStatus` first (an extra status GET,
  not a new generation). Music aborts at 300s → 504. **Code-inspected**.
- **Abort / job ids:** OpenAI video declares `supportsCancellation:false` and
  implements no cancel; IDs returned by providers are persisted
  (`providerRequestId`, `providerJobId`) and reused for polling.
  **Code-inspected**.
- **Limits/confirmations:** auth + in-memory per-identity throttle
  (`lib/security/access-control.ts:121-190`; e.g. `run_start` 6/min,
  `generate_music` 6/min, `generate_image` 20/min) — **no cost confirmation,
  no spend cap, no per-modality budget**. **Code-inspected**.

Security / secrets:

- API keys are read only inside adapters/registries (`process.env.*_API_KEY`);
  there is **no `console.*` logging in `lib/ai` or `lib/generation`**
  (grep: none). Status endpoints return booleans, never values.
- Run logs are sanitized: `InMemoryRunRegistry.sanitizeText` redacts
  `Bearer <token>` and `sk-…` patterns before persisting events
  (`lib/production/run-registry.ts:28-54`).
- Provider error messages use only the provider's `error.message` (e.g.
  `parseSafeErrorMessage`, `openai-provider.ts:9-17`), not the key. **Potential
  risk:** an upstream provider could echo request content in an error; the log
  sanitizer mitigates token-looking strings but not arbitrary content.
- MCP clients read `EXPLAINER_API_TOKEN` and send `Authorization: Bearer …`
  (`mcp/*/api-client.ts`); the token is not echoed in tool output.
- Keys are never written into project data or asset metadata.

Required env for a real local pilot (never print values):
`OPENAI_API_KEY` (image/video), `ELEVENLABS_API_KEY` (narration/music),
`PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true`, `PRODUCTION_RUN_DEFAULT_MODE=real`
(optional; callers may pass `mode:'real'` instead), and optionally
`OPENAI_IMAGE_MODEL` / `OPENAI_VIDEO_MODEL` / `ELEVENLABS_TTS_MODEL`.

Reliability: real-provider persistence, restart recovery and duplicate-run
behavior are proven only in mock mode; real-mode recovery is untested.

---

## 6. Recommended pilot and acceptance criteria

Comparison (weighted toward proving the full chain cheaply and safely):

| Modality | Technical readiness | Missing pieces | Cost/dup risk | Speed to prove chain | Fit for explainer workflow |
| --- | --- | --- | --- | --- | --- |
| **Image (OpenAI)** | High — adapter real + tested, key present, pipeline proven with fake PNG | real-bytes→store test; timeout | Low (1 image ≈ low cost) | **Fastest** | High (first stage of every video) |
| Narration (ElevenLabs) | High — adapter real + tested; WAV path proven to disk | key missing locally; m4a label bug; timeout | Low–medium | Fast | High |
| Music (ElevenLabs) | High — most hardened adapter | key missing; excluded from runs; real-store untested | Medium (minutes of audio) | Medium | Medium (optional bed) |
| Video (OpenAI) | **Low** — unverified contract, no tests, no timeout | adapter contract, tests, decodable output | High (video is expensive) | Slow | Medium |

**Recommended first pilot: OpenAI image generation, single scene.**

Scope:

- One project, one `generated_image` scene, one image, `regenerate: false`.
- Real OpenAI Images only; no TTS, no video, no music.
- Never executed as part of this recon.

Minimal setup (pilot phase, not now): set `OPENAI_API_KEY` (already present),
`PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true`, `PRODUCTION_RUN_DEFAULT_MODE=real`
(dev session only), then invoke the manual generate-image route for the one scene.

Objective acceptance criteria:

1. Exactly **one** real OpenAI Images request is issued for the pilot (single
   scene, no retries, no batch).
2. The returned PNG is persisted by the **real** media store at
   `projects/<id>/assets/scene-01-generated-<attemptId>.png` with `type: image`,
   `mimeType: image/png`, non-zero width/height, and
   `metadata.providerRequestId` populated.
3. The scene asset resolves and is consumed by `sceneRenderService.renderScene`,
   producing an MP4 that passes `validateOutputFile` (h264/mp4, correct dims).
4. `videoCompositionService.composeProject` produces a playable final MP4 whose
   artifact path is recorded.
5. A provider failure surfaces as a typed, user-friendly error (`*.provider.*`)
   and leaks no secret into logs or the response.
6. Cost is bounded to a single image; no duplicate paid requests occur for the
   same scene (submit lock + one-shot run).

Proposed next small implementation phase (to schedule after this recon): add an
**opt-in, default-off** real-image smoke test (gated by an explicit env flag such
as `RUN_REAL_IMAGE_PILOT=1`) that exercises step 1–4 and asserts the single-request
bound, plus a minimal bounded request timeout for the OpenAI image adapter to
close blocker #2 for the pilot path. No other modalities, no broad refactor.

---

## 7. Exact files and functions supporting the findings

- Policy/authority: `lib/production/run-policy.ts` —
  `resolveRunPolicyServerConfig` (:79-88), `resolveProviderDefaults` (:90-106),
  `resolveRunPolicy` (:152-241), `assertRunPolicyPreflight` (:268-335),
  `resolveManualGenerationProvider` (:411-444), `assertRealProviderCredentials`
  (:393-401).
- Types: `lib/production/run-types.ts` (:4-22).
- Adapters: `lib/ai/image-generation/openai-provider.ts` (:53,:89,:98,:117-119);
  `lib/ai/video-generation/openai-provider.ts` (:50,:98,:127,:150-183);
  `lib/ai/text-to-speech/elevenlabs-provider.ts` (:16-24,:42,:69);
  `lib/ai/music/elevenlabs-provider.ts` (:116-142,:144,:186-187,:200);
  fakes in the matching `fake-provider.ts` files
  (`video-generation/fake-provider.ts:15`).
- Registries / config status: `lib/ai/{image-generation,video-generation,text-to-speech,music}/registry.ts`.
- Services + storage mapping: `lib/generation/{image-generation-service,video-generation-service,narration-service,music-service}.ts`;
  `lib/storage/media-store.ts` (:272-310 image, :312-351 video, :353-390 audio, :392-442 music).
- Routes: `app/api/projects/[id]/production-runs/route.ts` (:12-32);
  `app/api/projects/[id]/music/route.ts` (:45-88);
  `app/api/projects/[id]/scenes/[sceneId]/generate-{image,video,narration}/route.ts`.
- Run lifecycle: `lib/production/run-service.ts`; `production-runner.ts`;
  `production-planner.ts`; `run-recovery.ts`; `run-registry.ts` (:28-54 sanitizer).
- Security: `lib/security/access-control.ts` (:121-190).
- MCP: `mcp/production/tools.ts`, `mcp/authoring/tools.ts`, `mcp/*/api-client.ts`.

---

## 8. Tests executed and results

All executed tests use mocked HTTP, local FFmpeg, or loopback only — **no paid
provider requests**.

Run A — policy/registry/adapter/service (13 files, **67 passed**):
`tests/run-policy.test.ts`, `tests/image-provider-registry.test.ts`,
`tests/video-provider-registry.test.ts`, `tests/text-to-speech-provider-registry.test.ts`,
`tests/music-provider-registry.test.ts`, `tests/openai-provider.test.ts`,
`tests/elevenlabs-provider.test.ts`, `tests/music-elevenlabs-provider.test.ts`,
`tests/image-generation-service.test.ts`, `tests/video-generation-service.test.ts`,
`tests/narration-service.test.ts`, `tests/music-service.test.ts`,
`tests/narration-fake-provider.integration.test.ts`.

Run B — FFmpeg integration + credential fail-closed (5 files, **9 passed**):
`tests/video-composition-service.integration.test.ts`,
`tests/video-compositor-audio.integration.test.ts`,
`tests/local-ffmpeg-renderer.test.ts`, `tests/fake-image-provider-render.test.ts`,
`tests/mcp-credential-failclosed-stdio.integration.test.ts`.

Environment probe: existence-only check of the provider env vars listed at the
top (no values printed).

Coverage posture (inventory, not run): **no real-provider tests exist**; all
adapter tests stub `fetch`. The OpenAI video adapter has no test. FFmpeg-based
composition/render tests can silently pass if ffmpeg is missing (guard returns
early in `video-composition-service.integration.test.ts` and
`video-compositor-audio.integration.test.ts`); ffmpeg 5.1.9 is present here.
