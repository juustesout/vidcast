# P45 - FAL Image-to-Video Workflow Integration Recon

Status: **RECON ONLY.** No production code was changed, nothing was committed or
pushed, no configuration was modified, and no paid provider call was made. The
existing untracked recon docs and the gitignored `projects/` pilot data were left
intact. Only local, non-paid checks (git inspection, code reads, one targeted
mock/fixture test run) were executed.

Convention: **[code]** = verified by reading this repo; **[run]** = command output
this session; **[test]** = proven by an existing automated test; **[open]** =
uncertain / needs a decision or new test.

---

## 1. Executive summary and go/no-go

P44 proved the FAL image-to-video (i2v) provider end-to-end through the service
layer: one paid submit, MP4 stored, scene linked, full decode. This recon asked what
remains to make that provider usable from the **normal explainer production
workflow**, and what breaks or is at risk.

Findings in one paragraph: the backend chain (types, validation, normalization,
service, adapter, storage, production-run polling) is complete and durable for i2v,
and mock/real/credential gating is enforced. The **blocking gaps are at the edges**:
(1) the UI cannot select `fal` or any video model, and the manual `Generate Video`
path ignores the scene's stored provider and resolves to `local`/`openai` via server
defaults; (2) the UI cannot author start/end frames at all, and `generation.referenceIds`
can drift from `scene.referenceIds`; (3) the i2v output canvas follows the start
frame, so a 3:2 frame in a 16:9 project is silently **center-cropped (~15.6% of the
height)** by the scene renderer and the compositor - a policy that is currently
implicit and not configurable; (4) a transient poll failure marks the attempt
`failed` while retaining the FAL job id, after which a fresh run will **re-submit
(duplicate billing)** rather than resume; (5) MCP cannot select `fal`
(`video: 'local'|'openai'` only); (6) cancellation is implemented in the adapter but
never wired to any caller.

**Go/No-Go for P46: GO**, but scoped and ordered. P46 should be **two phases**:
- **Phase P46-A (unblock the workflow)**: provider/model authoring + honor the stored
  provider on the manual path, and start/end-frame authoring with reference-set
  synchronization. Without these, i2v is only reachable by out-of-band API calls.
- **Phase P46-B (correctness/robustness/parity)**: explicit aspect policy + a
  crop/letterbox decision, the duplicate-submit fix, MCP `fal` parity, and
  cancellation wiring.

No large refactor is justified; every item below is a small, targeted change with a
clear test.

---

## 2. Current execution chain (config -> result)

### 2.1 Types, validation, normalization

- Scene/visual types: `lib/types/scene.ts:131-136` (`GeneratedVideoVisual`),
  `:154` (`VisualSpec`); `lib/types/generation.ts:22-38` (`GenerationSpec` with
  `startFrameReferenceId` `:35`, `endFrameReferenceId` `:36`); `SceneType` in
  `lib/types/scene.ts:3`.
- Normalization preserves provider/model/frame ids/duration for `generated_video`:
  `lib/projects/normalize-project.ts:159-193` (provider `:164`, model `:165`,
  `startFrameReferenceId` `:169`, `endFrameReferenceId` `:170`, duration `:172`).
- Validation: referenced frames must resolve to real references
  (`lib/validation/project-validation.ts:230-239`, code
  `scene.visual.generation.frameReference.missing`); generation references must
  exist (`:224-228`); generated visuals need an asset when generated (`:241-243`);
  duration > 0 (`:254-256`).
- Project update endpoint accepts and persists all of the above without a field
  whitelist: `app/api/projects/[id]/route.ts:25-93` -> `lib/projects/project-update.ts:34-75`
  -> `normalizeProject` **[code]**.

### 2.2 Frame resolution and roles

- `getReferenceById` resolves only from `project.references`
  (`lib/generation/video-generation-service.ts:162-171`).
