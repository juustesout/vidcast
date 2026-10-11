# P27 Production Run Lifecycle Robustness

Status: IMPLEMENTED. Targeted fixes for the three lifecycle risks identified in
`p26-production-workflow-recon.md` (R1-R3), with deterministic regression tests.
No real-provider or paid calls, no real-provider mode, no MCP/schema/dependency/
UI changes, no commits or pushes, no destructive Git operations.

---

## 1. Scope and changed files

Changed only the run-lifecycle code and its tests:

| File | Change | Type |
| --- | --- | --- |
| `lib/production/run-service.ts` | R1/R2/R3 fixes + bounded refresh retry | modified (+115/-25) |
| `tests/production-run-lifecycle.test.ts` | Deterministic regression tests | new |

Nothing else was modified. `git diff --stat` reports one tracked file changed;
Git HEAD is unchanged (`99bb619`), and all pre-existing untracked reports are
preserved.

---

## 2. Fix per risk

### R1 — Concurrent double-start for the same project

**Problem (before):** `startOrReuseRun` checked `getActiveRunByProject`, then
`await`ed `store.getProject`, then created the run. Between the check and the
create there was a yield point, so two near-simultaneous requests could both pass
the check and each create a run for the same project.

**Fix:** Split the method into a synchronous reservation and the async work:

- `startOrReuseRun` validates input, checks for an existing active run (unchanged
  reuse behaviour), then consults a new `pendingStarts: Map<projectId, Promise>`
  reservation.
- If a pending start exists for the project, the second caller awaits it and
  returns the same run with `reused: true`.
- Otherwise it calls `performStart(...)` and stores the returned promise in
  `pendingStarts` **synchronously, before its first `await`**, so a request
  arriving in the same tick always observes the reservation.
- The reservation is removed in a `finally` once the start resolves.

The actual start logic (`performStart`) is behavior-preserving: project lookup,
policy resolution/preflight, config resolution, `registry.createRun`, queue push,
dispatch scheduling. Reuse semantics for an already-active run are unchanged.

### R2 — Run stuck in `running` on a project read error

**Problem (before):** `executeRun` set status to `running` and then read the
project **outside** the `try` block. If that read threw, the worker promise
rejected (the dispatch loop only attached `.finally`), leaving the run
permanently `running`.

**Fix:**

- The initial project read is now the first statement inside `executeRun`'s
  `try`, so any thrown read error flows through the existing catch, which emits
  the `run_failed` event and sets the terminal `failed` status.
- The dispatch loop now attaches `.catch(() => {})` before `.finally(...)` as a
  defensive guard, so a worker can never surface as an unhandled rejection.

The pre-existing `null` path (project genuinely absent) still marks the run
`failed` with a distinct message.

### R3 — Transient `refreshProject` null aborting the run

**Problem (before):** `refreshProject` threw `RunServiceError(NOT_FOUND)` the
instant a mid-run project read returned `null`, aborting an otherwise healthy
run.

**Fix:** Introduced `readProjectWithRetry(projectId)` with a **bounded** budget
(`RunServiceConfig.refreshRetry?: { attempts; delayMs }`, default
`{ attempts: 3, delayMs: 100 }`, clamped to `attempts >= 1`, `delayMs >= 0`).
It retries both `null` results and thrown reads, then returns a discriminated
result `{ ok: true, project } | { ok: false, reason: 'not_found' | 'error' }`.

- It is reused for the initial read and for `refreshProject`.
- `refreshProject` only throws when the bounded budget is exhausted, preserving
  deterministic termination (no infinite polling/retries).
- Reads never overlap more than `attempts` times per call.
- Delay is injected via `ServiceDependencies.delay` (default `setTimeout`), so
  tests run without timing dependence.

### R4 — `partial` result status effectively unreachable (documented, no change)

Confirmed by inspection: `determineResultStatus` (`production-runner.ts:208-219`)
returns `partial` only when `unresolvedActions.length === 0 && failedCount > 0`,
but the planner re-marks previously failed actions with status `failed`
(`production-planner.ts:157-158,209-210,250-251,272-273,328-329,397-398`), which
`unresolvedActions` does **not** filter out (`production-runner.ts:504,536`). So
a failed action keeps the run at `failed` before `partial` is reached; `partial`
only surfaces if a failed action disappears from the replanned set.

This is orthogonal to R1-R3, so per scope the status model was left unchanged and
is recorded here as a separate follow-up subject (reconcile
`determineResultStatus` with the planner's failed-action semantics).

---

## 3. Tests

New deterministic file `tests/production-run-lifecycle.test.ts` (5 tests). It
uses a scripted `getProject` sequence and an injected no-op `delay`, so no test
depends on wall-clock timing.

| Test | Covers | Assertions |
| --- | --- | --- |
| coalesces concurrent starts for the same project onto a single run | R1 | same `runId`, exactly one `reused=false`, second request never reads the project (`readCount === 1`) |
| does not leave a run stuck in running when the pre-execution project read throws | R2 (before execution) | terminal `failed`, `finishedAt` set, `runBatch` never called, bounded reads (`=== 4`), diagnostic `run_failed` message `/could not be read/i` |
| recovers from a transient refreshProject null and completes the run | R3 (transient) | status `completed`, bounded reads (`=== 4`), no `run_failed` event |
| fails a run after a bounded number of attempts when refreshProject stays null | R3 (persistent) | terminal `failed`, reads `=== 5`, message `/during run refresh/i` |
| fails a run when refreshProject reads throw persistently, without hanging | R2/R3 (during execution) | terminal `failed`, reads `=== 5`, message `/could not be read during run refresh/i` |

Existing recovery/lifecycle coverage is preserved and still green:
`tests/production-run-service.test.ts` (incl. duplicate sequential start reuse,
queued runs, NOT_FOUND) and `tests/run-recovery.test.ts` (persist/reload,
resume, idempotent recovery, supersede duplicates, GHOST project fails, corrupt
file ignored).

---

## 4. Verification results

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | clean (no output) |
| `npm run lint` (`next lint`) | No ESLint warnings or errors |
| `npm run build` (`next build`) | succeeded; all routes compiled |
| `npx vitest run` (full suite) | 67 files, 394 tests passed (was 66/389; +1 file, +5 tests) |

Targeted run of the lifecycle + service + recovery files: 3 files, 25 tests
passed.

---

## 5. Remaining limitations

- Retry budget uses a fixed injected delay (no exponential backoff/jitter); a
  transient outage longer than `attempts * delayMs` still fails the run by
  design (deterministic termination).
- R2's initial read is now retried too, so a genuinely missing project fails
  after the bounded budget rather than on the first read. Default extra latency
  on failure is `(attempts - 1) * delayMs` (max 200 ms).
- R4 (`partial` status) remains as-is and is documented as a separate follow-up.
- Recovery is still triggered lazily from the service constructor (P26 item
  5); out of scope for this phase.
- No end-to-end production run or real provider call was executed; correctness
  is established by unit/integration tests and the full existing suite.

---

## 6. Git status

- Branch `main`; HEAD `99bb6190130d69f324188875a47a0450a175d6ba` (unchanged).
- Modified: `lib/production/run-service.ts`.
- New: `tests/production-run-lifecycle.test.ts`.
- Untracked pre-existing reports preserved (p15, p17, p18, p20, p22, p23, p24,
  p25.1, p26, project-baseline).
- No commits or pushes were made.
