# P40 - FAL.ai image-to-video integration recon

Status: **research only.** No production code was changed, nothing was committed or
pushed, no FAL request was made, no paid generation occurred, and no credential value
was read or printed. The only network action this session was fetching the public
official FAL OpenAPI schema (no auth, no key).

Goal: work out how to add FAL.ai **image-to-video** (start frame + optional end frame)
to the existing video pipeline, reusing the P36 text-to-video adapter and the P39
queue-path fix, so that a later, separately-approved phase can implement it with a
small, well-bounded change set.

Convention: **[official]** = quoted/derived from a FAL source fetched this session;
**[code]** = verified by reading this repository; **[assumption]** = not yet confirmed
by a live call or second source.

---

## 1. Verified repository state

- Branch `main`, `HEAD = 439b279708b84400f0506d83d971b0ffef5e0307`
  (`fix(video): resolve FAL queue path for multi-segment model ids`) **equal to
  `origin/main`** (both `439b279`), verified with `git rev-parse` this session.
- Working tree clean except the intentionally untracked recon docs
  (`p29`, `p29.2`, `p31`, `p33`, `p35`, `p37`, `p38`). No tracked file modified.
- Baseline from the P39 session: `81` test files / `552` tests passing, plus
  `npx tsc --noEmit`, `npm run lint`, `npm run build` clean. **Not re-run in P40**
  (research only, and P40 changes nothing).

---

## 2. Scope and method

1. Re-read the P36-P39 reports and confirmed the shipped state.
2. Mapped the actual generation/render/storage architecture from source (section 4),
   so the proposal is grounded in what exists rather than in intent.
3. Re-verified the **current** official `minimax/h3-max-turbo/image-to-video` schema
   live (section 5) rather than trusting P37's copy.
4. Derived the smallest safe change set (section 6), a test plan (section 7), and the
   genuinely open questions (section 9).

No request was issued; there is nothing to spend. A paid i2v pilot is gated behind a
separate, explicit approval (section 8).

---

## 3. What already exists (shipped in P36 + P39)

**[code]** The FAL text-to-video path is complete: `FalVideoGenerationProvider`
implements the same `VideoGenerationProvider` interface as the OpenAI and fake
providers, is registered under provider id `fal`, is selectable in real runs
(`providers.video = 'fal'`), and the P39 fix resolves the queue resource path from
the URLs FAL returns on submit. P38 proved the full real path once
(1 submit, `queued -> COMPLETED`, download without key, persisted `Asset`).

The single, well-understood gap is that the adapter is **text-to-video only**:
it advertises `supportsImageToVideo: false`, rejects any reference with
`REFERENCE_ERROR`, and always emits an `aspect_ratio` field - which the i2v endpoint
does not accept (section 5).

---

## 4. Architecture map (grounding for the design)

### 4.1 The provider contract

- `lib/ai/video-generation/provider.ts:4-10` -`VideoReferenceInput` already carries
  `role?: 'reference' | 'start_frame'` (**no `'end_frame'` yet**). A role field exists
  but the service never sets anything other than `'reference'`.
- `provider.ts:12-21` -`VideoGenerationRequest` has `references?`, `aspectRatio?`,
  `width?`, `height?`, `durationSeconds?`, `metadata?`.
- `provider.ts:23-31` -`VideoGenerationCapabilities` has `supportsImageToVideo` and
  `supportsReferences`. **`getCapabilities()` is only consumed by unit tests**
  (`grep` this session): no runtime code gates on it. So changing capabilities is
  low-risk but currently cosmetic.
- `provider.ts:54-61` -the interface: `submit` / `getStatus(providerJobId)` /
  `download(providerJobId)` / optional `cancel`.

### 4.2 The FAL adapter (P39 state)

`lib/ai/video-generation/fal-provider.ts`:

- `:33-35` defaults: endpoint `minimax/h3-max-turbo/text-to-video`, base
  `https://queue.fal.run`, `prompt_expansion_mode = disabled`.
- `:42` app-side aspect model is only `16:9 | 1:1 | 9:16`; `:44-47` duration accepted
  as integer `1..15`.
- `:148-190` `resolveQueuePath(requestId, candidates, baseUrl)`: derives the queue
  path from the response `response_url`/`status_url`/`cancel_url`, validated against
  the configured protocol+host, else falls back to the submitted endpoint.
- `:199-226` `encodeFalJobId(queuePath, requestId)` / `decodeFalJobId(jobId, fallback)`
  -> composite id `fal:{queuePath}:{request_id}`, legacy-compatible.