- Pre-network `assertFrameReferences` rejects identical start/end
  (`generation.reference.frameConflict`), a start/end frame outside the effective
  reference set (`generation.reference.startFrameInvalid` / `endFrameInvalid`)
  (`video-generation-service.ts:182-207`).
- `resolveReferenceInputs` tags roles `start_frame`/`end_frame`/`reference` and reads
  the bytes from disk (`:209-234`).
- The adapter maps `start_frame` -> `image_url` and `end_frame` -> `end_image_url`,
  as base64 data URIs, and requires at least one frame on the i2v endpoint
  (`lib/ai/video-generation/fal-provider.ts:160-203`, `:442-453`).

### 2.3 Video generation service and FAL adapter

- Submit: `submitSceneVideoGeneration` (`video-generation-service.ts:279-440`).
  Provider resolved from `options.provider`/`options.mode` via
  `resolveManualGenerationProvider` (`:151-160`, `:318`); model/prompt/frames/
  aspect/duration come from the persisted scene generation record (`:362-367`).
- The queued attempt is persisted **before** the network call, then updated with
  `providerJobId`/`providerStatus` (`:326-358`, `:406-426`).
- Poll/resume/download: `refreshVideoGenerationAttempt` (`:442-666`). On `generated`
  it downloads and stores through the media store, appends the asset in the same
  `mutateProject` (`:562-640`).
- FAL adapter: endpoint selected by `request.model` or `FAL_VIDEO_ENDPOINT`
  (`fal-provider.ts:433`), i2v branch `:442-453`, composite job id
  `fal:{queuePath}:{requestId}` (`:256-290`), stateless getStatus/download (`:530-647`).

### 2.4 Production-run planning, dispatch, polling, resume

- Planner derives `video_submit` and `video_poll` actions and marks submit
  non-executable while a job is running; a resumable job id yields a `video_poll`
  action (`lib/production/production-planner.ts:201-266`, `actionId` `:71-79`).
- Dispatch calls the injected service functions directly (not HTTP):
  `video_submit` -> `submitSceneVideoGeneration(..., { regenerate, provider, mode })`
  (`lib/production/run-service.ts:899-935`); `video_poll` ->
  `refreshVideoGenerationAttempt(projectId, attemptId, undefined, { mode })`
  (`:937-965`).
- Recovery leaves an active job with a job id for polling, restores from a usable
  asset, or marks failed and suppresses in real mode
  (`lib/production/run-recovery.ts:43-115`, esp. `:56-65`); planner resume test
  `tests/run-recovery.test.ts:325-341`.
- Composition step: `final_compose` -> `videoCompositionService`
  (`run-service.ts:1040-1049`).

### 2.5 Storage and scene linkage

- Generated media: `mediaStore.saveGeneratedVideo` persists the asset and its
  generation metadata (`lib/storage/media-store.ts:312-347`); the scene's
  `visual.assetId`/`generation.assetId` point at it
  (`video-generation-service.ts:582-639`).

### 2.6 HTTP and MCP entry points

- HTTP video: `POST /api/projects/[id]/scenes/[sceneId]/generate-video`
  (`generate-video/route.ts:11-48`, body `{ regenerate? }` only) and
  `GET /api/projects/[id]/generation-jobs/[attemptId]`
  (`generation-jobs/[attemptId]/route.ts`). **[code]**
- HTTP production run: `POST /api/projects/[id]/production-runs`
  (`video: z.enum(['local','openai','fal'])`, route `:17`). **[code]**
- MCP production tools: `run_production`, `get_run_status`, `get_run_log`
  (`mcp/production/tools.ts:185-215`) -> the HTTP routes above
  (`mcp/production/api-client.ts:193-259`). The MCP `video` enum is
  `z.enum(['local','openai'])` (`mcp/production/tools.ts:18`; type
  `mcp/production/api-client.ts:28`) - **no `fal`**. **[code]**
