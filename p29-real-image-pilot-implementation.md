# P29 — Opt-in Real Image Pilot: Implementation Report

Scope: implement the minimal missing pieces needed to run **one real OpenAI
image** through the full manual image chain (request → validated PNG asset →
storage → FFmpeg scene render → final composition), behind a default-off,
fail-closed opt-in. No broad refactor. No other modality activated. The paid
smoke run **was executed once** and passed end-to-end (see §8).

This report states explicitly what is proven by the implementation/tests
(mocked HTTP) versus what is proven by the real paid run (§8).

---

## 1. Files changed / added

| File | Kind | Purpose |
| --- | --- | --- |
| `lib/ai/image-generation/openai-provider.ts` | modified | Bounded configurable timeout, transport/HTTP error classification, PNG integrity validation, no auto-retry |
| `lib/ai/image-generation/real-image-pilot.ts` | **new** | Default-off, fail-closed pilot gate (pure, testable) |
| `lib/production/run-policy.ts` | modified | Narrow `imagePilot` option on `resolveManualGenerationProvider` (image-only widening; policy rules otherwise untouched) |
| `lib/generation/image-generation-service.ts` | modified | Image path consults the pilot gate and passes it to provider resolution |
| `scripts/real-image-pilot.ts` | **new** | Fail-closed smoke runner (generate → render → compose), not part of tests |
| `tests/openai-provider.test.ts` | modified | Timeout, error classification, PNG rejection, single-request tests |
| `tests/real-image-pilot.test.ts` | **new** | Gate unit tests + real-store/service integration (image → PNG asset → scene MP4) |
| `p29-real-image-pilot-implementation.md` | **new** | This report |

No changes to `resolveRunPolicy`, `assertRunPolicyPreflight`,
`assertRealProviderCredentials`, or the run executor. No env var is set or
written by the code.

---

## 2. What each change does

### 2.1 Bounded timeout — `openai-provider.ts`

- New `DEFAULT_TIMEOUT_MS = 120_000` and `OPENAI_IMAGE_TIMEOUT_MS` override
  (`openai-provider.ts:5`, `:150-151`). An explicit `timeoutMs` constructor
  option always wins.
- `createRequestSignal` (`:110`) combines the caller's `AbortSignal` with a hard
  deadline, `unref()`s the timer, and is always cleaned up in a `finally`
  (`:162`, `:232`) — covering both the request and the body read.
- **No automatic retry.** Exactly one `fetch` is issued per call.

### 2.2 Error classification — `openai-provider.ts`

`classifyHttpError` (`:87`) and `mapTransportError` (`:100`):

| Situation | status | code |
| --- | --- | --- |
| timeout / abort | 504 | `provider.request.timeout` |
| network / unreachable | 502 | `provider.request.unreachable` |
| 401 / 403 | 502 | `provider.request.unauthorized` |
| 429 | 429 | `provider.request.rateLimited` |
| other 4xx | 422 | `provider.request.rejected` |
| 5xx | 502 | `provider.request.failed` |

Provider messages are passed through the existing `parseErrorMessage`; the API
key is only ever sent in the `Authorization` header and is never logged or
embedded in an error.

### 2.3 PNG integrity validation — `openai-provider.ts`

`validatePngBytes` (`:63`) runs **before the service can persist anything**:

1. Byte length ≥ 8 and the 8-byte PNG signature must match.
2. `imageSize` must decode and return positive width/height.

Any failure throws `ImageGenerationProviderError(…, 502,
'provider.response.invalidImage')`, so an empty/truncated/non-PNG paid response
can never be written as a successful scene asset. The validated dimensions are
returned to the media store, which derives the `.png` extension from the
`image/png` MIME type.

### 2.4 Narrow pilot gate — `real-image-pilot.ts`

Pure function `resolveRealImagePilotGate(env)` returns
`{ enabled, confirmed, hasApiKey, allowed, reason }`. `allowed` is true only
when **all** hold (default: false):

