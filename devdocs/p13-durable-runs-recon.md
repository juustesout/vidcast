# P13 Recon - Durable Production Runs

Status: recon only. No code changed in this step. Scope is limited to making
headless production runs survive a server restart. No audio work, no new
director logic, no P14+ items.

## 1. How runs execute today

- A single process-wide service is created at module load:
  `headlessProductionRunService` (`lib/production/run-service.ts:660`).
- All run state lives in `InMemoryRunRegistry`
  (`lib/production/run-registry.ts:57`): a `Map<runId, StoredRun>` plus an
  `activeByProject` map. Each entry holds the snapshot, accepted policy/limits,
  progress counters, `completedActionIds`, `failedActionIds`, `unresolvedActions`
  and the event log (with cursor pagination).
- Scheduling state is also in memory only (`run-service.ts:207-209`): the
  `queue` array, `activeWorkers`, `dispatchLoopScheduled`.
- The runner is plan-driven and idempotent against project state. Each iteration
  re-derives the plan from the current project (`production-runner.ts:280-287`)
  and filters out already-completed action ids (`production-runner.ts:369-371`).
  So "resume" is fundamentally: re-derive from persisted project state and run
  whatever is not yet current.
- The plan itself already understands in-flight video jobs: a `video_poll`
  action is only emitted when the attempt is active and has a `providerJobId`
  (`production-planner.ts:244-257`).

## 2. What is already persisted (on disk)

`project.json` per project via `projectStore` (`lib/storage/project-store.ts`),
written by the generation services:

- Visual generation record per scene: `status`, `provider`, `model`,
  `providerJobId`, `providerStatus`, `assetId`, `error*`, timestamps, plus the
  `attempts[]` history (`lib/types/scene.ts:106-118`).
- Narration record: `status`, `audioAssetId`, `lastAttemptId`, `attempts[]`
  (`lib/types/scene.ts:40-69`).
- Scene renders (`renders[]`), compositions (`compositions[]`), assets list.
- Assets are reconciled against disk on read (`project-store.ts:626`).

Media bytes live under `projects/<id>/{assets,renders,previews}`.

## 3. What is lost on restart

- Every run record: snapshot, accepted policy, progress, completed/failed ids,
  unresolved actions, event log. `getRun` then returns 404; the UI tracker
  already maps this to `restartLost` (`lib/client/production-run-tracker.ts:322`).
- The run queue and worker accounting. A run that was `running` simply vanishes.
- Per-project active-run dedupe (`activeByProject`), so a new run can be started
  after restart while an old persisted `running` run still exists.

The in-memory generation locks (`activeGenerationLocks`,
`activeSceneSubmitLocks`, `activeAttemptPollLocks`, `activeNarrationLocks`)
reset correctly; they are not a correctness risk across restart.

## 4. Failure windows that block a clean resume

1. Video submit crash after the `queued` write but before `providerJobId` is
   stored (`video-generation-service.ts` writes queued, then calls
   `provider.submit`, then writes `providerJobId`). Persisted state is
   `queued` with no job id, so the planner marks `video_submit` as `running`
   and emits no `video_poll` (`production-planner.ts:199,244`). The scene is
   stuck forever.
2. Image generation crash mid-call: persisted `queued`/`generating` with no new
   asset. Planner marks it `running`, no worker exists. Stuck.
3. Narration crash mid-call: persisted narration `generating`. Planner marks it
   `running`. Stuck.
4. Browser state: the client tracker keeps `runId` in React state only; there is
   no way to re-attach to a run after a page reload even when the run still
   exists on the server.

## 5. Concrete implementation proposal

### 5.1 Durable run store (new)

- Add `lib/production/run-store.ts`: a file-backed store with the same shape the
  registry needs (snapshot + `events` + `eventOffset`), one JSON file per run at
  `projects/<projectId>/runs/<runId>.json`. Add `getProjectRunsRoot` /
  `getRunJsonPath` to `storage-paths.ts`. Writes are atomic (temp file + rename).
- Wire persistence into `InMemoryRunRegistry` through an optional store adapter
  so unit tests keep using the pure in-memory path, and only the production
  singleton persists. Persist on `createRun`, `updateRunStatus`,
  `updateProgress`, `appendEvent` (writes can be coalesced per run).