- MCP has **no** tool for direct scene video generation / polling; authoring covers
  project CRUD, scene intents and music; read-only covers project/scene/validation/
  plan/compositions. **[code]**

---

## 3. Normal workflow and UI gaps (and API/MCP parity)

UI evidence is from `components/project/project-workspace.tsx` (scene inspector and
task list), `components/project/server-run-panel.tsx`, `lib/constants.ts`.

| Capability | UI status | Evidence |
| --- | --- | --- |
| Configure a scene as type `video` | **Works** | `project-workspace.tsx:1528-1530` (Type + Visual source selects), `:470-480`, `:102-116`; `constants.ts:6` |
| Select provider `fal` for video | **Missing** | provider dropdown options exclude `fal`: `constants.ts:40` (`['openai','gemini','local','other']`); dropdown rendered at `:1781-1799` |
| Select a video model (i2v endpoint) | **Missing** | no `generation.model` input (`only narration model at :1634-1645`; display-only at `:2213`) |
| Set the generation prompt | **Works** | `:1819-1837` |
| Set scene duration | **Works** (scene-level) | `:1528`; generation.duration not separately editable |
| Choose a START frame (`startFrameReferenceId`) | **Missing** | no JSX references it; only type/normalize/validation/service/tests |
| Choose an END frame (`endFrameReferenceId`) | **Missing** | same |
| Trigger video generation | **Works** | inspector `:1928-1944`, tasks `:2255-2276`, client Produce `:583-611` -> `POST .../generate-video` with `{ regenerate }` only (`:878-882`, `:587-591`) |
| Pass provider/model override on manual generation | **Missing** | route reads only `regenerate` (`generate-video/route.ts:24-27`); server resolves provider from defaults (`video-generation-service.ts:318` -> `run-policy.ts:98-114,543-583`) |
| Validation panel shows frame/video errors | **Partial** | generic `ValidationPanel` (`project-workspace.tsx:285,2288-2290`; `validation-panel.tsx:9-42`) but fields are not editable |

**Critical behavioral gap [code]:** the manual `Generate Video` button (and the
client-side Produce batch) send no provider, so the service resolves the video
provider from server defaults: `local` in mock mode or `openai` in real mode
(`video-generation-service.ts:151-160,318-319`; `run-policy.ts:98-114,543-583`).
The scene's stored `generation.provider = 'fal'` is **ignored** on this path. FAL i2v
is therefore unreachable from the UI today; it is only reachable by posting
`providers.video: 'fal'` to `/api/projects/[id]/production-runs` (HTTP enum includes
`fal`, route `:17`) with the frames set out-of-band, or by calling the service
directly (as P44 did).

**Reference-set desync [code]:** the inspector's reference toggles only update
`scene.referenceIds` (`project-workspace.tsx:1993-2002`), while the video service
prefers `generation.referenceIds` when non-empty
(`video-generation-service.ts:320`). `ensureVisualForMode` copies `scene.referenceIds`
into `generation.referenceIds` only at visual-creation time
(`project-workspace.tsx:111`). After that, changing the scene references can leave a
designated frame outside the effective reference set (and the frame selectors do not
exist yet anyway).

**MCP/HTTP differences [code]:**
- Provider enum: HTTP accepts `fal` (`production-runs/route.ts:17`); MCP does not
  (`mcp/production/tools.ts:18`). So a FAL run can be started over HTTP/UI but not
  via MCP `run_production`.
- The run path passes `provider` + `mode` into the service (`run-service.ts:910-914`);
  the direct HTTP video routes pass **neither** and rely on server defaults
  (`generate-video/route.ts:27`; `generation-jobs/[attemptId]/route.ts:27`).
- No MCP tool mirrors the direct video generate/poll routes.

**Direct HTTP vs UI:** the UI never sets `generation.model` or frame ids, so even a
correct UI provider selection would still need model+frame authoring for i2v.

---

## 4. Aspect-ratio and composition findings

