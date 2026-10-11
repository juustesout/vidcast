# P19 Production Reliability Recon

Status: RECON ONLY. No application code, tests, config, or dependencies were
changed. No commits. No paid API calls. All findings are derived by reading this
repository (source of truth) plus the P18 smoke report and the P18 artifacts
left on disk. Evidence is tagged:

- **[CODE]** established by reading the implementation.
- **[P18]** taken from `p18-hermes-e2e-smoke-report.md` and the P18 artifacts.
- **[HYP]** hypothesis / not yet proven; needs a controlled local test.

Objective: investigate the two reliability problems reproduced in P18 (project
write corruption, unpredictable FFmpeg rendering) and produce an evidence-based
implementation plan that keeps the existing architecture.

---

## 1. Scope and method

- Two subsystems: the project JSON write chain and the FFmpeg render/compose
  process chain.
- Method: trace every writer to `project.json`, model concurrency, then trace
  the scene-render and final-compose paths down to `spawn`/`kill`.
- The two problems are independent; they are treated separately below.

---

## 2. The project write chain

### 2.1 The single low-level writer

Everything that persists a project funnels through one function:

- `writeProjectFile(project)` — `lib/storage/project-store.ts:104-116`
  - `normalizeProject(...)` then `JSON.stringify(..., null, 2)`
  - `await fs.writeFile(getProjectJsonPath(id), payload, 'utf8')` at
    `lib/storage/project-store.ts:113`.
- `writeProject(project)` — `lib/storage/project-store.ts:577-584`: clones,
  stamps `updatedAt`, calls `writeProjectFile`.
- `JsonProjectStore.updateProject(project)` — `lib/storage/project-store.ts:638-640`:
  calls `writeProject`. **[CODE]**

There is **no temp file, no rename, no per-project mutex, and no write queue**
around this call. `fs.writeFile` opens the target with `O_TRUNC` and writes
in place. **[CODE]**

The read side is fail-open to `null`:

- `readProjectFile(id)` — `lib/storage/project-store.ts:72-81`: wraps
  `JSON.parse` in `try/catch` and returns `null` on any error. A corrupt
  `project.json` is therefore treated as "project not found" and silently
  skipped by `listProjects` (`project-store.ts:607-616`). **[CODE]** (matches
  P18 observation that the corrupted project vanished from the listing
  while `GET /api/projects` still returned 200). **[P18]**

### 2.2 Every write entry point

All of the following resolve to `writeProjectFile` (i.e. to the single
non-atomic `fs.writeFile`). None serialize against each other. **[CODE]**

| Writer | Location |
| --- | --- |
| PATCH project (REST) | `app/api/projects/[id]/route.ts:66` (read→merge→write) |
| scene-intent plan | `app/api/projects/[id]/scene-intents/plan/route.ts:40` |
| scene-intent materialize | `app/api/projects/[id]/scene-intents/materialize/route.ts:41` |
| scene render success path | `lib/render/scene-render-service.ts:99-109` |
| scene render failure path | `lib/render/scene-render-service.ts:64-89` |
| final composition | `lib/render/video-composition-service.ts:315-321` |
| image generation | `lib/generation/image-generation-service.ts:220,238,273,326` |
| narration generation | `lib/generation/narration-service.ts:236,270,304,350` |
| video generation | `lib/generation/video-generation-service.ts:304,344,372,482,608` |
| music generation | `lib/generation/music-service.ts:237,265,289,346,403,424` |
| legacy owner claim (API) | `lib/security/access-control.ts:91-98` |
| legacy owner claim (page) | `lib/security/page-access.ts:35` |
| run recovery reconciliation | `lib/production/run-service.ts:469-481` |
| asset/reference import & delete | `lib/storage/project-store.ts:672-758` |
| create / seed / claim | `lib/storage/project-store.ts:535-666` |

Every one of these is a **read-modify-write** of the *entire* project object:
read via `getProject`, mutate a slice, then overwrite the whole file. **[CODE]**

### 2.3 Concurrency model during a run

- `runProductionBatch` executes same-type actions concurrently:
  `executeBounded` uses `Promise.allSettled` on slices of size `limit` —
  `lib/production/production-runner.ts:228-254`.