- Persist `activeByProject` implicitly by scanning non-terminal runs, so
  per-project dedupe survives restart.

### 5.2 Startup recovery (new)

- `HeadlessProductionRunService` gains `recoverRuns()` called once at
  construction (production singleton only; opt-in flag for tests).
- For every persisted run with status `queued` or `running`: reload it, reset
  it to `queued`, re-enqueue, and emit a `run_recovered` event. Terminal runs are
  loaded read-only so status/log endpoints keep working after restart.
- Recovery is idempotent: repeated calls find the same non-terminal set and do
  not create duplicate runs or duplicate queue entries; a persisted
  `activeByProject` guard prevents starting a second run for a project that
  already has a recovered active run.

### 5.3 Scene reconciliation (new)

- `lib/production/run-recovery.ts` normalizes crashed in-flight state before the
  first re-plan:
  - video attempt with `providerJobId` -> unchanged; the planner resumes with
    `video_poll`. No new provider job is created.
  - video attempt `queued`/`generating` without `providerJobId` -> mark
    `failed` (the provider never returned a job id, so no job exists to orphan);
    planner re-submits.
  - image/narration `queued`/`generating`:
    - if a usable persisted asset exists, restore status to `generated`
      (idempotent, no cost);
    - otherwise mark `failed`.
- Double-cost guard: interrupted actions that have no resumable job id are only
  auto-retried when the run's locked policy is `mock`. In `real` mode they are
  marked `failed` and left as unresolved output of the run; re-running them
  requires an explicit new user start. This keeps the "no double cost" rule.

### 5.4 API surface

- No new mandatory endpoint: the existing `POST /api/projects/[id]/production-runs`
  returns the recovered active run via `startOrReuseRun` because recovery has
  already registered it. `GET /api/production-runs/[runId]` and `/log` keep
  working for both recovered and terminal runs.
- Optional: `GET /api/projects/[id]/production-runs` to list the active/recent
  runs for a project, so the UI can re-attach after reload. Marked optional to
  bound scope.

## 6. Idempotency and safety rules

- One active run per project, persisted, enforced at recovery and at start.
- `updateProject` calls are already last-write-wins snapshots; the reconciler
  runs before any action so it cannot race a live worker (single process).
- Provider jobs are only resumed through `providerJobId`; the planner already
  suppresses `video_submit` while an attempt is active with a job id.
- Recovery never fabricates assets; it only downgrades crashes to `failed` or
  restores an already-persisted asset reference.

## 7. Tests to add

- `tests/run-store.test.ts`: round-trip persist/load, atomic write, corrupt file
  ignored, non-terminal selection.
- `tests/run-recovery.test.ts`: restart simulation with a second service
  instance and a temp projects dir; a `running` run is recovered and reaches a
  terminal status; video attempt with `providerJobId` resumes via poll and never
  calls `submit`; image/narration interrupted states reconcile as designed;
  real-mode interrupted action is not auto-retried.
- Idempotency: calling `recoverRuns()` twice, and starting a run for a project
  that already has a recovered active run, yields no duplicates.
- Error handling: missing project, malformed run JSON, project without runs dir.
- Keep existing suites green (run-service, run-registry, production-runner,
  client tracker, API security boundary).

## 8. Bounded scope / out of scope

In scope: durable run store, startup recovery, scene reconciliation, idempotent
resume, resume-via-job-id, tests, and a short delivery report.

Out of scope: multi-process/distributed locking, auth changes, new provider
integrations, audio/subtitle/music work, new director or planning logic,
UI redesign beyond optional run listing, and any P14+ feature.

## 9. Risks

- File-store concurrency: acceptable for the current single-process local app;
  a cross-process lock is explicitly out of scope.
- Real-mode interrupted generations are not auto-retried by design; the run ends
  unresolved and requires an explicit restart. This is a deliberate cost-safety
  tradeoff and will be documented.
- Recovery runs on module import, so tests that import the singleton must use a
  temp projects root or disable persistence to avoid touching the real dir.