### 4.1 How ratios are handled today

- Composition canvas is authoritative from `project.renderSettings.width/height`
  (e.g. 1920x1080) and `project.renderSettings.fps`, not from `project.aspectRatio`
  directly (`lib/render/scene-resolver.ts:179-185`; `video-composition-service.ts:196-206`).
- Scene renderer forces each video onto the canvas with **scale-to-cover +
  center-crop**: `trim` -> `setpts` -> `tpad` (clone last frame if short) ->
  `scale=W:H:force_original_aspect_ratio=increase` -> `crop=W:H` -> fade -> `fps`
  (`lib/render/renderer.ts:189-226`, filters `:193-203`). The segment is exactly
  canvas-sized.
- Final composition re-normalizes each scene segment with the same
  scale-to-cover + crop (`lib/render/video-compositor.ts:100-125`, filter `:105`),
  then concats and validates that output dimensions equal the canvas
  (`:249-280`, `validateOutput` `:257`).
- `resolveCompositionPlan` **requires** each scene render to already match the
  canvas, else `INCOMPATIBLE_RENDER` (`video-composition-service.ts:174-176`) - so the
  crop is effectively mandatory and baked into the scene render.

### 4.2 P44 consequence (quantified)

P44's i2v output was 1152x768 (3:2, following the 1536x1024 start frame) into a
16:9 project. On render/compose, scale-to-cover scales to 1920x1280 and center-crops
to 1920x1080, discarding **200 px of height = ~15.6% of the frame** (100 px top +
100 px bottom). There is **no letterbox/pad option**, no per-scene aspect override,
and no warning that cropping will occur. This is silent quality loss / unexpected
cropping for i2v clips whose frame aspect differs from the project canvas.

### 4.3 Where an adjustment belongs

- The `scale=...:force_original_aspect_ratio=increase,crop=...` decision is duplicated
  in `renderer.ts:197-198` and `video-compositor.ts:105`. A single explicit policy
  helper is the natural home for a future `cover` (crop) vs `contain` (pad/letterbox)
  choice.
- Because composition rejects non-canvas renders (`video-composition-service.ts:174-176`),
  a `pad` policy must still output canvas-sized segments (pad within the canvas),
  which is compatible with the existing dimension validation.

### 4.4 Minimal explicit policy recommendation (no change made)

Adopt **"cover + center-crop" as the documented default**, but make it explicit and
visible:
1. Add a project-level (or scene-level) `videoFit: 'cover' | 'contain'` with default
   `'cover'` (single shared helper used by both renderer and compositor).
2. Emit a **validation warning** when a generated-video scene's source/frame aspect
   differs from the canvas aspect (e.g. reuse the existing warning channel like
   `scene.visual.generatedVideo.durationMismatch` in
   `lib/render/scene-resolver.ts:86-88`), so cropping is never a surprise.
3. For i2v specifically, document that the canvas follows the start-frame image and
   that choosing a start frame already at the project aspect avoids cropping.

This is intentionally small: one helper + one policy field + one warning, no
pipeline redesign.

---

## 5. Run-resume and reliability findings

- **Provider/params durability [code]:** the run record persists the provider
  *policy* (`lib/production/run-types.ts:48-61,70-73`; `run-store.ts:73-86`;
  `run-registry.ts:159-201`); the per-scene attempt persists the *generation params*
  (provider, model, prompt, references, frames, duration) on the project
  (`video-generation-service.ts:326-358,406-426`). Resume re-derives the plan from the
  project, so it uses the durable attempt.
- **Resume without re-submit for an active job [code][test]:** recovery leaves an
  active (`queued|generating`) video job with a `providerJobId` untouched and emits a
  `video_poll` note (`run-recovery.ts:56-65`); the planner only polls while `running`
  (`production-planner.ts:207,221-224,252-266`); the composite FAL job id makes polling
  stateless (`fal-provider.ts:256-290`, `:382-402`). Tests:
  `tests/run-recovery.test.ts:195-231,325-341`.