- `:346-354` capabilities: `{ supportsTextToVideo: true, supportsImageToVideo: false,
  supportsReferences: false, supportedAspectRatios: ['16:9','1:1','9:16'],
  supportsCancellation: true }`.
- `:356-444` `submit`: requires prompt; **rejects any reference**
  (`:366-372`, `REFERENCE_ERROR`); resolves endpoint from `request.model` or
  `FAL_VIDEO_ENDPOINT` (`:374`); builds payload with `aspect_ratio` when set
  (`:378-393`); `POST {base}/{endpoint}` (`:399`); derives/persists queue path
  (`:431-433`).
- `:446-493` `getStatus` / `:495-565` `download` / `:567-593` `cancel`: all rebuild
  `{base}/{queuePath}/requests/{id}[/status|cancel]` from the job id. The key is sent
  only to `baseUrl`; the media fetch is unauthenticated (`:535-536`).

### 4.3 The service layer

`lib/generation/video-generation-service.ts`:

- `:173-196` `resolveReferenceInputs` reads each `scene.referenceIds` entry from
  `project.references` (a `ReferenceImage` with `filePath`), via
  `media.readRelativeFile`, and **hardcodes `role: 'reference'` at `:191`**.
- `:229-389` `submitSceneVideoGeneration`: writes a `queued` attempt
  (`:275-307`), then `provider.submit(...)` with `references`,
  `aspectRatio: current.aspectRatio || project.aspectRatio`, and a **rounded**
  `durationSeconds` (`:309-322`). Filename/reference resolution happens at
  `:270-271` (`current.referenceIds` fall back to `scene.referenceIds`).
- `:391-615` `refreshVideoGenerationAttempt`: polls, downloads on `generated`,
  persists via `mediaStore.saveGeneratedVideo` (`:511-548`), handles failures.

### 4.4 References today

- `lib/types/reference.ts` -`ReferenceImage` is a project-scoped upload
  (`filePath` under `references/`, `metadata.mimeType`).
- `lib/types/scene.ts:187` -`Scene.referenceIds: string[]` points at
  `project.references`; shared by image and video scenes.
- `lib/projects/normalize-project.ts:126-191` -a scene's visual kind is chosen by
  `scene.type` (`'image' -> generated_image`, `'video' -> generated_video`). There is
  **no link from a video scene to an image scene or a generated image asset**; the
  only cross-scene image mechanism is `scene.referenceIds`.
- `lib/generation/image-generation-service.ts:71-93` -the image service resolves
  references the same way (`role` is not part of `ReferenceInput` there).

### 4.5 Storage

`lib/storage/media-store.ts`:
- `:47-64` `rootForRelativePath` routes `assets/...` and `references/...` to their
  respective roots; `:266-270` `readRelativeFile` reads **either** root from a
  project-relative path. So a generated image **asset** (`asset.localPath`) is already
  readable by the same helper used for references.
- `:312-351` `saveGeneratedVideo` writes `assets/…-generated-<attempt>.mp4`, probes
  FFprobe, returns an `Asset` with `metadata.providerJobId`/`providerRequestId`.

### 4.6 Selection, policy, recovery, planning

- `lib/ai/video-generation/registry.ts:8,14-47` -`VideoProviderId = 'openai'|'fal'|'fake'`;
  `getProvider('fal') -> new FalVideoGenerationProvider()` (fresh per call);
  `falConfigured: Boolean(process.env.FAL_KEY)`.
- `lib/production/run-policy.ts`:
  - `:98-114` real defaults -> `video: 'openai'`; fal is explicit.
  - `:156-158` `isRealProvider` includes `fal`.
  - `:369-371` real-mode preflight requires `FAL_KEY` when `video === 'fal'`;
    `:520-522` same for manual resolution.
  - `:479-488` `normalizeRequestedProvider('video', ...)` accepts `openai|fal|local`.
  - `:543-610` `resolveManualGenerationProvider` -the single-modality gate used by
    both the manual scene route and (indirectly) the runner.
- `lib/production/production-runner.ts:899-935` and
  `lib/production/run-service.ts:899-935` -a `video_submit` action calls
  `submitSceneVideoGeneration(projectId, sceneId, { regenerate, provider: providers.video, mode })`.
  No per-scene model/frame payload is threaded today.
- `lib/production/production-planner.ts:201-267` -a `generated_video` scene yields
  `video_submit` (+ `video_poll` when active) purely from scene state; scene render
  waits on it (`:360-377`). No dependency on an image exists.
- `lib/production/run-recovery.ts:43-116` -an active video attempt with a
  `providerJobId` is resumed by poll; an unresumable real-mode attempt is **suppressed**
  so a restart cannot silently re-bill. Any i2v design must keep this property.
