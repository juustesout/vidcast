# P37 - First controlled FAL.ai video pilot: preparation report

Status: research only. No production code was changed, no commit/push was made, no
FAL.ai request was sent, and no credential value was read.

This document prepares the first paid FAL.ai pilot and answers the open
image-to-video (start/end frame) questions. It stops short of executing anything;
the paid pilot requires explicit approval (see the last section).

---

## 1. Scope and method

Goal: prepare the smallest safe first paid call against the FAL queue, and report
whether image-to-video start/end-frame support is a small follow-up or a larger
technical trial.

Method:
- Verified repository state and the previously committed adapter.
- Re-verified current official FAL schemas and pricing on `fal.ai` (text-to-video
  and image-to-video) rather than trusting the P35/P36 notes.
- Traced the submit/poll/download/cancel path in the adapter and the service.
- No request was issued; the proposal below is designed to be executed only after
  approval.

Convention used below: **[official]** = quoted from a FAL source URL;
**[conclusion]** = our inference from reading this codebase;
**[assumption]** = not yet confirmed by a live call or a second source.

---

## 2. Verified repository state

- Branch `main`, HEAD `4576ca0` (`feat(video): add FAL.ai video generation provider`),
  equal to `origin/main`. Working tree clean except the intentionally untracked
  recon docs (`p29`, `p29.2`, `p31`, `p33`, `p35`).
- Test baseline at HEAD: `81` files / `546` tests passing
  (`npx vitest run`), plus `npx tsc --noEmit`, `npm run lint`, `npm run build`.
- The FAL adapter is already implemented, unit tested, and wired into the
  registry and run policy (P36). The first pilot therefore needs **no code
  change** - it is an operational exercise.

---

## 3. What the current adapter does and does not do

Source: `lib/ai/video-generation/fal-provider.ts` (528 lines).

Already implemented **[conclusion]**:
- `providerId = 'fal'`; capabilities `{ supportsTextToVideo: true,
  supportsImageToVideo: false, supportsReferences: false,
  supportedAspectRatios: ['16:9','1:1','9:16'], supportsCancellation: true }`
  (`fal-provider.ts:279-287`).
- `submit` (`:289-368`): requires a prompt; **rejects any reference with
  `REFERENCE_ERROR`** (`:299-305`); resolves endpoint from `request.model` or
  `FAL_VIDEO_ENDPOINT`; validates aspect to the app's 3 values and duration to an
  integer `1..15`; builds `{ prompt, prompt_expansion_mode, [aspect_ratio],
  [duration], [resolution], [enable_safety_checker] }`; `POST {base}/{endpoint}`
  with `Authorization: Key ${apiKey}`; returns a durable composite job id.
- Durable job id `encodeFalJobId(endpoint, requestId)` = `fal:{endpoint}:{request_id}`
  (`:133-135`), decoded in `getStatus`/`download`/`cancel` via
  `decodeFalJobId` (`:137-159`) so a restart can poll the correct endpoint.
- `getStatus` (`:370-417`): `GET {base}/{endpoint}/requests/{id}/status?logs=1`;
  maps `IN_QUEUE->queued`, `IN_PROGRESS->generating`, `COMPLETED->generated`
  (downgraded to `failed` when the payload carries `error`/`error_type`);
  **any unknown status is treated as still-processing (`generating`)**,
  `fal-provider.ts:174-178`.
- `download` (`:419-489`): `GET .../requests/{id}`, reads `video.url`, then fetches
  the media URL **without the `Authorization` header** (`:459-460`), and derives
  MIME from the HTTP header, then the declared `content_type`, else `video/mp4`.
- `cancel` (`:491-517`): `PUT .../requests/{id}/cancel`.
- Timeout: per-request `AbortController` (`createRequestSignal`, `:241-251`) with
  `FAL_VIDEO_TIMEOUT_MS` default `120000`, mapped to `502/504 PROVIDER_FAILED`
  (`:231-237`). The adapter never retries or resubmits on timeout.