- **Duplicate-submit risk on transient poll failure [code][open]:** on a poll error,
  `refreshVideoGenerationAttempt` persists the attempt as `failed` while **retaining**
  the `providerJobId`, then throws (`video-generation-service.ts:508-542`). Recovery
  only reconciles `queued|generating` (`run-recovery.ts:24-26,56`), so a `failed`
  attempt is not treated as resumable. The planner then marks `video_submit` `ready`
  with `regenerate: true` for `failed|rejected` (`production-planner.ts:233-236,247-249`).
  Within a single run the completed submit action id suppresses re-execution
  (`production-runner.ts:376-378`), but a **new run** (or a resumed run after the
  attempt went `failed`) will **re-submit a brand-new paid job**, abandoning the
  still-possibly-alive FAL job. Existing test
  `tests/fal-video-service.test.ts:303-323` proves the job id is retained, but no test
  proves the run does **not** re-submit in this state.
- **Timeouts / missing id / retries / partial results [code][test]:**
  - FAL per-request deadline 120 s -> abort -> `504 PROVIDER_FAILED`
    (`fal-provider.ts:42,362-382`); submit timeout persists `failed` with no job id
    (`video-generation-service.ts:374-404`; test `fal-video-service.test.ts:283-301`).
  - Missing `request_id` -> `PROVIDER_FAILED` (`fal-provider.ts:508-511`; test
    `fal-video-provider.test.ts:166-171`).
  - No provider-level retry; failed actions are not retried in the same run
    (`production-runner.ts:376-378`); a new run re-plans them.
  - Poll budget `maxVideoPolls` default 120 -> `VIDEO_POLL_LIMIT_REACHED`
    (`run-service.ts:728-736,153`) while the status stays active (safe resume).
  - Download failure marks `failed` with `DOWNLOAD_FAILED` and keeps the previous
    asset via fallback (`video-generation-service.ts:600-619,621-640`); asset+attempt
    update is atomic in one `mutateProject`.
- **Cancellation not wired [code]:** `FalVideoGenerationProvider.cancel` exists
  (`fal-provider.ts:651`; test `fal-video-provider.test.ts:306-313,403-411`) but there
  is **no caller** anywhere in `lib/`, `app/`, `mcp/`, `components/`.
- **Mock mode provably blocks the real provider [code][test]:** run preflight
  (`run-policy.ts:378-399`) and per-call resolution (`:588-593`) both reject real
  providers in mock mode; `local` -> fake adapter (`registry.ts:24-26`); test proves
  the provider is never constructed (`fal-video-service.test.ts:266-281`).
- **Real-mode/opt-in/credential gating [code]:** enforced at run preflight
  (`run-policy.ts:227-236,339-375`) and per call (`:602-604,511-523`); adapters fail
  closed without keys (`fal-provider.ts:679-687`).
- **Secret leakage [code][test]:** run log events are sanitized on append
  (`Authorization: Key`, `Bearer`, `sk-…`) (`run-registry.ts:28-56,280-296`; test
  `run-registry.test.ts:77-124`); the FAL adapter never puts the key or frame bytes in
  errors (`fal-provider.ts:191-203,311-339`) with tests asserting absence
  (`fal-video-provider.test.ts:173-184,552-566`); the video service serializes only
  message+code (`video-generation-service.ts:119-138`). **Residual [open]:** a raw FAL
  key without an `Authorization: Key`/`Bearer`/`sk-` prefix is not pattern-matched;
  `production-log-export.ts:65-67,86-93` performs no redaction itself (safe only
  because it consumes already-sanitized events).

---

## 6. Test coverage and gaps

Existing, relevant coverage **[test]** (verified by reading titles and running a
subset - see section 8):