- Default limits (`DEFAULT_CONFIG`, `production-runner.ts:120-130`): image 2,
  video_submit 2, video_poll 4, narration 2, scene_render 1, final_compose 1.
  Env-tunable in `run-service.ts:113-122` (`PRODUCTION_RUN_CONCURRENCY_*`) and
  override-able per run via `mergePerActionLimits` (`run-service.ts:142-158`).
- Consequence: with defaults, **two image generations and two narrations can
  mutate the same project simultaneously**, and each triggers (sometimes
  multiple) whole-file writes. **[CODE]**
- `refreshProject` between iterations is just `getProject`
  (`run-service.ts:614-622`); it does not reconcile concurrent revisions.

The composition layer already has a per-project in-memory guard,
`activeCompositionLocks` (`lib/render/video-composition-service.ts:23,279-283,330`),
but it only covers composition, not the project writes it and everything else
perform. **[CODE]**

### 2.4 A key precedent already in the repo

The durable run store already solved the identical problem for run files:

- `FileRunStore.save` writes to a unique temp path then `fs.rename`
  (atomic within a filesystem) — `lib/production/run-store.ts:82-85`. **[CODE]**
- `HeadlessProductionRunService` serializes per-run persistence with
  `schedulePersist`/`flushRun`/`persistQueue` — `run-service.ts:401-447`.
  **[CODE]**

So the minimal robust fix can mirror an existing, reviewed pattern rather than
introduce a new dependency.

---

## 3. Corruption root cause

### 3.1 What was observed

- P18 run 1: `projects/project_5ec5b7c3-.../project.json` unparseable,
  `Unexpected non-whitespace character after JSON at position 10610`. **[P18]**
- The file is 10615 bytes; valid JSON ends at byte 10610; the remaining tail is
  `\n} }\n}` (trailing bytes of a *longer* variant of the same JSON). **[CODE]**
  (re-inspected during this recon)

### 3.2 Proven mechanism (not merely the error name)

1. Two concurrent writers each call `fs.writeFile` on the same path. Each
   `open(..., 'w')` truncates the file to 0. If both opens complete before
   either `write` has flushed, both file handles have position 0. **[CODE]**
2. Writer A writes the *longer* payload (≈10615 bytes). Writer B writes a
   *shorter* payload (10610 bytes) over it starting at offset 0. A regular-file
   `write` does **not** truncate to the written length; it only overwrites the
   first N bytes in place. B's 10610 bytes overwrite A's first 10610 bytes, and
   A's trailing 5 bytes survive. **[CODE]**
3. Result = valid JSON for 10610 bytes + 5 residual bytes → exactly the observed
   offset-10610 parse error. **[CODE]** matches **[P18]**.

This is a **lost update plus a partial overwrite**, caused by (a) whole-object
reads/writes with no revision check and (b) non-atomic `fs.writeFile` with no
serialization.

### 3.3 Answers to the specific P19 questions

- Which operations wrote concurrently? In the corrupted run, image/narration
  generation actions can run at concurrency 2 (defaults) and each writes the
  whole project; `requireProjectAccess` also writes when it claims an owner and
  runs on nearly every request. **[CODE]**
- Can one write overwrite another's change? Yes. Whole-object overwrite with no
  version/merge ⇒ last-writer-wins for any field (e.g. two scene render records
  cannot both be appended reliably). **[CODE]**
- Can a process end mid-write? `fs.writeFile` is not atomic. A crash/`SIGKILL`
  between truncate and full write leaves a truncated or partially written file.
  **[CODE]** (The P18 bytes show *interleaving*, not a crash, but the crash case
  is a strictly easier way to reproduce the same class of failure.)
- What guarantees do current helpers provide? None beyond "eventually writes
  bytes". The read helper conceals the damage by returning `null`
  (`project-store.ts:72-81`). **[CODE]**

### 3.4 Hypothesis to confirm with a controlled test

- The exact interleaving that *first* triggered P18 (which pair of writers, in
  which order) is not reconstructed; only that two concurrent whole-file writes
  produce the observed bytes. Marked **[HYP]**; a deterministic test (section 8)
  should reproduce it on demand.