- Key handling: `apiKey = options.apiKey || process.env.FAL_KEY` (`:266`); the key
  is only ever attached to requests against `baseUrl` (default
  `https://queue.fal.run`). It is never sent to the media host and never logged.
  `assertConfigured` (`:519-527`) fails closed with `409 NOT_CONFIGURED`.

Not implemented (relevant to P37's image-to-video question) **[conclusion]**:
- No image-to-video endpoint branch; the adapter always emits text-to-video
  payloads and would send an invalid `aspect_ratio` field to an i2v endpoint.
- No `end_frame` reference role; `VideoReferenceInput.role` only models
  `'reference' | 'start_frame'` (`lib/ai/video-generation/provider.ts:9`), and the
  service never even sets `'start_frame'` (`video-generation-service.ts:186-192`
  hardcodes `role: 'reference'`).
- The service does not gate on `getCapabilities()` before submit; it always
  builds references and passes them. FAL reference rejection currently relies on
  the adapter throwing (`fal-provider.ts:299`).

### 3.1 Submit/poll/download behavior worth calling out for the pilot

- The service writes a `queued` attempt before the network call
  (`video-generation-service.ts:294-307`), so a process death right after submit
  still leaves a resumable record.
- `refreshVideoGenerationAttempt` polls a single attempt and, on a provider
  failure, persists `status: 'failed'` before rethrowing (`:457-491`). There is no
  automatic resubmit loop in the service.
- Restart safety: `reconcileInterruptedGenerations`
  (`lib/production/run-recovery.ts:43-99`) leaves an active video attempt that has
  a `providerJobId` for the poll path, and in real mode **suppresses** a
  `video_submit` that cannot be resumed - explicitly to avoid silently
  re-billing (`:41-42`, `:94-96`).

---

## 4. Official endpoint facts (re-verified)

Sources:
- Text-to-video schema: `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max-turbo/text-to-video`
- Image-to-video schema: `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max-turbo/image-to-video`
- Image-to-video API docs (Files section): `https://fal.ai/models/minimax/h3-max-turbo/image-to-video/api`
- Pricing: `https://fal.ai/pricing`

Transport (identical for both endpoints) **[official]**:
- Security: `apiKeyAuth`, header `Authorization` = the FAL key.
- Server base: `https://queue.fal.run`.
- `POST /{endpoint}` -> queue status; `GET /{endpoint}/requests/{request_id}/status?logs=1`;
  `GET /{endpoint}/requests/{request_id}` -> result; `PUT /{endpoint}/requests/{request_id}/cancel`.
- `QueueStatus.status` enum: `IN_QUEUE | IN_PROGRESS | COMPLETED`; also
  `request_id`, `response_url`, `status_url`, `cancel_url`, `logs`, `metrics`,
  `queue_position`.

### 4.1 Text-to-video (`minimax/h3-max-turbo/text-to-video`)

Input **[official]**:
- `prompt` (required, 1..50000 chars).
- `prompt_expansion_mode` (required; `disabled | balanced | quality`; default `balanced`).
- `duration` (float; min `0.92`, max `15`, default `5`; "can run up to about 0.7 s longer than requested").
- `resolution` (`480P | 768P | 1080P`, default `768P`).
- `aspect_ratio` (`21:9 | 16:9 | 4:3 | 1:1 | 3:4 | 9:16`, default `16:9`).
- `seed`, `enable_safety_checker` (default `true`), `sync_mode`, `target_audio_url`.

Output **[official]**: `{ video: File, expanded_prompt?, timings? }`, where
`File = { url (required), content_type?, file_name?, file_size? }`; the example
result shows `content_type: "video/mp4"`.

Note: the shared `File` schema's `content_type` **example** is `image/png`, which is
almost certainly a doc-template artifact for a video model
**[assumption]**. The adapter prefers the real HTTP `content-type` header, so this
is low risk.

### 4.2 Image-to-video (`minimax/h3-max-turbo/image-to-video`)

Input **[official]**: identical fields to 4.1 **except there is no `aspect_ratio`**,
and there are two extra optional fields:
- `image_url` (string, nullable): "Optional URL of the image to use as the first
  frame. When provided, the output canvas follows this image. If only
  `end_image_url` is provided, the canvas follows that last frame instead. If both
  images are omitted, the request is handled as text-to-video (16:9 by default)."
- `end_image_url` (string, nullable): "Optional URL of the image to use as the
  last frame. It may be provided alone for end-only keyframe generation; in that
  case the output canvas follows this image."

Output: same `{ video, expanded_prompt?, timings? }` shape **[official]**.
`prompt` and `prompt_expansion_mode` remain required.

### 4.3 File inputs / hosting **[official]**

From the model API "Files" section: "Some attributes in the API accept file URLs
as input. Whenever that's the case you can pass your own URL or a Base64 data
URI." Documented options:
- Data URI (base64) - inline, no hosting; docs warn large files can impact
  request performance.
- Hosted URL - must be publicly accessible.
- Upload: `await fal.storage.upload(file)` (JS client) returns a reusable URL;
  the client auto-uploads binary objects.

### 4.4 Pricing **[official]**

From `fal.ai/pricing` (Video models table):
- `minimax/h3-max-turbo/text-to-video` - **$0.025 / second** (40 s per $1).
- `minimax/h3-max-turbo/image-to-video` - **$0.025 / second**.
- For contrast: `minimax/h3-max/*` (non-turbo) and `.../reference-to-video` are
  $0.05/s; Kling v3 pro variants are $0.14/s.

So a 5 s turbo clip is approximately **$0.125** at the listed unit. The page also
states "Settings such as resolution, duration, and quality may affect the final
cost" **[official]**, so resolution is not guaranteed to be free
**[assumption]** - the pilot measures actual spend rather than assuming.

---

## 5. Proposed first pilot (text-to-video)

Executable plan, not yet executed. Rationale: text-to-video needs no image
hosting/plumbing, the schema and price are confirmed, and it exercises the full
real path (queue -> poll -> download -> asset storage) that image-to-video will
later reuse.

### 5.1 Exact configuration

- Environment (server-side only; key is short-lived with a small spend cap):
  - `FAL_KEY=<short-lived, spend-capped key>` (existence only; value never read/logged)
  - `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true`
  - `FAL_VIDEO_ENDPOINT=minimax/h3-max-turbo/text-to-video`
  - `FAL_VIDEO_BASE_URL=https://queue.fal.run`
  - `FAL_VIDEO_TIMEOUT_MS=120000`
  - `FAL_VIDEO_PROMPT_EXPANSION_MODE=disabled`
  - `FAL_VIDEO_RESOLUTION=768P`
- Run selection: `mode = 'real'`, `providers.video = 'fal'`.
- Scene: one short scene, `durationSeconds = 5`, `aspectRatio = '16:9'`, a
  neutral/safe prompt (no real people, brands, or copyrighted characters),
  no reference images.

### 5.2 Pre-flight (no paid request)

1. Confirm HEAD is `4576ca0` and the tree is clean.
2. Confirm `getVideoGenerationConfigurationStatus()` reports `falConfigured: true`
   (existence of `FAL_KEY` only).
3. Confirm the run-policy preflight passes for `real` + `video: fal` and that it
   requires `FAL_KEY` (`lib/production/run-policy.ts:369-370`, `:520-522`).
4. Confirm exactly one scene is queued for video, so only one submit can occur.

### 5.3 Procedure

1. Start the run with the config above (production run start route selects the
   locked policy; or a single manual scene call through
   `submitSceneVideoGeneration(..., { provider: 'fal', mode: 'real' })`,
   `lib/generation/video-generation-service.ts:229`).
2. Submit exactly one job. Expect `providerJobId` of the form
   `fal:minimax/h3-max-turbo/text-to-video:{request_id}`.
3. Poll to a terminal state. Expected transitions: `queued`/`generating` ->
   `generated` (or `failed` with a provider error). Unknown statuses remain
   `generating`, bounded by the poll loop and the 120 s per-request timeout.
4. On `generated`: the service downloads (no key sent to the media host) and
   stores the asset via `mediaStore.saveGeneratedVideo`
   (`lib/storage/media-store.ts:312-351`); then probe the file.
5. Record: request id, endpoint, observed duration/resolution, wall-clock time,
   downloaded MIME, and the FAL dashboard spend delta.

### 5.4 Acceptance criteria

- Exactly one `POST` reaches `queue.fal.run`; no request is sent to any other host
  with the key.
- Job id round-trips across a status/download call (durable endpoint prefix).
- Terminal job yields a non-empty `video/*` payload and a persisted `Asset`
  (`kind: video`, `status: available`) carrying `providerJobId`/`providerRequestId`.
- No key material appears in logs, error messages, or persisted state.
- Actual spend is within the stated cap.
- A simulated restart during `generating` resumes by polling the same job and does
  **not** create a second submit.

### 5.5 Request and cost limits

- Hard cap: **1 submit** for the smoke. Only after a clean success may the pilot
  be widened to a maximum of **3 total submits**.
- Cost cap: **<= $1.00** total. Expected: 1 clip ~= $0.125; 3 clips ~= $0.375.
- Abort rule: if the submit times out or the process dies after submit, do **not**
  resubmit. Leave the active attempt with its `providerJobId` to be polled, or
  cancel it; the recovery path already suppresses an unresumable real-mode
  `video_submit` (`run-recovery.ts:41-42`, `:94-96`).
- Kill switch: remove/rotate `FAL_KEY` (or set the spend cap to the minimum) to
  stop all further FAL calls.

---

## 6. Image-to-video start/end frame research

The question: can a scene supply a start frame **and** an end frame to
`minimax/h3-max-turbo/image-to-video`, and what does integrating that require?

Findings:
- **Both frames are allowed simultaneously.** The schema exposes `image_url` and
  `end_image_url` as independent optional strings, and the `image_url` description
  explicitly reasons about "if only `end_image_url` is provided" and "if both
  images are omitted", which implies both may be present **[official]**.
  **[conclusion]** start+end keyframe interpolation is supported by this endpoint.
- **Accepted formats.** The schema only says "URL of the image"; the Files section
  states image inputs accept an HTTP(S) URL or a base64 data URI **[official]**.
  No explicit MIME list, byte limit, or min/max pixel size is documented on the
  schema page **[assumption - unconfirmed]**. MiniMax H3 is generally a
  ~768P-class model, but we should validate with the first i2v call.
- **Resolution/aspect.** There is no `aspect_ratio` field on the i2v endpoint;
  the description says the "output canvas follows this image" **[official]**, so
  the start (or end) image governs aspect/canvas size. `resolution` (480P/768P/1080P)
  still applies. **[conclusion]** the app should pass the scene's reference image
  dimensions rather than `aspectRatio` for i2v.
- **Exact frame vs. guide.** The wording is "use as the first frame" / "use as the
  last frame" and "the output canvas follows this image" **[official]**, which is
  keyframe semantics (the frame anchors the clip). Whether the first/last pixels
  are reproduced **exactly** is not guaranteed by the docs
  **[assumption - unconfirmed]**; plan for "strong keyframe control, exactness
  needs visual verification."

### 6.1 Separate adapter vs. same provider?

**[conclusion]** Keep it in the existing `FalVideoGenerationProvider`; do not add a
second provider class. The queue transport, auth, job-id scheme, polling, timeout,
and download are identical. Only the endpoint id, the presence of the frame
fields, and the absence of `aspect_ratio` differ - all of which can branch on the
selected endpoint inside `submit`.

### 6.2 Changes needed to support start/end frames

1. **Types** (`lib/ai/video-generation/provider.ts`):
   - Extend `VideoReferenceInput.role` to `'reference' | 'start_frame' | 'end_frame'`.
2. **Service** (`lib/generation/video-generation-service.ts`):
   - `resolveReferenceInputs` (`:173-196`) currently hardcodes `role: 'reference'`.
     It needs a way to mark which reference is the start vs. end frame. Cleanest
     options: (a) add explicit `startFrameReferenceId` / `endFrameReferenceId`
     fields to the scene generation model; or (b) treat `references[0]` as start
     and `references[1]` as end for i2v scenes. Option (a) is more explicit and
     matches the existing `referenceIds` pattern.
3. **Adapter** (`lib/ai/video-generation/fal-provider.ts`):
   - Set `supportsImageToVideo: true` when configured for the i2v endpoint.
   - Branch in `submit`: for i2v, map start -> `image_url`, end -> `end_image_url`
     (as a base64 data URI or an uploaded URL), and **omit `aspect_ratio`**.
   - Keep rejecting any leftover `role: 'reference'` images (or map them
     deliberately) so unsupported inputs are never silently dropped.
4. **Capabilities/preflight**: allow the i2v endpoint to be selected (per-scene
   model or a provider variant), without weakening the real-mode and `FAL_KEY`
   gates.
5. **Tests**: adapter payload tests for start-only, end-only, and start+end;
   service reference-role tests; a run-policy test that i2v still requires `FAL_KEY`.

### 6.3 Supplying local assets without exposing the key

Two viable approaches **[conclusion]**:
- **Preferred for a single frame: base64 data URI.** Embed
  `data:{mimeType};base64,{...}` directly in the `image_url`/`end_image_url` body
  field. The only authenticated call remains `POST` to `queue.fal.run`; no second
  host, no key exposure. Bounded by request size; reference images are small.
- **Alternative: FAL storage upload.** Returns a reusable public URL, better for
  larger/multiple assets, but it adds a second authenticated FAL call and we would
  need the REST upload endpoint (the documented helper is JS-only and this repo
  uses raw `fetch`). This is an open implementation item, not required for the
  first i2v pilot.

Either way the `FAL_KEY` is only ever sent to `queue.fal.run` (and, if used, the
FAL storage host), never to the media host or any third party.

---

## 7. Cost summary

| Pilot step | Endpoint | Duration | Unit price | Est. cost |
| --- | --- | --- | --- | --- |
| Phase A smoke (1 clip) | `.../h3-max-turbo/text-to-video` | 5 s | $0.025/s | ~$0.125 |
| Phase A widened (max 3 clips) | same | 5 s each | $0.025/s | <= ~$0.375 |
| Phase B i2v pilot (start+end, up to 3 clips) | `.../h3-max-turbo/image-to-video` | 5 s each | $0.025/s | <= ~$0.375 |

Proposed caps: Phase A <= $1 total and <= 1 submit initially (max 3 on a clean
success); Phase B <= $1 total. Both are well under the existing ~$50 reserve.

---

## 8. Uncertainties / unconfirmed items

1. Whether `resolution` or `duration` change the effective per-second price
   (page says settings "may affect" cost) - measure actual spend.
2. Per-field image limits for i2v (max bytes, accepted MIME, min/max dimensions) -
   not documented on the schema page.
3. Whether i2v reproduces start/end frames pixel-exactly vs. approximately.
4. The exact REST endpoint for FAL storage upload if we avoid data URIs.
5. Media URL expiry window - mitigated by downloading immediately on `generated`.
6. The `File.content_type` example mismatch (`image/png` for a video model) -
   mitigated by trusting the HTTP header first.

---

## 9. Recommendation

- **Text-to-video: ready now.** No code change is required. It is a small,
  low-risk, bounded operational pilot (~$0.125) that proves the whole real path.
- **Image-to-video start/end frames: a bounded follow-up, not part of this pilot.**
  The endpoint genuinely supports `image_url` + `end_image_url`, and the integration
  is contained in the existing provider. However it does require a real (if small)
  change set: reference-role plumbing in the service/types, an endpoint branch and
  `aspect_ratio` omission in the adapter, and tests. This should follow - not be
  bundled into - the first smoke so the queue/download/storage path is proven
  before adding start/end-frame semantics.
- Proposed order:
  - **Phase A (on approval):** one paid text-to-video smoke, then stop and review.
  - **Phase B (separate approval):** implement i2v start/end behind a role-aware
    reference model with mock/unit tests only, then one small paid i2v pilot.

---

## 10. Stop point

No code was written or committed; no FAL request was made; no key was read or
logged. Awaiting explicit approval before Phase A (which would spend real money).
Upon approval I will restate the exact config, caps, and the single-submit rule
before starting.