| Area | Covered by |
| --- | --- |
| i2v payload: start only, start+end, end only, `sync_mode:false`, no `aspect_ratio` | `tests/fal-video-provider.test.ts:421-566` |
| i2v rejections: no frame, plain references, multiple/non-image/empty, t2v with a frame | `fal-video-provider.test.ts:507-551` |
| queue-path resolution / polling / download / fresh-instance resume | `fal-video-provider.test.ts:186-420` |
| service submit/poll/download i2v with keyframe data URIs | `fal-video-service.test.ts:338-...` |
| frame role mapping, invalid start frame, identical frames, persistence | `video-generation-service.test.ts:326-376` |
| mock blocks fal before any provider call | `fal-video-service.test.ts:266-281`, `run-policy.test.ts` |
| submit timeout no-resubmit; poll timeout keeps job id | `fal-video-service.test.ts:283-323` |
| run resume polls stored job, does not resubmit | `run-recovery.test.ts:195-231,325-341` |
| recovery suppression in real mode | `run-recovery.test.ts:233-247,415-433` |
| keyframe designations through normalization + validation | `tests/project-update.test.ts:244-262` |
| fal storage integration (incl. shortened queue path) | `tests/fal-video-storage.integration.test.ts:81-...` |
| registry reflects configured fal endpoint + config status | `tests/video-provider-registry.test.ts:25-51` |
| compositor scale/crop pipeline (matching canvas) | `tests/video-compositor-args.test.ts:18-22` |

Concrete gaps **[open]**:

1. **No run-level test that a transient poll failure does not lead to a duplicate
   paid submit** (the service test only proves the job id is retained).
2. **No test for provider authoring/selection for video scenes** in the UI, and no
   UI test for start/end frame selection (none exists).
3. **No composition/render test with a mismatched source aspect** (source aspect ≠
   canvas): the crop behavior is not asserted, and no `contain`/pad path exists.
4. **No MCP parity test for `fal`** (MCP enum lacks it) and no MCP test for a direct
   video-generation tool (none exists).
5. **No test for cancellation** (no caller exists).
6. **No test asserting the manual generate-video route honors a stored/override
   provider** (it currently cannot).
7. **No validation warning test** for a video source aspect differing from the canvas.

---

## 7. Prioritized P46 plan (max 8 tasks)

Phase **P46-A** = unblock the workflow (tasks 1-2). Phase **P46-B** =
correctness/robustness/parity (tasks 3-8). Dependencies are noted; each task is small
and test-first, no broad refactor.

### Task 1 - Video provider + model authoring; honor the stored provider on the manual path
- Problem/outcome: the UI cannot pick `fal`, there is no video-model field, and the
  manual `Generate Video` path ignores the stored provider (resolves `local`/`openai`).
  Outcome: a user can author provider `fal` + the i2v endpoint and trigger it from the
  normal UI, with mock/real policy still enforced.
- Files/functions: `lib/constants.ts:40` (add `fal` to `GENERATION_PROVIDERS`),
  `components/project/project-workspace.tsx:1781-1837` (add a video/enum model input),
  `app/api/projects/[id]/scenes/[sceneId]/generate-video/route.ts:24-27` and
  `video-generation-service.ts:151-160,318` (accept/derive provider from the request
  or the scene record), `components/project/project-workspace.tsx:587-591,878-882`
  (send the override).
- Tests: route/service test that a stored/overridden `fal` provider is honored and
  that mock still rejects it; component test for the new controls.
- Deps/risks: depends on nothing; risk = must not create a policy bypass (provider
  override must still funnel through `resolveManualGenerationProvider`).

### Task 2 - Start/end frame authoring for video scenes (+ reference-set sync)
- Problem/outcome: `startFrameReferenceId`/`endFrameReferenceId` are not authorable,
  and `generation.referenceIds` can drift from `scene.referenceIds`. Outcome: pick a
  start (and optional end) frame from project references; the designated frame is
  always part of the effective reference set.
