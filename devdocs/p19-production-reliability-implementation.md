# P19 Production Reliability Implementation

Status: implemented and verified. Commit: `21d9c8d`.

This change addresses the two reliability defects confirmed by the P19 recon:

1. Concurrent writers to the same `project.json` could interleave/interleave-truncate, corrupting the file, and read-modify-write callers could silently lose updates.
2. FFmpeg failures were classified only by `exitCode === undefined`, so a **timeout** was misreported as `FFMPEG_UNAVAILABLE` (a "missing binary"), and render/compose timeouts were hard-coded with no bounded override.

## 1. Safe project writes

Design: a single in-process write path in the central store, combining per-project serialization with an atomic write. This mirrors the existing `FileRunStore.save` temp+rename precedent.

- `lib/utils/keyed-mutex.ts`: minimal per-key async mutex (`withKeyedLock`). Operations sharing a key run strictly in call order; keys are removed when their queue drains.
- `lib/storage/project-store.ts`:
  - `writeProjectFile` now writes to `project.json.tmp-<pid>-<ts>-<rand>` and `fs.rename`s it into place, removing the temp file on any failure. A reader therefore never observes a partially written or interleaved file.
  - `createProject`, `updateProject`, `claimUnownedProjects`, and all media methods now run under `withKeyedLock('project:<id>', ...)`.
  - New `mutateProject(projectId, mutator)` performs the full read-modify-write **inside** the lock on the freshest on-disk state and returns the persisted project (or `null` if the project no longer exists). This is the mechanism that prevents lost updates: atomic writes alone stop corruption but not stale-overwrite loss.
  - `readProjectFile` now distinguishes a genuinely missing file (`ENOENT` -> `null`) from an unreadable/corrupt file, which raises `ProjectReadError` (`code: 'PROJECT_READ_FAILED'`). `listProjects`/`claimUnownedProjects` log and skip unreadable projects instead of silently treating them as absent.

### Writers migrated to `mutateProject`

All read-modify-write writers now re-apply their change to fresh state under the lock:

- `lib/generation/image-generation-service.ts`
- `lib/generation/narration-service.ts`
- `lib/generation/video-generation-service.ts`
- `lib/generation/music-service.ts`
- `lib/render/scene-render-service.ts`
- `lib/render/video-composition-service.ts`
- `lib/security/access-control.ts`, `lib/security/page-access.ts` (legacy owner-claim)
- `lib/production/run-service.ts` (recovery reconciliation; prefers `mutateProject`, falls back to `updateProject` for injected stores)
- Routes `app/api/projects/[id]/route.ts`, `scene-intents/plan`, `scene-intents/materialize` apply the patch inside the lock (`ProjectUpdateValidationError` added to `lib/projects/project-update.ts` so validation aborts the write).

Boundary: the lock is **in-process only** — correct for the single-process Next.js server. It is not a cross-process/OS lock and not a substitute for a database; this limitation is documented for HTTP server and migration paths.

## 2. Accurate FFmpeg diagnostics and bounded timeouts

- `lib/render/ffmpeg-executor.ts`: `ProcessExecutionError` now carries `reason: 'spawn_error' | 'timeout' | 'exit' | 'signal'`, `signal`, and a derived `unavailable` getter. On timeout the child is sent `SIGKILL` and the promise only settles after the `close` event (with a 5 s safety grace) so the failure is reported after termination is confirmed.
- `lib/render/render-timeouts.ts` (new): bounded, configurable timeouts.
  - `RENDER_SCENE_TIMEOUT_MS` (default `60000`)
  - `RENDER_COMPOSE_TIMEOUT_MS` (default `180000`)
  - `RENDER_PROBE_TIMEOUT_MS` (default `30000`)
  - Values are parsed as positive integers and clamped to `[1000, 1800000]`; invalid input falls back to the default.
- `lib/render/renderer.ts`: `SceneRenderErrorCode` gains `FFMPEG_TIMEOUT`; scene render uses `RENDER_SCENE_TIMEOUT_MS`; error mapping is by `reason` (spawn -> `FFMPEG_UNAVAILABLE`, timeout -> `FFMPEG_TIMEOUT`, exit/signal -> `FFMPEG_FAILED`). `ffprobe` failures are split the same way (`FFMPEG_UNAVAILABLE`/`FFMPEG_TIMEOUT`/`OUTPUT_INVALID`) instead of always `OUTPUT_INVALID`.
- `lib/render/video-compositor.ts`: `VideoCompositionErrorCode` gains `FFMPEG_TIMEOUT`; all composition steps use `RENDER_COMPOSE_TIMEOUT_MS`; same reason-based mapping.
- `lib/render/ffprobe.ts`: `probeMedia` passes `RENDER_PROBE_TIMEOUT_MS`; `FFprobeError` carries the underlying reason.
- `lib/render/video-composition-service.ts`, `lib/production/run-service.ts`, `compose`/`render` routes: `FFMPEG_TIMEOUT` maps to HTTP `504`; `FFMPEG_UNAVAILABLE` maps to `503` (the direct scene-render route previously returned `500` for `FFMPEG_UNAVAILABLE`; now aligned with the run path).

## Tests

- `tests/project-store-concurrency.test.ts` (new): concurrent `mutateProject` calls lose no updates; 25 racing writers keep `project.json` valid and complete; a throwing mutator leaves the file untouched and writes no temp files; missing vs corrupt project distinguished (`null` vs `ProjectReadError`), and `listProjects` skips corrupt entries.
- `tests/render-process-diagnostics.test.ts` (new): `spawn_error`/`exit`/`signal`/`timeout` reasons; timeout kills the child and settles quickly; timeout config defaults/overrides/clamping; renderer maps missing binary -> `FFMPEG_UNAVAILABLE` and stall -> `FFMPEG_TIMEOUT`; stalling `ffprobe` cannot hang.
- Updated service test stores to implement `mutateProject`; added a 1080p render case to `tests/local-ffmpeg-renderer.test.ts`.

## Verification

- `npm run typecheck` — clean.
- `npm run lint` — clean.
- `npm run build` — succeeds.
- `npm test` — 62 files, 374 tests passing.
- Real FFmpeg smoke: blank-scene render at 720p and 1080p; multi-scene composition integration test — all pass with the new code.

## Remaining limits

- The per-project lock is process-local; a multi-process deployment would need an external lock/store.
- `ffprobe` timeout is configurable but validation still fails closed (`OUTPUT_INVALID`) only for non-spawn/non-timeout probe errors.
- Real-provider generation was not exercised (no paid calls); the mock-only constraint from prior phases still applies.
