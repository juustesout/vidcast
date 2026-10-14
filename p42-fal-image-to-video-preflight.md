# P42 - FAL.ai Image-to-Video Preflight

Status: **PREFLIGHT / INSPECTION ONLY.** No production code was changed, nothing
was committed or pushed, no FAL request was made, no paid generation occurred, and
no credential value was read, printed or modified. The only network action was
fetching public FAL documentation (no auth, no key).

Goal: prepare the first controlled image-to-video pilot for
`minimax/h3-max-turbo/image-to-video` by verifying the official endpoint contract,
selecting an existing local image, and auditing the implemented code path and its
test coverage - then give an explicit go/no-go for one live submit under a $1 cap.

Convention: **[official]** = quoted/derived from a FAL source fetched this session;
**[code]** = verified by reading this repository; **[test]** = proven by an existing
automated test; **[assumption]** = not yet confirmed by a live call or second source.

---

## 1. Repository status and reports consulted

- Branch `main`; `HEAD = b9d7a8043729ade1d3d4266f52aabd0aee35bfed`
  (`feat(video): add FAL.ai image-to-video support`) **equal to `origin/main`**
  (both `b9d7a80`), verified with `git rev-parse` this session.
- Working tree clean except the intentionally untracked recon docs (`p29`, `p29.2`,
  `p31`, `p33`, `p35`, `p37`, `p38`, `p40`). No tracked file modified. No
  `.gitmodules` (no submodules). Gitignored `projects/` left untouched.
- Reports read: `p41-fal-image-to-video-implementation.md`,
  `p40-fal-image-to-video-recon.md`, `p38-fal-real-provider-smoke-test.md`,
  `p39-fal-queue-url-fix.md`.
- Credentials / real-mode config (existence only; values never read or printed):
  `FAL_KEY` is defined in `/workspace/.env`; `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS`
  is defined in `/workspace/.env`; `FAL_KEY` is **not** exported in the current
  shell. No environment file was changed.

---

## 2. Official endpoint contract (verified 2026-10-13)

Sources fetched this session (public, no auth): the queue OpenAPI schema
(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max-turbo/image-to-video`),
the model API docs (`https://fal.ai/models/minimax/h3-max-turbo/image-to-video/api`)
and the LLM page (`.../llms.txt`). Server `https://queue.fal.run`; auth header
`Authorization`.

### 2.1 Input schema `H3MaxTurboImageToVideoInput` **[official]**

Required: `prompt` (1..50000 chars) and `prompt_expansion_mode`
(`disabled | balanced | quality`, default `balanced`).

Optional:
- `image_url` (string | null): *"Optional URL of the image to use as the first
  frame. When provided, the output canvas follows this image. If only
  `end_image_url` is provided, the canvas follows that last frame instead. If both
  images are omitted, the request is handled as text-to-video (16:9 by default)."*
- `end_image_url` (string | null): *"Optional URL of the image to use as the last
  frame. It may be provided alone for end-only keyframe generation; in that case the
  output canvas follows this image."*
- `duration` (number, `0.92..15`, default `5`; output can run ~0.7 s longer).
- `resolution` (`480P | 768P | 1080P`, default `768P`).
- `seed` (integer | null), `enable_safety_checker` (default `true`),
  `sync_mode` (default `false`): *"Return the generated video as base64 instead of a
  CDN URL."*
- `target_audio_url` (string | null): *"...at least 2 seconds long (maximum 15 MB)...
  Accepts an HTTP(S) URL or a base64 data URI."*

Output **[official]**: `{ video: File, expanded_prompt?, timings? }`,
`File = { url, content_type?, file_name?, file_size? }` - the shape the adapter
already parses **[code]**.

### 2.2 Input dimensions, file size and format

- **Maximum / minimum input pixel dimensions: NOT PUBLISHED** -> **unknown**.
- **Maximum input file size: NOT PUBLISHED** -> **unknown**. (The Files section only
  warns that large base64 inputs *"can impact the request performance."*)
- **Supported image formats (MIME list): NOT PUBLISHED** -> **unknown**. The docs
  describe the field only as "image"; no explicit `image/png`/`image/jpeg` list. The
  adapter independently requires MIME `image/*` **[code]**.
- `target_audio_url` publishes a 15 MB cap; the image fields publish none.

### 2.3 Aspect-ratio behaviour

**[official]** There is **no `aspect_ratio` field** on this endpoint. The output
canvas **follows the supplied frame**: the start frame if given, else the end frame,
else the text-to-video default (16:9). Consequence: a frame that is not one of the
app's modelled ratios (16:9 / 1:1 / 9:16) yields a differently-shaped output. (P38
independently observed the t2v model returning 1344x768 for a requested 16:9, so
"aspect follows" is approximate, not guaranteed to the pixel **[official + P38]**.)