- Files/functions: `components/project/project-workspace.tsx:102-116` (seed/clear
  frames), `:1989-2011` (reference toggles), video visual block (`:1781-1910`) add
  selectors; keep `generation.referenceIds` and `scene.referenceIds` consistent
  (`video-generation-service.ts:320`).
- Tests: component test (frame ids rendered, validated, cleared on visual change);
  service/normalization test that a toggled reference keeps the frame valid.
- Deps/risks: builds on Task 1's provider field placement; risk = the sync rule must
  be a single source of truth to avoid the current drift bug.

### Task 3 - Explicit video aspect policy + crop/letterbox decision
- Problem/outcome: `cover + center-crop` is implicit and duplicated; i2v clips can be
  cropped ~15.6% silently. Outcome: one documented policy (`cover` default, optional
  `contain`/pad) used by both renderer and compositor.
- Files/functions: `lib/render/renderer.ts:193-203`,
  `lib/render/video-compositor.ts:100-125` (extract a shared fit helper), types
  (`lib/types/render.ts` / render settings), `video-composition-service.ts:174-176`
  (keep canvas-size output invariant).
- Tests: renderer + compositor arg tests for both `cover` and `contain`; an
  integration render of a 3:2 source into 16:9 asserting the chosen behavior.
- Deps/risks: independent; risk = `contain` must still emit canvas-sized segments or
  composition's `INCOMPATIBLE_RENDER` check fails.

### Task 4 - Warn when a video source/frame aspect differs from the canvas
- Problem/outcome: users get no signal that cropping will occur. Outcome: a validation
  warning (like the existing duration-mismatch warning) when aspect differs.
- Files/functions: `lib/render/scene-resolver.ts:80-90` (add a warning),
  `lib/validation/project-validation.ts` if surfaced in project validation.
- Tests: resolver/validation test with a mismatched-aspect generated video.
- Deps/risks: complements Task 3; low risk.

### Task 5 - Prevent duplicate paid submit after a transient poll failure
- Problem/outcome: a poll error marks the attempt `failed` (job id retained), after
  which a new run re-submits. Outcome: the retained live job is resumed, not
  re-submitted; a genuinely terminal failure is distinguishable.
- Files/functions: `lib/generation/video-generation-service.ts:508-542` (distinguish
  transient poll error from terminal failure; keep status active or a dedicated
  non-retryable state), `lib/production/production-planner.ts:233-236,247-266`
  (do not mark submit `ready` when a retained job id exists), `lib/production/run-recovery.ts:56`
  (treat retained-job `failed` as resumable).
- Tests: extend `fal-video-service.test.ts` (poll failure does not resubmit) and add
  a run-level test (new run after poll failure polls, does not submit).
- Deps/risks: highest-value reliability fix; risk = must not strand a genuinely dead
  job - pair with a bounded resume attempt and clear terminal error.

### Task 6 - MCP `fal` parity (and evaluate a direct MCP video tool)
- Problem/outcome: MCP cannot select `fal`. Outcome: `run_production` accepts
  `video: 'fal'`; optionally expose a direct video-generate/poll MCP tool matching the
  HTTP routes.
- Files/functions: `mcp/production/tools.ts:18`, `mcp/production/api-client.ts:28`,
  `mcp/production/types.ts`; new authoring tool if in scope.
- Tests: `tests/mcp-production.test.ts` fal case; a stdio integration case if a new
  tool is added.
- Deps/risks: small; risk = keep the MCP and HTTP enums in lockstep.

### Task 7 - Wire cancellation for in-flight FAL jobs
- Problem/outcome: `cancel` exists but is never called; stopping a run/process leaves
  a paid job running. Outcome: an explicit cancel path (route + service) using
  `provider.cancel`, policy-guarded.