- `app/api/projects/[id]/scenes/[sceneId]/generate-video/route.ts:24-27` -the manual
  route accepts only `{ regenerate }` (no provider/model/frame fields; the provider is
  resolved by server policy).
- `.env.example:27-39` -`FAL_KEY` plus optional `FAL_VIDEO_*` overrides
  (`ENDPOINT`, `BASE_URL`, `TIMEOUT_MS`, `PROMPT_EXPANSION_MODE`, `RESOLUTION`).

---

## 5. Official image-to-video contract (re-verified live this session)

Source fetched: `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max-turbo/image-to-video`
(public, no auth). Endpoint id: `minimax/h3-max-turbo/image-to-video`; server
`https://queue.fal.run`; security `apiKeyAuth` header `Authorization`.

### 5.1 Input schema `H3MaxTurboImageToVideoInput` **[official]**

Required: `prompt` (1..50000 chars) and `prompt_expansion_mode`
(`disabled | balanced | quality`, default `balanced`). i2v still requires a prompt.

Optional fields:
- `image_url` (string | null): *"Optional URL of the image to use as the first frame.
  When provided, the output canvas follows this image. If only `end_image_url` is
  provided, the canvas follows that last frame instead. If both images are omitted,
  the request is handled as text-to-video (16:9 by default)."*
- `end_image_url` (string | null): *"Optional URL of the image to use as the last
  frame. It may be provided alone for end-only keyframe generation; in that case the
  output canvas follows this image."*
- `duration` (number, `0.92..15`, default `5`); *"can run up to about 0.7 s longer
  than requested. Use at least 2 s with `target_audio_url`."*
- `resolution` (`480P | 768P | 1080P`, default `768P`).
- `seed`, `enable_safety_checker` (default `true`), `sync_mode` (default `false`).
- `target_audio_url` (string | null): *"…at least 2 seconds long (maximum 15 MB)…
  Accepts an HTTP(S) URL or a base64 data URI."*

Key differences vs. text-to-video **[official]**:
- **No `aspect_ratio` field.** The canvas follows the supplied frame (start if given,
  else end, else t2v default 16:9).
- Adds `image_url` and (independently) `end_image_url`; **both may be present
  together** (the `image_url` description reasons about the end-only case, implying
  independent optionality).
- New `sync_mode`: *"Return the generated video as base64 instead of a CDN URL."*
  The existing adapter's `download()` reads `video.url`, so **`sync_mode` must stay
  `false`** (default) or download semantics change.

Output **[official]**: `{ video: File, expanded_prompt?, timings? }` where
`File = { url, content_type?, file_name?, file_size? }` -same shape the adapter
already parses.

### 5.2 Queue paths **[official + P38 evidence + code]**

The fetched OpenAPI declares the queue paths **with** the endpoint sub-path, e.g.
`/minimax/h3-max-turbo/image-to-video/requests/{request_id}/status`. P38's live
evidence showed the *real* queue path for this model **drops** the sub-path:
`https://queue.fal.run/minimax/h3-max-turbo/requests/{id}/status` -> HTTP 200,
while the full model-id path returned HTTP 405. So the OpenAPI `paths` are
**misleading for multi-segment ids**. Consequence: for i2v we must **not** assume the
path; the P39 fix (learn it from the returned `status_url`/`response_url`/`cancel_url`)
already handles this correctly and needs **no change**. The i2v queue path is expected
to be the same app path (`minimax/h3-max-turbo`) as text-to-video **[assumption -
high confidence, but verify on the first live i2v call]**.

### 5.3 Image input encoding **[official, with a caveat]**

- The `image_url`/`end_image_url` descriptions say only *"URL of the image"*; they do
  **not** explicitly repeat the data-URI clause. The clause **is** stated verbatim on
  `target_audio_url` (same schema) and, per the model "Files" documentation, file
  inputs in general accept *"your own URL or a Base64 data URI"* **[official docs]**.
- Therefore: base64-only (no hosting, one authenticated host) is the intended
  approach, but treat "`image_url` accepts a data URI" as **[assumption to validate on
  the first live i2v call]**. No documented MIME list, byte cap, or min/max pixel size
  for image inputs -> **[assumption]**.

### 5.4 Pricing **[from P37/P38, unchanged]**

`minimax/h3-max-turbo/image-to-video` = **$0.025 / second** (same as text-to-video);
5 s ~= $0.125. The pricing page notes resolution/duration/quality *"may affect"* cost
**[official]**, so treat the per-second figure as an estimate.

---

## 6. Recommended smallest safe extension