---

## 4. FFmpeg timeout and error-mapping chain

### 4.1 Scene render path

`POST /api/projects/[id]/scenes/[sceneId]/render` →
`sceneRenderService.renderScene` (`lib/render/scene-render-service.ts:24`) →
`LocalFFmpegRenderer.render` (`lib/render/renderer.ts:290`) →
`runProcess(ffmpegPath, args, { timeoutMs: 60_000 })`
(`lib/render/renderer.ts:310`). **[CODE]**

- The 60 000 ms value is **hard-coded** at `renderer.ts:310`; there is no env
  var for it. **[CODE]**
- After a successful process, output is validated with `ffprobe` via
  `validateOutputFile` (`renderer.ts:240-281`). **[CODE]**
- Failure mapping: `renderer.ts:329-331` converts `ProcessExecutionError` to
  `SceneRenderError` with `code = error.exitCode === undefined ? 'FFMPEG_UNAVAILABLE' : 'FFMPEG_FAILED'`. **[CODE]**

`runProcess` (`lib/render/ffmpeg-executor.ts:33-95`):

- `stdio: ['ignore','pipe','pipe']`; accumulates stdout/stderr as strings; no
  size cap. **[CODE]**
- `child.on('error')` (spawn failure, e.g. `ENOENT`): rejects with
  `exitCode === undefined`. **[CODE]** `ffmpeg-executor.ts:74-76`
- `child.on('close', (code, signal))`: `code === 0` resolves; otherwise rejects
  with `code ?? undefined`. **[CODE]** `ffmpeg-executor.ts:78-86`
- Timeout: `setTimeout` → **`child.kill('SIGKILL')`** then immediately rejects
  with a timeout message and **`exitCode === undefined`**. **[CODE]**
  `ffmpeg-executor.ts:88-93`
- Therefore **a timeout and a missing executable both produce
  `exitCode === undefined` and are indistinguishable** at the mapping site.
  **[CODE]**

### 4.2 Final composition path

`videoCompositionService.composeProject` (`video-composition-service.ts:278`)
→ `LocalFFmpegVideoCompositor.compose` (`video-compositor.ts:247`) →
three different FFmpeg invocations with **different** timeouts:

- per-scene normalize: `runProcess(..., { timeoutMs: 120_000 })`
  (`video-compositor.ts:138`)
- concat: `runProcess(..., { timeoutMs: 180_000 })` (`video-compositor.ts:204`)
- music mix: `runProcess(..., { timeoutMs: 180_000 })` (`video-compositor.ts:194`)

**[CODE]** So scene render (60 s) and final compose (120–180 s) do **not** share
a limit, and neither is configurable. Composition also re-renders missing/stale
scenes via `sceneRenderService.renderScene`, inheriting the 60 s per-scene limit
(`video-composition-service.ts:262-273`). **[CODE]**

`ffprobe` is invoked with **no timeout** (`lib/render/ffprobe.ts:37-47`), so a
hung `ffprobe` can hang render/compose indefinitely. **[CODE]**

### 4.3 Verifying the P18 `FFMPEG_UNAVAILABLE` mapping (not trusting the name)

P18 run `run_80f1badb-...` recorded for `scene_render` on Scene 1:
`code: "FFMPEG_UNAVAILABLE"`, `httpStatus: 503`, and a `details` string that
contains the **full ffmpeg stderr**. That stderr shows the encoder running and
finishing (`frame=150 ... Lsize=14kB time=00:00:04.90 ... speed=0.0991x`), i.e.
**FFmpeg was present and executed**. The action was still marked failed. **[CODE]**
(inspected live from `projects/project_c805a7ab-.../runs/run_80f1badb-...json`)

Conclusions:

- The `FFMPEG_UNAVAILABLE` code here did **not** mean "binary missing". It is the
  umbrella code for "a `ProcessExecutionError` with no exit code", which includes
  a timeout kill. **[CODE]**
- The same run produced **three render files for Scene 1** (render_96714087,
  render_a8caece3, render_d540ed6e) while Scenes 2 and 3 produced one each.
  **[P18]/[CODE]** This is consistent with more than one runner having executed
  the same action (see 3.4 / section 9) and/or a 60 s timeout racing a nearly
  finished encode.