- Files/functions: `video-generation-service.ts` (new `cancelSceneVideoGeneration`),
  a new route (e.g. `app/api/projects/[id]/generation-jobs/[attemptId]/cancel/route.ts`),
  optional run-cancel propagation; adapter `fal-provider.ts:651-677` (exists).
- Tests: service cancel test (calls cancel once, updates attempt), route test,
  real-mode gating test.
- Deps/risks: independent; risk = cancellation semantics/idempotency for a job that
  just completed.

### Task 8 - Cross-cutting tests: UI, MCP, and mismatched-aspect composition
- Problem/outcome: the parity/behavior gaps above lack regression coverage. Outcome:
  a focused test batch proving provider/frame authoring, MCP `fal`, and mismatched-aspect
  crop/contain.
- Files/functions: `tests/project-workspace-*.test.tsx`, `tests/mcp-production.test.ts`,
  `tests/local-ffmpeg-renderer.test.ts`, `tests/video-compositor-args.test.ts`,
  `tests/video-composition-service.integration.test.ts`.
- Tests: as listed.
- Deps/risks: depends on Tasks 1-4,6; risk = none, pure coverage.

Suggested order: **1 -> 2 -> 4 -> 5 -> 3 -> 6 -> 7 -> 8** (unblock workflow, then
make the safety/robustness fixes, then the larger composition policy change, then
parity/cancel, then the coverage batch).

---

## 8. Verification commands and results

All checks were local and non-paid.

- Repository state **[run]**:
  - `git rev-parse --abbrev-ref HEAD` -> `main`
  - `git rev-parse HEAD` -> `b9d7a8043729ade1d3d4266f52aabd0aee35bfed`
  - `git rev-parse origin/main` -> `b9d7a8043729ade1d3d4266f52aabd0aee35bfed` (equal)
  - `git status --porcelain` -> only untracked recon docs (`p29`, `p29.2`, `p31`,
    `p33`, `p35`, `p37`, `p38`, `p40`, `p42`, `p43`, `p44`); no tracked change; no
    `.gitmodules`.
- Enum/constant checks **[run]**:
  - `constants.ts:6` `SCENE_TYPES` includes `video`; `constants.ts:40`
    `GENERATION_PROVIDERS` = `['openai','gemini','local','other']` (no `fal`).
  - HTTP `production-runs/route.ts:17` `video: z.enum(['local','openai','fal'])`;
    MCP `mcp/production/tools.ts:18` `video: z.enum(['local','openai'])`.
  - `rg "\.cancel\(" lib app mcp components` -> only the definition in
    `fal-provider.ts:651` (no caller).
- Targeted local tests **[run]**:
  `npx vitest run tests/video-generation-service.test.ts tests/fal-video-service.test.ts
  tests/run-recovery.test.ts tests/production-planner.test.ts
  tests/video-compositor-args.test.ts tests/video-provider-registry.test.ts
  tests/run-policy.test.ts` -> **7 files / 87 tests passed** (no network; all use
  injected fetch / fixtures).

---

## 9. Summary

The backend i2v chain (types, normalization, validation, service, FAL adapter,
storage, run polling/resume, mock/real/credential gating, log redaction) is complete
and well tested. The path from the **normal workflow** to FAL image-to-video is
blocked only by missing authoring (provider `fal`, video model, start/end frames) and
by the manual route ignoring the stored provider. Secondary, higher-value risks are
the implicit center-crop of mismatched-aspect video (~15.6% for P44), a
transient-poll-failure path that can re-submit a paid job on a new run, MCP lacking
`fal`, and cancellation being unwired. P46 is a GO with the 8-task plan above,
best split into an unblock phase (tasks 1-2) and a correctness/robustness/parity
phase (tasks 3-8).

Confirmation: **no code was changed, no commit or push was made, no configuration was
modified, and no paid provider call was executed.** Only read-only inspection, one
targeted local (mock/fixture) test run, and `git` queries were performed. Untracked
recon docs and gitignored `projects/` data were left intact. Stopping here for review.
