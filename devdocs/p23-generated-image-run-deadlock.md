# P23 (deadlock follow-up) — generated-image production run deadlock

Status: **fixed and verified.** Root cause confirmed as **duplicate execution of
the same run by independent Next.js route worker processes**, not the render /
composition status derivation suspected in `p22.2-claim-security-and-scenario-d-results.md` §7.
Fix: a cross-process **execution lock** on the run store, acquired before a run
is executed and honored by recovery. Verified in a real `next dev` server: an
image-only project now reaches `completed`, produces exactly one image asset and
one composition, and leaks no lock files. The blank-scene flow is unchanged.
No commit or push; existing reports left untouched.

> Naming note: `p23-tts-format-duration-fix.md` is an unrelated, earlier task
> also labelled "P23". This file is the deadlock follow-up specifically called
> out as a separate task in `p22.2-…-results.md` §7 "Proposed fix (separate task)".

---

## 1. Symptom

A production run for a project containing a `generated_image` scene ended
`unresolved` with `final_compose` stuck `waiting_dependency`, so no MP4 was
produced, while a structurally identical `blank` scene completed. Reported in
`p22.2-claim-security-and-scenario-d-results.md` §7
(observed summary `{completed:3, waiting:1}`, `failedActionIds:[]`,
`get_project_compositions.available:false`).

## 2. Root cause (revised from the §7 hypothesis)

§7 hypothesised a render/composition status deadlock inside
`production-planner.ts` (`deriveSceneRenderStatus` vs `compositionReadiness`).
That hypothesis is **incorrect**. Both derivations are internally consistent;
the real cause is **two executions of the same run**, which invalidates the
render fingerprint mid-flight.

Mechanism:

1. In `next dev`, every API route is served by a **separate worker process**
   with its own module instance. Each `HeadlessProductionRunService` singleton
   is constructed with `autoRecover` enabled and runs `recoverRuns()` on
   construction.
2. A run is created and started by the `POST /api/projects/:id/production-runs`
   worker. When any other worker (e.g. the `GET /api/production-runs/:runId`
   worker that the status polling hits) constructs its singleton, `recoverRuns`
   sees the persisted run still `running` and, because the in-memory "active"
   set is per-process, calls `executeRun` **again**.
3. The second execution replans and re-runs `image_generate`. The regenerated
   image receives a **new `assetId`**, which is part of the scene render
   fingerprint (`createSceneRenderFingerprint` → `scene.source.assetId`).
4. The first execution had already persisted a `completed` render keyed to the
   **old** `assetId`. After regeneration the stored render fingerprint no longer
   equals the current fingerprint, so the render is treated as **stale** and
   `final_compose` waits on it forever. The runner will not re-execute an action
   id already in `completedActionIds`, so the run stops `run_stopped_unresolved`.

Evidence collected (mock providers, no browser):

- `diag.mts`: for the image-only project, the stored
  `render.completed.renderFingerprint.scene.source.assetId` differs from the
  `currentFingerprint…assetId` → `isStale`; the blank-only project is
  consistent.
- `p23_repro.mjs` (MCP `run_production` + polling `get_run_status`): terminal
  `unresolved`, `{completed:3, waiting:1}`, **4 assets (2 image + 2 audio)** =
  double generation, `composed:false`.
- `p23_noget.mjs` (HTTP POST + disk poll, **no** status endpoint): terminal
  `completed`, `{completed:4}`, **2 assets (1 image + 1 audio)**, `renders:1`,
  `composed:true`.
- `p23_single.mts` (direct in-process service): `completed`, 1 image asset.
- `p23_two_instance.mts` (two service instances over the same `FileRunStore`):
  `runBatchCalls = 2` before the fix.
- Debug output (`EXPLAINER_RUN_DEBUG=1`) showed a **distinct PID per route
  bundle**, all `threadId 0`, `hasGlobal true` but **not shared** — confirming
  worker processes do not share module/`globalThis` state, which rules out any
  in-memory guard.

## 3. Fix

Cross-**process** mutual exclusion on run execution, backed by the filesystem
(shared by all workers), plus recovery that defers to a live owner.

### `lib/production/run-store.ts`

- Extended the `RunStore` interface with two optional methods and a
  `RunExecutionLock` type:

  ```ts
  tryAcquireExecutionLock?(projectId, runId): Promise<RunExecutionLock | null>;
  isExecutionLocked?(projectId, runId): Promise<boolean>;
  ```