- `RUN_REAL_IMAGE_PILOT` is truthy (`1`/`true`/`yes`/`on`);
- `CONFIRM_REAL_IMAGE_PILOT` equals **exactly** `YES`;
- `OPENAI_API_KEY` is present (existence only; the value is never read).

### 2.5 Image-only policy widening — `run-policy.ts` + `image-generation-service.ts`

`resolveManualGenerationProvider` gains an `imagePilot?: boolean` option
(`run-policy.ts:422`). When true **and** the global
`PRODUCTION_RUN_ALLOW_REAL_PROVIDERS` is off **and** no explicit `mode` was
supplied **and** the caller did not explicitly request `fake`, a manual *image*
call resolves to the real `openai` provider (`:427-448`). It still calls
`resolveRunPolicy` and `assertRealProviderCredentials`, so a missing
`OPENAI_API_KEY` still fails with the normal typed error. Video, narration and
music paths are completely unaffected. The service wires the gate in at
`image-generation-service.ts:140-142`.

Net effect: the image path can be enabled with a dedicated, double-confirmed,
image-only switch, without turning on the unverified OpenAI video adapter or the
ElevenLabs narration/music providers.

---

## 3. Configuration and exact smoke procedure

New/used environment variables (values shown are the required literals; never
commit real keys):

| Variable | Required for pilot | Default | Meaning |
| --- | --- | --- | --- |
| `RUN_REAL_IMAGE_PILOT` | yes | unset (off) | Master switch for the pilot |
| `CONFIRM_REAL_IMAGE_PILOT` | yes (must be `YES`) | unset | Second, exact confirmation |
| `OPENAI_API_KEY` | yes | unset | OpenAI credential (existence only) |
| `OPENAI_IMAGE_TIMEOUT_MS` | no | `120000` | Per-request deadline |
| `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS` | **no** | unset | Not required; do not enable for the pilot |

Smoke procedure (run manually; **not executed in this task**):

```bash
# Fail-closed gates. Do NOT set PRODUCTION_RUN_ALLOW_REAL_PROVIDERS.
export RUN_REAL_IMAGE_PILOT=true
export CONFIRM_REAL_IMAGE_PILOT=YES
export OPENAI_API_KEY=<your throwaway key>

# Optional: lower the deadline for a quicker negative test.
# export OPENAI_IMAGE_TIMEOUT_MS=120000

# One project with a single generated_image scene (use its real ids).
npx tsx scripts/real-image-pilot.ts <projectId> <sceneId>
```

The script refuses to run (exit 1, no provider contact) unless the gate is fully
satisfied, and refuses if the scene is not a `generated_image` scene. It counts
calls to `/images/` and fails unless the count is exactly 1, then renders the
scene and composes the final video. Revoke the throwaway key afterwards.

---

## 4. Tests and results

Added tests (all with mocked/local HTTP; **no paid call**):

- `tests/openai-provider.test.ts` (5 new): rejects non-PNG bytes; aborts a
  stalled request → 504 `provider.request.timeout`; distinguishes 401
  (`provider.request.unauthorized`) and 429 (`provider.request.rateLimited`);
  forwards an `AbortSignal` and issues exactly one request.
- `tests/real-image-pilot.test.ts` (6): gate defaults off; `CONFIRM` must equal
  exactly `YES`; key required; falsey enable ignored; pilot-disabled uses the
  fake provider with zero network calls; pilot-enabled issues exactly one
  request, persists a `image/png` asset (`.png`, width/height > 0,
  `providerRequestId` recorded) on disk; the persisted image renders to a scene
  MP4 via the real renderer.

Verification performed on the working tree:

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | clean |
| Lint | `npm run lint` | no warnings/errors |
| Full test suite | `npx vitest run` | 68 files / 405 tests passed |
| Production build | `npm run build` | succeeded |

(The suite grew from 67 files / 394 tests to 68 files / 405 tests: +1 file and
+11 tests.)

---

## 5. Fail-closed and no-auto-retry proof