- Distinguishing evidence exists only in the free-form `details` string; no
  structured code separates timeout from missing-binary from signal termination.
  **[CODE]**

### 4.4 Additional mapping inconsistencies

- The direct HTTP route maps `SceneRenderError` codes itself and returns **500**
  for `FFMPEG_UNAVAILABLE` (`app/api/projects/[id]/scenes/[sceneId]/render/route.ts:42`),
  while the run path maps the same code to **503**
  (`run-service.ts:179-190`). Same failure, two statuses. **[CODE]**
- A missing `ffprobe` (but present `ffmpeg`) surfaces as `OUTPUT_INVALID`, not a
  missing-tool error, because `probeMedia` wraps it as `FFprobeError` and
  `validateOutputFile` converts that to `OUTPUT_INVALID`
  (`renderer.ts:246-252`). **[CODE]**

---

## 5. Render duration versus resolution

Evidence available without new runs:

- FFmpeg stderr from the failed 1080p scene shows `speed=0.0991x` for a 5 s clip
  (≈50 s of wall time for the encode alone). **[CODE]** (from the P18 artifact)
- 1920×1080 = 2.07 Mpx vs 1280×720 = 0.92 Mpx → 2.25× the pixels. **[CODE]**
- The successful P18 minimal run was 1280×720 at a 2 s scene and finished the
  whole pipeline in ~5.7 s. **[P18]**
- The scene/render fingerprint includes `width`, `height`, `fps`
  (`lib/render/render-fingerprint.ts:1-32`), and the render plan takes
  resolution from `project.renderSettings` (`lib/render/scene-resolver.ts:182-185`,
  defaults 1920×1080 in `lib/constants.ts`). **[CODE]**

Assessment (carefully bounded):

- It is **not proven** that 1080p alone caused the P18 failure; the container also
  had CPU contention (a Next.js route compiled mid-run) and possibly concurrent
  duplicate renders (section 4.3). **[HYP]**
- What **is** established: 1080p leaves almost no headroom under a fixed 60 s
  budget (≈50 s encode observed), so any contention or longer scene crosses the
  limit, while 720p has ~2.25× the headroom. **[CODE]/[P18]**
- Claiming more precise performance causation requires the controlled tests in
  section 8. **[HYP]**

`scene.duration` scales wall time linearly; `renderSettings.fps` is fixed at 30
in the plan and fps changes would alter both time and fingerprint. **[CODE]**

---

## 6. Solution comparison for safe writes

### Option A — Serialize per project (shared write queue / lock)

- Add a per-`projectId` async mutex (a promise chain) consulted by every writer,
  or wrap `writeProjectFile`.
- Pros: smallest conceptual change; fixes lost updates as well as corruption;
  mirrors the existing `activeCompositionLocks` and the run `persistQueue`
  precedents. Preserves the whole-object write model.
- Cons: an in-process `Map<projectId, Promise>` only serializes writers **within
  one Node process**. It does not help multiple processes (section 6.1).
- Effort: small. Must ensure every write path goes through the lock.

### Option B — Atomic write (temp file + rename)

- `writeProjectFile` writes `project.json.<tmp>` then `fs.rename` to
  `project.json`, exactly like `FileRunStore.save` (`run-store.ts:82-85`).
- Pros: a reader/crash never sees a half-written file; if two writers run, the
  file is always one complete revision (no trailing bytes, no corruption).
  Small, well-precedented change.
- Cons: atomic rename fixes *torn files* but **not lost updates** — two
  non-atomic read-modify-write cycles still overwrite each other, last writer
  wins. It converts "corruption" into "silent lost change".
- Effort: smallest.

### Option C — Serialization **and** atomic write (recommended)

- Wrap the whole read-modify-write in a per-project critical section **and** write
  via temp+rename.
- Pros: fixes both failure modes (no torn file, no lost update) inside one
  process; identical guarantees to what the run store already provides. No
  database, no storage refactor. **Smallest robust solution that preserves the
  architecture.**