### 6.1 Design choice: where the start/end frames come from

Two candidate sources, with a clear recommendation:

- **Option A - reference-based frames (recommended, smallest).** Use the existing
  `scene.referenceIds` -> `project.references` mechanism and designate which entry is
  the start and which is the end frame. Reuses `resolveReferenceInputs`,
  `media.readRelativeFile`, and the already-validated `references/` path. No new
  storage path, no new asset access, minimal type surface.
- **Option B - asset-based frames (follow-up).** Add optional
  `startFrameAssetId?`/`endFrameAssetId?` on the video generation record and resolve
  bytes from `project.assets[*].localPath` via the **same** `media.readRelativeFile`
  (which already supports the `assets/` root, `media-store.ts:47-64`). This is what
  "animate a generated still image" ultimately needs, because a generated image is an
  `Asset`, not a `ReferenceImage`. It is modest, but it adds asset-path validation and
  a UI/planner surface.

**Recommendation:** ship **Option A** first (frames come from the scene's reference
images). If the product requirement is specifically "animate the scene's own generated
image", **Option B** is required and should be a separate, explicit step - and it is
smaller than it looks because `readRelativeFile` already covers `assets/`.

### 6.2 How frames are designated (within Option A)

- Add explicit optional fields on the video `GenerationRecord`
  (`lib/types/generation.ts:33-48`): `startFrameReferenceId?: string` and
  `endFrameReferenceId?: string` (or a typed `metadata` shape). Explicit ids beat a
  positional convention (`references[0]`=start) because they survive reordering, are
  self-describing in persisted state, and match P37's recommendation. A positional
  fallback can be added later if desired, but not in the first cut.
- Constraint: a designated frame id must be present in the effective `referenceIds`
  (`current.referenceIds` falling back to `scene.referenceIds`); otherwise fail with a
  clear error rather than silently ignoring it.

### 6.3 Concrete change set (Option A)

1. **Types**
   - `lib/ai/video-generation/provider.ts:9`: extend
     `VideoReferenceInput.role` to `'reference' | 'start_frame' | 'end_frame'`.
   - `lib/types/generation.ts`: add optional `startFrameReferenceId` /
     `endFrameReferenceId` to the (video) generation record. Keep optional and
     backward-compatible; nothing else needs to change for existing projects.
2. **Service** (`lib/generation/video-generation-service.ts`)
   - `resolveReferenceInputs` (`:173-196`): accept a role map and set
     `role: 'start_frame' | 'end_frame'` for the designated ids; **default stays
     `'reference'`** so text-to-video/openai behavior is byte-for-byte unchanged.
   - `submitSceneVideoGeneration` (`:270-271`, `:311-322`): pass the designated ids
     through; when the resolved endpoint is image-to-video, require at least one frame
     and reject a leftover `role:'reference'` (clear error) rather than letting the
     adapter silently drop it.
3. **Adapter** (`lib/ai/video-generation/fal-provider.ts`)
   - Detect the i2v endpoint from the resolved `request.model` (or configured
     `FAL_VIDEO_ENDPOINT`) -e.g. path suffix `/image-to-video`. This keeps a single
     adapter and a per-scene model override.
   - When i2v: map `start_frame -> image_url` and `end_frame -> end_image_url` as
     base64 data URIs (`data:{mimeType};base64,{...}`); **omit `aspect_ratio`**;
     reject any non-frame reference with `REFERENCE_ERROR`.
   - Keep the text-to-video branch exactly as-is (`aspect_ratio` still emitted,
     references still rejected).
   - Capabilities: report `supportsImageToVideo: true` when configured for i2v (only
     tests consume this today).
4. **Selection / policy**: no new provider id. Real-mode + `FAL_KEY` gating
   (`run-policy.ts:369-371`) is provider-level and already covers i2v. Confirm no code
   path lets a caller bypass policy by setting a per-scene model.
5. **Docs**: extend `.env.example` comment if a distinct i2v endpoint is documented
   (no new required var).

### 6.4 What does **not** change

- **P39 job-id / queue-path logic is untouched.** i2v uses the same composite
  `fal:{queuePath}:{request_id}`, the same returned-URL resolution, and the same
  poll/download/cancel URL construction. Legacy ids still decode.
- **Storage/render handoff is untouched.** The i2v result is a normal `video/mp4`
  downloaded and stored by `saveGeneratedVideo`; the render/compose pipeline consumes
  the resulting `Asset` exactly like a text-to-video asset.
- **Planner/recovery are untouched.** An i2v scene is still a `generated_video` scene;
  `video_submit`/`video_poll` planning and the real-mode re-billing suppression behave
  identically.