- Gate default is off: `resolveRealImagePilotGate({})` → `allowed: false`
  (unit-tested). Missing key, wrong confirm value, or falsey enable all keep it
  off.
- The expensive path cannot run without the gate: `resolveImageProvider` only
  passes `imagePilot: pilot.allowed`; when off, the existing mock default (`fake`)
  is used and no HTTP is attempted (unit-tested).
- No automatic retry exists in the adapter; every code path issues a single
  `fetch`, and the pilot script asserts the observed `/images/` count is exactly
  1.
- Failed/invalid provider output throws typed errors and the service marks the
  attempt `failed`, preserving the previous asset (existing behavior); invalid
  bytes are rejected before any asset is written.
- No policy is bypassed: `resolveRunPolicy` and credential assertions are still
  invoked; only the blanket flag is narrowed, and only for the image modality.

---

## 6. Blockers / caveats

- End-to-end success against the live OpenAI Images API was verified once; see
  §8 for the run result and the adapter fix it surfaced.
- The model name defaults to `gpt-image-1` (`OPENAI_IMAGE_MODEL` overrides).
  `gpt-image-*` models reject the legacy `response_format` parameter, so it is
  now sent only for non-`gpt-image` models (dall-e) that default to URL output
  (`openai-provider.ts`, `supportsResponseFormat`).
- Only the manual image path is piloted. Full production runs in real mode
  (which require the global flag and all four providers) remain out of scope and
  still include the unverified OpenAI video adapter.
- `generateSceneImage` accepts an internal `mode`/`provider`; the public
  generate-image route forwards neither, so the pilot is driven purely by server
  env. No client input can enable it.

---

## 7. Implementation proof vs. real-run proof

| Acceptance item (from P28 §6) | Status now |
| --- | --- |
| Single real OpenAI image request, no retries/batch | **Live-proven** (script asserted exactly one `/images/` call) |
| PNG persisted via real media store with `image/png`, `.png`, dims, `providerRequestId` | **Live-proven** (2.69 MB `scene-01-generated-*.png` written) |
| Scene asset consumed by `sceneRenderService` → MP4 | **Live-proven** (scene render reported `completed`) |
| `videoCompositionService.composeProject` → playable MP4 | **Live-proven** (h264 1920x1080 + aac, 5.03 s, probe below) |
| Typed provider error, no secret leakage | **Implementation-proven** (classification tests; key only in header) |
| Cost bounded to one image, no duplicate paid calls | **Live-proven** (single-fetch count assert) |
| Actual live OpenAI Images success | **Live-proven** (see §8) |

---

## 8. Live pilot run (executed)

Run command (the platform's ambient `OPENAI_API_KEY` was unset so only the key
from `.env` could be used; values are never printed):

```bash
# key from .env only; pilot flags also supplied via .env
env -u OPENAI_API_KEY npx tsx --env-file=.env scripts/real-image-pilot.ts \
  project_afca8256-f75c-4f75-9779-26ae34f7b209 \
  scene_3e154ea3-cda3-4beb-a8de-a9f3c02fea9a
```

Result: `PASS`

- One real OpenAI Images request issued (script asserted the `/images/` count
  was exactly 1).
- Asset persisted: `projects/<id>/assets/scene-01-generated-*.png` (~2.69 MB),
  `provider=openai`.
- Scene render: `renders/scene_*.mp4` reported `completed`.
- Final composition: `renders/compositions/final-composition_*.mp4`; `ffprobe`
  reports `h264` 1920x1080 video + `aac` audio, duration `5.035 s`, ~1.26 MB.

Bug found and fixed by the live run:

- The first attempt failed with OpenAI `Unknown parameter: 'response_format'`.
  `gpt-image-1` always returns base64 and rejects `response_format`, which the
  adapter previously sent unconditionally. Fixed in
  `lib/ai/image-generation/openai-provider.ts` (`supportsResponseFormat`): the
  parameter is now sent only for non-`gpt-image` models (dall-e). Covered by a
  new unit test.