- Cons: needs a single choke point. Recommended choke point: a thin
  `withProjectLock(projectId, fn)` in `lib/storage/project-store.ts` used by
  `updateProject` plus a read-modify-write helper, so callers that currently do
  `getProject`→mutate→`updateProject` are refactored to pass a mutation function
  (or, minimally, only `updateProject` is serialized and atomic, which fixes
  corruption and most lost updates).
- Effort: small–moderate (touches call sites only where true RMW correctness
  matters; can be phased).

### 6.1 Multi-process caveat

The current design is a **single Node process** (one `next start`/`next dev`
server) plus one in-process MCP server that talks over HTTP. Options A/C use an
in-process lock and are correct for that model. **[CODE]**

If more than one Node process ever opens the same `projects/` root (e.g. running
`next dev` twice, a separate worker, or clustered `next start`), an in-process
lock is insufficient. Options in that case, in increasing weight:

- rely solely on atomic rename (Option B) for tear-safety and accept cross-process
  last-writer-wins; or
- add **advisory file locking** (e.g. a `project.json.lock` via `O_EXCL` with
  stale-timeout) around the critical section; or
- introduce compare-and-set (a monotonically increasing `revision` field checked
  before rename) and retry on mismatch.

Do **not** add a database or a broad storage refactor: none of the observed
failures require it. **[CODE]/[HYP]**

Recommendation: implement Option C now (in-process lock + atomic rename),
document the single-process assumption explicitly, and leave the cross-process
path as a documented follow-up.

---

## 7. FFmpeg timeout strategy

Requirements: support 720p and 1080p without blindly raising a single timeout;
clear, structured errors.

Proposed shape (describe only, not implemented):

1. Make the scene-render timeout configurable — e.g.
   `RENDER_SCENE_TIMEOUT_MS` with a safe default. Keep final-compose timeouts
   separate and configurable too (`RENDER_COMPOSE_NORMALIZE_TIMEOUT_MS`,
   `RENDER_COMPOSE_CONCAT_TIMEOUT_MS`, or a single `RENDER_COMPOSE_TIMEOUT_MS`
   applied to all three compose steps). Bound all values with a min/max like the
   existing `envInt` helper in `run-service.ts:105-111`.
2. Distinguish outcomes with **structured error codes**, not just message text:
   - add a `reason`/`kind` to `ProcessExecutionError`
     (`exitCode | signal | timeout | spawn`), set at
     `ffmpeg-executor.ts:74-93`; and
   - map it in `renderer.ts`/`video-compositor.ts` so a timeout becomes
     e.g. `FFMPEG_TIMEOUT` (or `RENDER_TIMEOUT`), a missing binary stays
     `FFMPEG_UNAVAILABLE`, a non-zero exit stays `FFMPEG_FAILED`, and a signal
     kill is explicit.
   - Timeout likely wants HTTP 504 (gateway timeout) semantics rather than 503.
3. Give `probeMedia` a timeout (`ffprobe.ts:37-47`) so validation cannot hang.
4. Optionally scale the default budget by resolution/size: derive a default
   from `width×height×fps×duration` with a floor and ceiling, so 720p is not
   penalised and 1080p gets enough room — but keep it override-able and bounded.
5. Ensure a timeout kills the **whole** child and its descendants. `SIGKILL` on
   the direct child is correct for terminating FFmpeg; note that if FFmpeg ever
   spawns helpers, a process-group kill would be needed. **[HYP]** (FFmpeg is a
   single process here.)

The regression tests in section 8 pin each of these behaviours.

---

## 8. Regression test matrix

Described only; none implemented or executed. "Evidence of success" = the
assertion(s) that prove the property. Each test should be hermetic: render/ffmpeg
tests already skip when FFmpeg is absent (see `tests/local-ffmpeg-renderer.test.ts`
and `tests/video-composition-service.integration.test.ts`); write tests need a
temp projects root (see note below).