### 6.5 Error handling and secret hygiene

- Missing reference / missing file -> existing `generation.reference.fileMissing`
  (404, `video-generation-service.ts:178-181`).
- Designated frame not in `referenceIds`, >2 frames on i2v, i2v with no frame,
  or leftover `reference` role on i2v -> explicit `INVALID_REQUEST`/`REFERENCE_ERROR`.
- Never log or echo the base64 data URI. The adapter already logs nothing; any error
  message must reference only MIME type and byte length, never image bytes.

---

## 7. Test plan (for the implementation phase - not executed in P40)

- **Adapter** (`tests/fal-video-provider.test.ts`):
  - i2v via `model` override: start-only -> `image_url` data URI, **no** `aspect_ratio`;
    start+end -> both fields; end-only -> only `end_image_url`.
  - i2v with a `role:'reference'` image -> `REFERENCE_ERROR`; i2v with no frame ->
    clear request error.
  - text-to-video unchanged: `aspect_ratio` present, references still rejected.
  - capabilities reflect i2v when configured; data-URI is well-formed
    (`data:<mime>;base64,` prefix); key is never sent to the media host.
- **Service** (`tests/fal-video-service.test.ts`, `tests/video-generation-service.test.ts`):
  - designated start/end receive the correct roles; default all-`reference` path is
    unchanged for t2v.
  - missing/unsafe frame id -> clear error; job id round-trips with the i2v queue path
    (fake fetch returns queue URLs with the shortened path).
- **Policy/registry** (`tests/run-policy.test.ts`, `tests/video-provider-registry.test.ts`):
  - i2v still requires `FAL_KEY`; a per-scene model override cannot bypass mock/real or
    credential gates.
- **Planner/recovery** (`tests/production-planner.test.ts`, `tests/run-recovery.test.ts`):
  - a `generated_video` scene with frame references still plans `video_submit`; the
    real-mode suppression guarantee is preserved.

---

## 8. Cost and safety (for any future paid i2v pilot)

- i2v is **$0.025/s** **[official]** (5 s ~= $0.125). P40 spends nothing.
- If approved later: hard cap **1 submit** and **<= $1**, no automatic retry, reuse the
  P38 single-submit idempotency-lock pattern, and cancel rather than resubmit on
  timeout. Keep the recovery suppression behavior for real-mode submits.
- The key stays on `queue.fal.run` only; no hosted image upload is required for
  Option A (base64), so no second authenticated host.

---

## 9. Genuinely open questions

1. **Does `image_url` accept a base64 data URI?** Stated for `target_audio_url` and in
   the general Files docs, but not repeated on the `image_url` field itself. Validate
   on the first live i2v call; otherwise fall back to a hosted URL / FAL storage
   upload.
2. **Per-field image limits** (accepted MIME, byte cap, min/max pixel size) -not
   documented. Bounded by the test frame sizes in practice.
3. **Start/end fidelity**: whether the first/last pixels are reproduced exactly vs.
   approximately -not guaranteed by the docs (keyframe semantics only).
4. **Aspect behavior**: canvas follows the frame; with the app's project aspect model
   (16:9/1:1/9:16) a frame that is not exactly that ratio yields a differently-shaped
   output (P38 saw 16:9 -> 1344x768). Decide whether the app should letterbox/validate
   the frame or accept the model's canvas.
5. **Product intent**: is the intended source a **reference image** (Option A) or the
   **scene's generated still** (Option B)? The smallest safe extension differs between
   the two; this report recommends Option A first and Option B as the explicit
   follow-up if "animate the generated still" is the requirement.
6. **Queue path for i2v**: expected `minimax/h3-max-turbo` (same app as t2v), managed
   by the P39 returned-URL logic. Confirm on the first live call.

---

## 10. Checks actually run this session

- `git rev-parse HEAD` / `git rev-parse origin/main` / `git log -1 --oneline` /
  `git status --short` (confirmed `439b279` == `origin/main`, only untracked recon docs).
- `webfetch` of the public official i2v OpenAPI schema (section 5).
- Static source reading of the files cited in section 4.
- **Not run:** `tsc`, `lint`, `build`, `vitest` -P40 modifies nothing, so there was
  nothing to verify; the P39 baseline (81 files / 552 tests) stands.

---

## 11. Stop point

No application code was changed; nothing was committed or pushed; no FAL request was
made; no key was read, printed, or logged. Awaiting a product decision on
section 9.5 (reference image vs. generated still) and explicit approval before any
implementation, which would be scoped to Option A (or A+B) with unit/mock tests only
and no paid call.
