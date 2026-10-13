# P41 - FAL.ai Image-to-Video Implementation

Status: IMPLEMENTED. The existing `FalVideoGenerationProvider` now also supports
FAL.ai **image-to-video** end-to-end (submit, poll, resume with a fresh provider,
download, cancel) behind the same provider contract, registry, job lifecycle and
P39 queue-path resolution as text-to-video. The working text-to-video route is
unchanged by default. **No real FAL request was made, no credential was read, and
no FAL credit was spent.**

Baseline: branch `main`, HEAD `439b279708b84400f0506d83d971b0ffef5e0307`
(`fix(video): resolve FAL queue path for multi-segment model ids`) == `origin/main`.

## 1. Repository state

- Verified branch `main`, HEAD `439b279`, working tree clean apart from the
  intentionally untracked recon docs (`p29*`, `p29.2*`, `p31*`, `p33*`, `p35*`,
  `p37*`, `p38*`, `p40*`), left untouched.
- No `.gitmodules` (no submodules). Gitignored `projects/` output untouched.

## 2. Context (from P40)

P40 mapped the architecture and recommended that image-to-video reuse the existing
`FalVideoGenerationProvider` rather than a second pipeline. Frames come from the
existing `project.references` set via two new explicit fields on the video
generation record:

- `startFrameReferenceId` (required for i2v) - seeds the first frame;
- `endFrameReferenceId` (optional) - seeds the last frame.

Plain `reference` inputs (and the generated-still / "Option B" path) are kept
distinct and out of scope. The P40 blocker (base64 data URI as a file input) was
resolved by the official FAL files contract: file inputs accept either the
customer's own URL or a Base64 data URI.

## 3. Design decisions

1. **One adapter, endpoint-selected mode.** The adapter speaks text-to-video or
   image-to-video depending on the resolved endpoint (the configured
   `FAL_VIDEO_ENDPOINT`, or a per-request `model` override). No second provider
   class, no new job store, no webhook, no second pipeline.
2. **Explicit frame roles, not positional references.** Frame selection is set on
   the generation record (`startFrameReferenceId` / `endFrameReferenceId`), so
   plain references and keyframes are never confused and reordering a scene's
   references cannot silently change which image seeds a frame.
3. **Base64 data URI transport.** The local frame bytes are sent inline as
   `data:image/...;base64,...`, so the only authenticated request is the queue
   submit - no public asset URL is created and the API key never leaves the queue
   host. The data URI is never logged or echoed in error messages.
4. **No `aspect_ratio` for i2v.** The i2v schema has no `aspect_ratio` field; the
   output canvas follows the frame image. It is only sent on the text-to-video
   path.
5. **`sync_mode: false` explicitly.** The i2v endpoint has no default, and this
   keeps the completed job exposing a CDN media URL the download path can fetch.
6. **Fail closed on unsupported inputs.** A missing frame, a duplicate
   start/end frame, a non-image or empty frame, or a plain `reference` on the
   i2v endpoint is rejected with a typed error instead of being silently dropped.

## 4. Changes

### 4.1 Types

- `lib/ai/video-generation/provider.ts`: added exported
  `VideoReferenceRole = 'reference' | 'start_frame' | 'end_frame'` and widened
  `VideoReferenceInput.role` to that union.
- `lib/types/generation.ts`: added optional `startFrameReferenceId` /
  `endFrameReferenceId` to `GenerationSpec`, documented as needing to resolve to
  the effective `referenceIds` and to be meaningful only for video generation.

### 4.2 Normalization and validation

- `lib/projects/normalize-project.ts`: the video generation normalizer now
  carries `startFrameReferenceId` / `endFrameReferenceId` through, so the
  designations survive round-trips instead of being dropped.
- `lib/validation/project-validation.ts`: for `generated_image`/`generated_video`
  scenes, each designated frame id must resolve to an existing reference,
  otherwise a project error `scene.visual.generation.frameReference.missing` is
  reported at validation time (a typo surfaces before provider submit).

### 4.3 Service (`lib/generation/video-generation-service.ts`)

- New `FrameReferenceDesignation` and `assertFrameReferences(referenceIds, frames)`
  which runs before any provider call and rejects:
  - identical start and end frames -> `generation.reference.frameConflict`;
  - a start frame not in the effective reference set ->
    `generation.reference.startFrameInvalid`;
  - an end frame not in the effective reference set ->
    `generation.reference.endFrameInvalid`.
- `resolveReferenceInputs(..., frames)` now tags each input with its role:
  the designated start id -> `start_frame`, the designated end id -> `end_frame`,
  everything else stays `reference`. With no designations (and for text-to-video)
  every input remains `reference`, so existing behaviour is unchanged.
- The submit call site asserts the frames and passes the current designations.

### 4.4 Adapter (`lib/ai/video-generation/fal-provider.ts`)