- Implemented both on `FileRunStore`. The lock is a `<runId>.lock` file next to
  `<runId>.json` under the project runs root, created atomically with
  `fs.open(path, 'wx')` and containing `{ pid, startedAt }`.
  - If the create succeeds, the caller owns the run; `release()` closes the
    handle and unlinks the file.
  - If the create fails with `EEXIST`, the owner is checked with
    `isExecutionLocked`. A **live** owner (`process.kill(pid, 0)`, treating
    `EPERM` as alive) makes acquisition return `null`. A **dead/absent** owner
    lets the file be reclaimed and the create retried **once**.
  - `isExecutionLocked` returns `false` on missing/corrupt/pid-less lock files.

### `lib/production/run-service.ts`

- `executeRun` now acquires the lock before doing any work:

  ```ts
  const lock = this.runStore?.tryAcquireExecutionLock
    ? await this.runStore.tryAcquireExecutionLock(projectId, runId)
    : { release: async () => {} };
  if (!lock) return;           // another worker owns this run
  try { await this.executeRunInternal(...); }
  finally { await lock.release(); }
  ```

  The previous body of `executeRun` was moved to `executeRunInternal`. Stores
  without the optional methods (unit-test doubles) keep the plain
  single-instance behaviour.
- `recoverRun` returns early (imports the snapshot only) when the run is locked
  by a live owner, so a second worker never reconciles or re-executes a run in
  progress:

  ```ts
  if (this.runStore?.isExecutionLocked && await this.runStore.isExecutionLocked(entry.projectId, runId)) {
    return this.registry.getRunUnsafe(runId);
  }
  ```

An earlier attempt using an in-memory `globalThis` guard was **abandoned** — it
cannot work across worker processes (proven by the per-PID debug evidence).

## 4. Regression tests

Added to `tests/run-recovery.test.ts` (existing helpers reused: `FileRunStore`
temp root, `mutableStore`, `SERVICE_CONFIG`, `waitForStatus`, `flushPersists`):

- **"does not re-execute a run another instance is already executing"** — a
  gated `runBatch` holds instance A; constructing instance B and calling
  `recoverRuns()` must not enter a second batch, the run must still be readable
  through B, the lock must be held while running, and released after completion.
- **"reclaims a stale lock left by a dead process and resumes the run"** — a
  lock file with a dead PID (2_147_480_000) must be reclaimed; recovery resumes
  and the stale lock is removed.

`tests/run-recovery.test.ts`: 20/20 pass (18 previous + 2 new).

## 5. Verification results

Commands run (mock providers, `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=false`):

| Step | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | clean |
| Targeted | `npx vitest run` (production-run-service, production-runner, production-planner, run-recovery, run-store) | 46/46 pass |
| Full suite | `npm test` | 738/738 pass (98 files) |
| Lint | `npm run lint` | no warnings/errors |
| Build | `npm run build` | success; `/projects/[id]` 49.4 kB / 152 kB |

Real `next dev` end-to-end (fresh server, mock):

- **Image-only** (`/tmp/opencode/p23_repro.mjs`, MCP + status polling, project
  `project_48786578-…`): `status=completed`, 4 actions completed,
  `image attempts=1` (no duplicate generation), assets `2` (1 image + 1 audio),
  `renders=1`, `composed=true`, no `.lock` files left.
- **Blank-only** (`/tmp/opencode/p23_blank.mjs`, project `project_1404e938-…`):
  `status=completed`, 3 actions completed, `composed=true`, no `.lock` files.
- Before the fix, the same image-only repro produced `unresolved`,
  `{completed:3, waiting:1}`, 4 assets (2 image) and `composed=false`.

The image-only run's event log now shows `final_compose` executed exactly once
(`composition_started` → `composition_completed`) followed by `run_completed`.

## 6. Notes and follow-ups

- A separate, unrelated defect observed while repro-ing: a direct
  `POST /api/projects/:id/scenes/:sceneId/generate-image` with the **real**
  `openai` provider returns 422 `"Unknown parameter: 'response_format'."`
  (`provider.request.rejected`). The mock path is unaffected. Out of scope here.
- The lock file is intentionally left in place if a process is killed mid-run;
  the next recovery in any worker reclaims it because the owning PID is dead.
- `RunStore` consumers that do not implement the optional lock methods keep the
  previous single-instance semantics (unit tests, alternate stores).

## 7. Test data created (kept for inspection; nothing deleted)

- `project_62227a0a-…`, `project_48786578-…` — image-only, `completed`,
  composed.
- `project_804ccd4e-…` (image-only, pre-fix `unresolved`), `project_e9211c8d-…`
  (blank, empty narration text → blocked narration, composition still produced),
  `project_1404e938-…` (blank, completed).
- Repro drivers: `/tmp/opencode/p23_repro.mjs`, `/tmp/opencode/p23_noget.mjs`,
  `/tmp/opencode/p23_blank.mjs`, `/tmp/opencode/p23_single.mts`,
  `/tmp/opencode/p23_two_instance.mts`, `/tmp/opencode/diag.mts`.