| # | Test | Checks | Evidence of success |
| --- | --- | --- | --- |
| T1 | Concurrent updates to one project keep every change | Serialization + atomic write; no lost update | N interleaved `updateProject` mutations (e.g. append distinct scene fields); final file parses and contains all N changes |
| T2 | Concurrent production + project update never corrupt JSON | Lock spans production write and external write | Run a production batch while concurrently PATCHing; loop ≥100×; every read parses; no "non-whitespace after JSON" error |
| T3 | Failed/interrupted write leaves no partial file | temp+rename atomicity (crash injection) | Simulate a write that fails after temp creation but before rename (or `SIGKILL` mid-write); original `project.json` still parses to the previous revision; no `.tmp` residue |
| T4 | Recovery can still read a valid project | Recovery path unaffected | Persist a non-terminal run, corrupt/rewrite nothing, restart service; `recoverRuns` loads project and resumes without `run_failed("project no longer exists")` |
| T5 | Missing FFmpeg executable yields a proper error | spawn `ENOENT` classification | Point `FFMPEG_PATH` at a non-existent path; expect `FFMPEG_UNAVAILABLE` (not `FFMPEG_FAILED`/`OUTPUT_INVALID`); status 503 consistently in route and run |
| T6 | Real timeout is distinguished from missing executable | timeout classification | Run a command that sleeps past a tiny injected timeout; expect a distinct timeout code (e.g. `FFMPEG_TIMEOUT`) and message, different from T5 |
| T7 | Timeout stops the child process | kill on timeout | After timeout, assert the child pid is gone (no lingering `ffmpeg`); assert no orphan; assert promise rejects promptly |
| T8 | Successful 720p and 1080p renders recorded as completed | resolution does not affect success recording | With a comfortably high timeout, render a short blank scene at 1280×720 and 1920×1080; both return `status:'completed'`, correct width/height via ffprobe, and are persisted once |
| T9 | (Supporting) Atomic write is used | `writeProjectFile` contract | Unit-test the store: assert a temp file is used and renamed; assert `readProjectFile` never returns `null` for a concurrently written valid revision |

Testability note **[CODE]**: `JsonProjectStore` hard-codes its root via
`getWorkspaceRoot() = process.cwd()` (`storage-paths.ts:3-5`); unlike
`FileRunStore` it has no `projectsRoot` option. T1–T3/T9 will be far cleaner if
`JsonProjectStore` gains an optional root (or the tests run under a temp `cwd`).
Existing integration tests currently write into the real `/workspace/projects`
and delete afterward (`tests/video-composition-service.integration.test.ts:55-69`).

---

## 9. Impact on existing guarantees

| Guarantee | Interaction | Required care |
| --- | --- | --- |
| P13 durable runs + recovery | `FileRunStore.save` is already atomic and per-run persistence is already queued (`run-store.ts:82-85`, `run-service.ts:401-447`). Recovery writes the project through `updateProject` (`run-service.ts:469-481`). | The write fix must keep `updateProject` semantics identical (full normalized project, `updatedAt` stamped). Recovery must not deadlock against the new lock. Do not change run status/cursor/journal semantics. |
| P14 auth / ownership / security | `requireProjectAccess` performs an owner-claim write on the hot path (`access-control.ts:91-98`, `page-access.ts:35`). | Serialization must not move access checks or expose the write; `ownerId` is preserved by `...project` in `normalizeProject` (`normalize-project.ts:369+`) — keep it that way. Do not weaken the not-found-on-mismatch behaviour. |
| P15 audio mix + composition fingerprints | Composition artifact is appended via `updateProject` (`video-composition-service.ts:315-321`); fingerprints embed width/height/fps (`render-fingerprint.ts`). | Preserve `compositions[]` and fingerprint fields verbatim; note that changing render resolution legitimately invalidates stored renders (expected staleness, not a bug). |
| P15.2 background music | Music service writes through the same store (`music-service.ts`). | No change to music state machine; only the write mechanism changes. |
| P16 MCP authoring + error codes | MCP tools are an adapter over REST; `update_project`, plan/materialize already flow through the store. | Do not change MCP tool contracts or public error codes. A new timeout code is additive; keep `FFMPEG_UNAVAILABLE`/`FFMPEG_FAILED` names for existing consumers. |
| P18 proven local mock E2E | The chain works today with `limits=1` (serialized) and 720p. | The write fix should let the default concurrency work without corruption; the timeout fix should let 1080p succeed. Verify the P18 chain still passes after changes. |
| Idempotency / resume | The planner treats already-current actions as `current`; recovery marks interrupted attempts deterministically (`run-recovery.ts`). | The lock/atomic change must not alter action identity, fingerprints, or the current/failed decision logic. |

