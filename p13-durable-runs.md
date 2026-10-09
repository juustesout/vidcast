# P13 - Durable Production Runs

Status: implemented and verified. Production runs now survive a process restart
without double generation or cost.

## What changed

- `lib/storage/storage-paths.ts`: added `getProjectRunsRoot` and `getRunJsonPath`.
  Run files live at `projects/<projectId>/runs/<runId>.json`.
- `lib/production/run-store.ts` (new): `RunStore` interface and `FileRunStore`.
  Atomic writes (temp file + rename), one JSON envelope per run, tolerant
  loading (corrupt files are skipped), `listAll()` scans all projects sorted by
  creation time. Accepts an optional `projectsRoot` for tests.
- `lib/production/run-registry.ts`: exported `RunRegistryEntry`, added an
  optional `onChange` hook invoked after every mutation, and added
  `exportRun` / `importRun` for durable rehydration. `importRun` is a no-op for
  known runs and only promotes a non-terminal run to a project's active run when
  that project has no live active run.
- `lib/production/run-recovery.ts` (new): `reconcileInterruptedGenerations`
  normalizes in-flight state left behind by a crash.
- `lib/production/production-runner.ts`: added `initialFailedActionIds` to the
  batch input (seeded into the failed set, never executed) and two event codes
  (`run_recovered`, `run_superseded`).
- `lib/production/production-log-export.ts`: labels for the new event codes.
- `lib/production/run-service.ts`: optional `RunServiceOptions { runStore,
  autoRecover }`; debounced/atomic persistence on every run mutation;
  `recoverRuns()`; `flushPersists()`; recovery reconciles scenes before
  resuming; `executeRun` seeds the runner with the run's persisted failed ids;
  the production singleton now uses a `FileRunStore` and auto-recovers once on
  construction (disabled under `NODE_ENV=test` and during `next build`).

## Persistence format

```json
{ "version": 1, "run": { "...snapshot", "events": [], "eventOffset": 0 } }
```

The snapshot is the same `HeadlessRunSnapshot` exposed by the API plus the
sanitized event log and cursor offset. No secrets are added: events are already
sanitized by the registry before persistence.

## Recovery behavior

On startup the service imports all persisted runs (terminal runs stay queryable
via `GET /api/production-runs/[runId]` and `/log`) and then resumes every
non-terminal run:

1. Reconcile interrupted scenes (`reconcileInterruptedGenerations`):
   - video attempt with a `providerJobId`: left untouched; the planner resumes
     it with `video_poll` (no new provider submit);
   - active attempt with a usable persisted asset: restored to `generated`;
   - active attempt with neither: marked `failed`.
2. Mark any duplicate active run for the same project as `failed`
   (`run_superseded`).
3. Reset the run to `queued`, emit `run_recovered`, and re-enqueue it. The
   existing plan-driven runner re-derives from persisted project state, so
   already-completed work is not repeated.

Recovery is idempotent: repeated calls do not re-import or re-enqueue, and a
project can have at most one recovered active run.

## Cost safety

Per the agreed decision, an interrupted action that has no resumable job id is
only auto-retried when the run's locked policy is `mock`. In `real` mode the
reconciler marks the scene failed and adds the action id to the run's failed
set, so the resumed run surfaces it as failed instead of silently re-billing.
Video jobs that do have a stored `providerJobId` always resume via poll.

## Tests

New suites:

- `tests/run-store.test.ts`: round-trip, atomic overwrite, missing run, corrupt/
  unrelated file skipping, cross-project listing order, missing root.
- `tests/run-recovery.test.ts`: reconciler unit cases (video-with-job untouched,
  video-without-job failed + real-mode suppression, mock-mode no suppression,
  image restored from asset, narration failed + suppression, no-op); planner
  resume proof (video poll ready, submit not executed); service restart
  (persist-and-reload, recover-and-resume, idempotency, duplicate active run
  superseded, real-mode suppression end-to-end, missing project, corrupt file).

Results:

- `npx vitest run`: 209 passed, 2 failed. The 2 failures are the pre-existing
  FFmpeg render tests (`fake-image-provider-render`, `local-ffmpeg-renderer`)
  that fail because `ffmpeg` is not on PATH; unchanged from the P12 baseline.
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.

## Residual risks / out of scope

- Single-process assumption: writes are atomic but there is no cross-process
  lock. Acceptable for the current local app.
- Run files are not pruned from disk. In-memory terminal runs still expire per
  the registry retention; file pruning is deliberately out of scope.
- No project-level run listing endpoint (deferred by decision); the UI cannot
  yet re-attach to a recovered run after a browser reload.
- Real-mode interrupted work is not auto-retried by design.