### 2.4 `image_url`, `end_image_url`, `sync_mode` contract

- Both image fields are independent and optional; **both may be present together**,
  and each alone is valid (start-only, end-only) **[official]**.
- `sync_mode` **must stay `false`**: `true` returns inline base64 instead of a CDN
  URL, which would break the adapter's `download()` (it reads `video.url`) **[code]**.
- **Base64 data URI acceptance:** the model API page has a Files section stating
  *"Some attributes in the API accept file URLs as input. Whenever that's the case
  you can pass your own URL or a Base64 data URI"* and *"You can pass a Base64 data
  URI as a file input."* This applies to file attributes (which `image_url` /
  `end_image_url` are, per the examples), but the field descriptions themselves do
  **not** repeat the clause (unlike `target_audio_url`). => **[official at section
  level; field-level acceptance to confirm on the first live call]**.

### 2.5 Duration and other parameters

- `duration` `0.92..15` s, default `5`; app sends whole seconds `1..15` **[official + code]**.
- `resolution` default `768P`; only sent when `FAL_VIDEO_RESOLUTION` is set **[code]**.
- `seed` is never sent (model picks random) **[code]**.
- `enable_safety_checker` only sent when configured; otherwise model default `true` **[code]**.
- `prompt_expansion_mode` always sent; app default `disabled` **[code]**.

### 2.6 Queue contract

Submit `POST {base}/{endpoint}` -> `{ request_id, status?, response_url, status_url,
cancel_url, logs?, metrics?, queue_position? }`; status `GET
{base}/{queuePath}/requests/{id}/status?logs=1` -> `{ status, ... }` with status enum
`IN_QUEUE | IN_PROGRESS | COMPLETED`; result `GET {base}/{queuePath}/requests/{id}`
-> model output; cancel `PUT {base}/{queuePath}/requests/{id}/cancel` ->
`{ success }` **[official]**. The OpenAPI `paths` are declared **with** the
`image-to-video` sub-path, but P38 proved the real queue path for this app drops the
sub-path (`minimax/h3-max-turbo`), so the path must be learned from the returned
URLs, never assumed **[official schema + P38 evidence]**.

### 2.7 Pricing

**[official, from the LLM page]**: `$0.015/s` at 480p, `$0.024/s` at 768p,
`$0.048/s` at 1080p - promotional, 40% off "until October 15"; afterwards
`$0.025/s` / `$0.04/s` / `$0.08/s`. At the model default 768P a 5 s clip is
**~$0.12 now / ~$0.20 after the promo**, well under the $1 cap. (P38's `$0.025/s`
corresponded to the post-promo 480p rate.)

---

## 3. Concrete start image

Candidates found on disk (raster only; no `public/` dir exists):

| Path (relative to `/workspace`) | Format | Bytes | Pixels | Ratio | Status |
| --- | --- | --- | --- | --- | --- |
| `projects/project_afca8256-f75c-4f75-9779-26ae34f7b209/assets/scene-01-generated-generation_attempt_a5624e8a-b149-4e14-8ead-93134bb5e8c8.png` | PNG rgb24 | 2693455 | 1536x1024 | 1.5 (3:2) | gitignored, decodes OK |
| `projects/project_5ec5b7c3-9281-4e0a-b59f-533dfa29766a/assets/scene-01-generated-generation_attempt_01ec6b2a-a52c-4e08-9aa3-de4b1aa8c627.png` | PNG rgb24 | 3788 | 1280x720 | 1.7778 (16:9) | gitignored, decodes OK, **solid-colour placeholder** |
| `tmp-fake.png` | PNG (ya8) | 68 | 1x1 | 1.0 | tracked, **corrupt** (`inflate error -3`) |