---

## 10. Prioritized findings

### P0 — risk of data corruption / unreliable production

1. **Non-atomic whole-file project writes with no serialization.** Proven
   corruption mechanism (section 3.2). **Smallest implementation step:** make
   `writeProjectFile` atomic (temp+rename, mirroring `FileRunStore.save`) **and**
   serialize per-project writes behind a single choke point (Option C). This one
   change addresses corruption and lost updates together.
2. **Read-modify-write lost updates across all writers.** Same choke point fixes
   it. If a phased approach is preferred, ship atomic write first (stops
   corruption), then the lock (stops lost updates).
3. **Corruption is silently masked** by `readProjectFile` returning `null`
   (`project-store.ts:72-81`). **Smallest step:** after the atomic-write fix,
   surface unreadable projects (log + exclude explicitly) rather than treating
   them as absent.

### P1 — incorrect error handling / unreliable render duration

4. **Timeout is mis-mapped to `FFMPEG_UNAVAILABLE`** (sections 4.1/4.3). Proven
   that the P18 `FFMPEG_UNAVAILABLE` did not mean "binary missing". **Smallest
   step:** tag `ProcessExecutionError` with a reason and map a timeout to a
   distinct code (e.g. `FFMPEG_TIMEOUT`) in `renderer.ts` and
   `video-compositor.ts`.
5. **Hard-coded 60 s scene-render budget** with no headroom at 1080p
   (`renderer.ts:310`). **Smallest step:** make the scene-render timeout
   configurable (bounded env var) while keeping separate compose timeouts; do not
   simply raise it for all cases.
6. **`ffprobe` has no timeout** (`ffprobe.ts:37-47`). **Smallest step:** add the
   same bounded timeout support that `runProcess` already exposes.
7. **Status inconsistency for the same code** (500 vs 503, section 4.4).
   **Smallest step:** align the direct scene-render route with the run mapping.

### P2 — monitoring, configuration, diagnostics

8. No structured diagnostics for spawn failures vs timeouts vs signals beyond a
   free-text `details` string. Add a machine-readable reason.
9. Optional: derive a default timeout from resolution/size×fps×duration with
   bounds, so 720p and 1080p both have sane defaults.
10. Document the single-process assumption of the in-process lock and the
    cross-process follow-up (section 6.1).

---

## 11. Open questions requiring a controlled local test

1. Does concurrent `updateProject` reproduce corruption deterministically with
   the current `fs.writeFile`, and does the temp+rename + lock fix eliminate it
   under the same load? (T1/T2)
2. Is the P18 Scene 1 failure reproduced purely by a 60 s timeout at a given
   resolution/duration, or does it require concurrency/contention? (T6/T8) —
   determine the minimum scene duration at 1080p that reliably crosses 60 s in
   this container.
3. Was the triple Scene 1 render caused by multiple run-service instances
   (dev hot-reload `autoRecover`) or by one instance scheduling the action more
   than once? (Investigated indirectly; needs an instrumented single-run test.)
4. Does `child.kill('SIGKILL')` reliably reap the FFmpeg process and leave no
   temp/output residue on timeout? (T7)
5. What residual files (`.tmp`, partial mp4) exist after a killed render, and are
   they ever picked up by later runs? (T3/T7)

---

## Appendix A — Provenance of each claim

- **[CODE]** Sections 2 (all), 3.2, 4.1–4.2, 4.4, 5 (mechanisms), 6, 7, 9, 10
  and the code references throughout were read directly from this repository.
- **[P18]** Corrupt-file symptom, the 1080p vs 720p outcome, the `FFMPEG_UNAVAILABLE`
  incident, and the triple render come from `p18-hermes-e2e-smoke-report.md` and
  the P18 artifacts (re-inspected here).
- **[HYP]** Unsure items are explicitly tagged: the exact original interleaving
  (3.4), precise performance causation (section 5), multi-instance cause of the
  duplicate render (4.3/11.3), and multi-process/process-group edge cases
  (6.1/7.5).