- `FAL_IMAGE_TO_VIDEO_ENDPOINT_SUFFIX = 'image-to-video'` and private
  `isImageToVideoEndpoint(endpoint)` (matches the last path segment), so the
  configured default and a per-request `model` override share one rule.
- `resolveFrameReferences(references)`: accepts at most one `start_frame` and one
  `end_frame`, rejects plain `reference` inputs, and requires at least one frame.
- `toImageDataUri(reference, label)`: validates the MIME is `image/*` and the bytes
  are non-empty, then encodes the base64 data URI.
- `getCapabilities()` now reports `supportsImageToVideo` from the configured
  endpoint, with a comment noting the per-request `model` override is authoritative
  at submit time.
- `submit()` branches on the resolved endpoint:
  - i2v: payload = `prompt`, `prompt_expansion_mode`, `sync_mode: false`,
    `image_url` (start) and/or `end_image_url` (end) as data URIs, plus optional
    `duration`/`resolution`/`seed`/`safety`; **no `aspect_ratio`**;
  - t2v: unchanged payload; reference inputs are still rejected explicitly.

## 5. Security

- Frame bytes travel only as inline data URIs on the authenticated queue submit;
  no public/served asset URL is created and no second authenticated request is
  introduced.
- The `FAL_KEY` is only ever attached to requests against the configured
  `FAL_VIDEO_BASE_URL`; the media download continues to omit the `Authorization`
  header (unchanged from P39).
- Errors describe the problem, not the payload: tests assert the frame bytes and
  the key never appear in submit error messages or logs.
- The provider is still gated by the existing real-mode/opt-in/credential policy;
  mock mode never reaches the provider (no network).

## 6. Tests

Added/extended (all fixture/mock based with injected `fetch`; no live requests):

- `tests/fal-video-provider.test.ts` - new `FalVideoGenerationProvider
  image-to-video` block (11 tests): capabilities; start-only (asserts
  `sync_mode:false`, `image_url` data URI, and no `aspect_ratio`/`end_image_url`);
  start+end; end-only; per-request `model` override selecting i2v; missing frame
  rejected; plain reference rejected; multiple start frames + non-image + empty
  rejected; start frame on the t2v endpoint rejected; and no secret/base64 leak in
  error messages.
- `tests/fal-video-service.test.ts`: submit -> poll -> download of an i2v job whose
  response URLs carry the shortened queue path (P39 resolution), each poll using a
  freshly constructed provider via the registry; asserts the composite job id and
  the i2v payload (data URIs, `sync_mode:false`, no `aspect_ratio`).
- `tests/video-generation-service.test.ts`: role mapping (`start_frame`/`end_frame`
  and remaining plain `reference`), no-designation default, invalid start frame,
  identical start/end frames, and persistence of the designations on the attempt.
- `tests/run-policy.test.ts`: an i2v scene model still requires `FAL_KEY` in real
  mode (no per-scene model bypass of credential gating).
- `tests/video-provider-registry.test.ts`: the resolved fal provider reports
  `supportsImageToVideo` from `FAL_VIDEO_ENDPOINT`.
- `tests/project-update.test.ts`: frame designations survive normalization, a
  resolving frame validates, and an unresolved frame id is flagged
  (`scene.visual.generation.frameReference.missing`).
- `tests/fal-video-storage.integration.test.ts`: an i2v-endpoint download persists
  through the real media store and the stored MP4 decodes + probes under local
  FFmpeg (reuses the real fixture bytes helper).

## 7. Verification

- `npx tsc --noEmit` -> clean.
- `npm run lint` -> clean (`No ESLint warnings or errors`).
- `npm run build` -> succeeded.
- `npx vitest run` -> **81 files / 574 tests passed** (baseline 552; +22). The
  FFmpeg storage integration is included in this run and uses only a local fixture.

## 8. Out of scope (respected)

No second video pipeline, no change to the default text-to-video route, no
automatic "animate a generated scene still" transition (P40 Option B, deferred),
no effects-volume/UI refactors, no route or UI changes (frame ids are authored
through the existing project update), no real FAL call.

## 9. Open questions

- Per-field image limits for the i2v `image_url` / `end_image_url` inputs
  (MIME/bytes/dimensions) are undocumented; only MIME + non-empty are enforced.
- Pixel-exact vs approximate treatment of start/end frames, and how the output
  aspect ratio behaves versus the project's 16:9/1:1/9:16, should be confirmed on
  the first live call.
- The i2v queue path is expected to drop the endpoint sub-path like t2v (P39);
  confirm on the first live call.

## 10. Confirmation

No real FAL.ai request was executed and no FAL credit was consumed during this
phase; all verification used injected fetch mocks and a local FFmpeg fixture. The
API key was never read, printed or logged. Existing untracked recon docs and the
gitignored `projects/` output were left untouched.