All project `references/` files are **vector SVG** (`image/svg+xml`,
`projects/project_5f4a201a-.../references/*.svg`); there are **no raster
references** anywhere on the filesystem (verified by a scoped `find`).

**Chosen image for the pilot:**
`projects/project_afca8256-f75c-4f75-9779-26ae34f7b209/assets/scene-01-generated-generation_attempt_a5624e8a-b149-4e14-8ead-93134bb5e8c8.png`
- PNG, 2693455 bytes, 1536x1024, pixel format rgb24, aspect ratio 3:2 (1.5).
- Content: a real, content-rich generated educational illustration (skin-anatomy /
  injection diagram) - representative of an actual scene still, and safe
  (non-sensitive, non-personal, already generated by the app's image pipeline).
- SHA-256 `d508d002b598de3cee221e47046a9ff6d5d11c82128fc9af55a9c2905b478142`.
- Git status: ignored via `.gitignore:5` (`/projects/`). `ffmpeg -f null` decodes it
  cleanly (`DECODE_OK`).

Rejected: `tmp-fake.png` (corrupt / 1x1), the 1280x720 PNG (decodes but is a
solid-colour placeholder, not representative), and the SVG references (vector, not
raster -> **[assumption]** would be rejected by the model; MIME `image/svg+xml` would
pass the adapter's `image/*` check, so this is a real foot-gun).

**Blocker B1 - no raster *reference* image exists.** The 1536x1024 PNG is a real
raster image, but it lives under `assets/`, and the implemented Option A path
(section 4) resolves start/end frames **only** from `project.references`
(`references/`). The only references on disk are SVGs. So a faithful app-flow i2v
pilot currently has **no suitable raster reference** to drive it, without either a
project-data setup step or code change (see section 7).

---

## 4. Implementation path (code audit, no provider request issued)

### 4.1 `startFrameReferenceId` -> project file

**[code]** `lib/generation/video-generation-service.ts`:
- `submitSceneVideoGeneration` resolves `referenceIds` from
  `current.referenceIds` (falling back to `scene.referenceIds`) at `:320`, then
  `assertFrameReferences(referenceIds, current)` (`:321`), then
  `resolveReferenceInputs(project, referenceIds, media, current)` (`:322`).
- `assertFrameReferences` (`:182-207`) rejects a start/end frame that is not in the
  effective `referenceIds` (`generation.reference.startFrameInvalid` /
  `...endFrameInvalid`) and rejects identical start/end (`...frameConflict`).
- `resolveReferenceInputs` (`:209-246`) reads each id via `getReferenceById`
  (`:162-171`, **`project.references` only**) and `media.readRelativeFile`, assigning
  the role: designated start -> `start_frame`, designated end -> `end_frame`, all
  others `reference` (`:229-234`).
- The designations travel on the video generation record
  (`GenerationSpec.startFrameReferenceId` / `endFrameReferenceId`,
  `lib/types/generation.ts`), pass through `lib/projects/normalize-project.ts:169-170`,
  and are validated to resolve to a reference at
  `lib/validation/project-validation.ts:232-239` (`...frameReference.missing`).
- The manual route `app/api/projects/[id]/scenes/[sceneId]/generate-video/route.ts:24`
  accepts only `{ regenerate }` - a caller cannot inject a frame or model; the
  provider is resolved by server policy.

### 4.2 Image -> data URI

**[code]** `lib/ai/video-generation/fal-provider.ts:194-203` `toImageDataUri`:
lower-cases the MIME, requires `image/*` and non-empty bytes, and returns
`data:{mimeType};base64,{...}`. It is never logged; error messages name only the
label/MIME, never bytes (`:196-200`).

### 4.3 i2v endpoint selection and `sync_mode: false`

**[code]** `:149-152` `isImageToVideoEndpoint` matches when the **last** path segment
is `image-to-video`. `submit` (`:425-528`) resolves the endpoint from
`request.model` or the configured `FAL_VIDEO_ENDPOINT` (`:433`); on the i2v branch
(`:442-453`) it sets `sync_mode: false`, maps `start_frame -> image_url` and
`end_frame -> end_image_url`, and **omits `aspect_ratio`**. The t2v branch is
unchanged and still rejects references (`:454-461`). `resolveFrameReferences`
(`:157-189`) rejects multiple/duplicate frames and plain `reference` roles.

### 4.4 Queue-URL handling (P39) reused unchanged

**[code]** `resolveQueuePath` (`:212-254`) reads `response_url`/`status_url`/
`cancel_url` from the submit response, trusts only absolute URLs whose protocol+host
match the configured base and that contain this request's `/requests/{id}` marker,
and falls back to the submitted endpoint (`:515-517`). `getStatus` (`:530`),
`download` (`:579`) and `cancel` (`:651`) all rebuild
`{base}/{queuePath}/requests/{id}[/status|cancel]` from
`decodeFalJobId(providerJobId, this.endpoint)` (`:267-290`). The media fetch is
deliberately unauthenticated (`:619-620`); the key is only ever sent to the
configured host.

### 4.5 Queue identity across poll / resume / download / cancel

**[code]** Identity is the composite job id `fal:{queuePath}:{request_id}`
(`:263-265`). It travels in persisted project state, so a **fresh provider** built by
the registry per call (and after a restart) reconstructs the same queue path. All
four operations share that id. **[test]** `tests/fal-video-provider.test.ts:403`
(cancel via queue path) and `tests/fal-video-service.test.ts:338` (i2v submit ->
poll with a fresh provider -> download, shortened path).

### 4.6 Same storage / FFmpeg validation as text-to-video

**[code]** `refreshVideoGenerationAttempt` calls `provider.download(...)` then
`media.saveGeneratedVideo(...)` (`lib/generation/video-generation-service.ts:562-580`)
with no i2v-specific branch; `media-store` derives the extension, probes with FFprobe
and returns an `Asset`. **[test]** the storage integration covers the i2v endpoint
(`tests/fal-video-storage.integration.test.ts`, second test).

---

## 5. Tests and safety controls

Coverage that already answers the preflight questions:

- **Missing/invalid frame rejected before any network call** - service:
  `video-generation-service.ts:321` runs before `resolveReferenceInputs`/submit;
  **[test]** `tests/video-generation-service.test.ts` (invalid start frame,
  `frameConflict`, assert `submitRequests` length 0). Adapter: `resolveFrameReferences`
  runs before fetch; **[test]** `tests/fal-video-provider.test.ts:507,515,525` assert
  `calls.length === 0`.
- **Mock mode performs no FAL network call** - **[test]**
  `tests/fal-video-service.test.ts:266` (getProvider not called, no submit) plus the
  `run-policy` FAL block (mock mode rejects the fal provider).
- **Data URIs and API key never in logs / errors / run status** - the record stores
  only `referenceIds` (ids), never bytes; no `lib/app` code logs a data URI (audited);
  errors name only MIME/label. **[test]** `tests/fal-video-provider.test.ts:552`
  (frame bytes + base64 + key absent from the error message);
  `tests/run-registry.test.ts:103` (redacts `Authorization: Key ...`).
- **i2v endpoint still gated by policy/credentials** - **[test]**
  `tests/run-policy.test.ts` (i2v scene model still requires `FAL_KEY`; no per-scene
  model bypass); `tests/video-provider-registry.test.ts` (capabilities reflect the
  configured endpoint).

Coverage gaps (no code change was needed to establish these - reported only):
- No unit test asserts the **provider-level** i2v queue path when the response
  **returns** URLs (the service test at `fal-video-service.test.ts:338` covers the
  shortened path end-to-end, so this is not a real gap).
- Planner/recovery are exercised for `generated_video` generally, not i2v
  specifically; the code path is identical (P41 changed neither), so no separate test.
- Live-only unknowns (section 6) cannot be covered by mocks.

---

## 6. What is proven, what remains unknown

Proven (code + tests, no live call):
- The i2v branch builds the correct payload (`image_url`/`end_image_url` data URIs,
  `sync_mode:false`, no `aspect_ratio`), selects the endpoint from the model/env,
  rejects missing/plain/duplicate frames pre-network, and never leaks bytes or the
  key. Submit/poll/resume/download/cancel share one queue identity; storage and
  FFmpeg validation are identical to text-to-video.

Unknown / to confirm on the first live call **[assumption]**:
1. Whether `image_url` **accepts a base64 data URI** (documented at section level, not
   per field).
2. Accepted image **MIME list**, **byte cap**, and **min/max pixel dimensions**.
3. The i2v **queue path** (expected `minimax/h3-max-turbo`, same app as t2v).
4. Start/end frame **fidelity** (exact first/last pixels vs. approximate).
5. **Aspect behaviour** vs. the project ratio (the chosen 3:2 frame will very likely
   yield a 3:2-ish output, not 16:9).

Blockers:
- **B1 (blocking an app-flow pilot):** no raster image exists under `references/`; the
  implemented Option A path consumes references only, and the only references are SVG.
  The only real raster images are gitignored `assets/` PNGs.
- **B2 (mild):** no published image input limits/format (section 2.2).
- **B3 (mild):** i2v has no `aspect_ratio`; the chosen frame is 3:2, so the output
  will not match the project's 16:9.

---

## 7. Go / No-Go for one live pilot (max 1 submit, <= $1)

**No-Go** for an immediate, unattended app-flow pilot today: the implemented
`startFrameReferenceId` path has **no suitable raster reference** (B1). Running it
as-is would send an SVG (or nothing) - the wrong test.

**Conditional Go** for exactly one live submit once one of these is explicitly
authorized (both keep the $1 cap, 1 submit, no retry):

- **Option 1 (preferred, exercises the implemented path).** One-time, additive setup:
  register the chosen existing 1536x1024 PNG as a `ReferenceImage` in a dedicated
  pilot project (reuses an existing image; modifies no existing asset; writes only
  inside the gitignored `projects/`), set the scene's `model` to
  `minimax/h3-max-turbo/image-to-video` and its `startFrameReferenceId` to that
  reference, then run `submitSceneVideoGeneration(..., { provider: 'fal', mode: 'real' })`.
  This requires a small project-data step outside P42's inspection-only scope.
- **Option 2 (no project mutation, less coverage).** At the service/adapter boundary,
  inject the PNG bytes as a `start_frame` and call `submit` once. Validates the live
  i2v contract, data-URI acceptance and queue path, but **not** the reference
  resolution or storage handoff.

Pilot guardrails (must hold):
- Exactly **1 submit**, hard **$1** cap (5 s at 768P ~= $0.12 now / ~$0.20 after the
  promo), **no automatic retry**; reuse the P38 single-submit idempotency lock; on
  timeout **cancel** rather than resubmit; keep the real-mode recovery suppression.
- `sync_mode` stays `false`; keep `prompt_expansion_mode: disabled`; no `aspect_ratio`.
- Key only ever sent to `queue.fal.run`; key/value never printed; the base64 frame and
  any download URL are never logged.
- Download the result promptly (FAL media URLs expire) and validate with the local
  FFmpeg/FFprobe path.

---

## 8. Commands and checks actually run this session

- `git rev-parse --abbrev-ref HEAD`, `git rev-parse HEAD`, `git rev-parse origin/main`,
  `git status --short`, `test -f .gitmodules` - confirmed `main` @ `b9d7a80` ==
  `origin/main`, only untracked recon docs, no submodules.
- `webfetch` of the public i2v **OpenAPI schema**, the model **API docs** and the
  **llms.txt** (sections 2.6/2.7). No auth, no key.
- `find` for raster images (workspace + `references/` on the filesystem); `git ls-files`,
  `git check-ignore`, `sha256sum`, `stat`.
- `node` IHDR parse + `ffprobe`/`ffmpeg -f null` to measure/decrypt the PNG candidates
  (one candidate confirmed corrupt).
- `rg`/static source reading of `fal-provider.ts`, `video-generation-service.ts`,
  `provider.ts`, `normalize-project.ts`, `project-validation.ts`, `registry.ts`,
  `run-policy.ts`, `media-store.ts`, the `generate-video` route, and the i2v
  adapter/service/storage/policy/registry tests.
- Existence-only credential check (`grep -q '^FAL_KEY=' .env`, shell `test -n`);
  **no value was read or printed**.
- **Not run:** `tsc`, `lint`, `build`, `vitest` - P42 changes nothing, so there was
  nothing to verify; the P41 baseline (81 files / 574 tests) stands. **No FAL request
  was made.**

---

## 9. Confirmation

No production code was changed; nothing was committed or pushed; no FAL request was
made and no FAL credit was spent; no API key was read, printed, logged or modified;
no environment/production file was changed. Existing untracked recon docs and the
gitignored `projects/` contents were left untouched.
