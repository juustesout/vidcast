# P25: Forced-Recovery Idempotency

Status: **implemented and verified (mock + unit).** Finding **F1** from P24
(`force:true` recovery re-executed already completed `image_generate` /
`narration_generate` actions, duplicating assets) is fixed. The runner is now
seeded on recovery with the run's persisted `completedActionIds`, so a forced
recovery no longer regenerates work that already produced its artifacts, while
the planner still re-derives (and re-runs) any action whose artifact is actually
missing or stale. `npm run typecheck`, `npm run lint`, `npm test` (99 files /
744 tests) and `npm run build` all pass. No commit or push. All prior reports
(`p22-*`, `p22.1-*`, `p22.2-*`, `p23-*`, `p24-*`, `hermes_*`) are preserved
untouched.

---

## 1. Root cause

On recovery, `HeadlessProductionRunService.executeRunInternal` seeds the batch
runner with the persisted `failedActionIds` but, before this fix, **not** with
the persisted `completedActionIds`. The runner therefore started every batch
with an empty completed set.

The planner already suppresses forced regeneration of work it believes is
complete:

```
// lib/production/production-planner.ts:127
const forceRegenerate = (id: string): boolean => force && !completedActionIds.has(id);
```

With `force:true` and an empty `completedActionIds`, `forceRegenerate(id)` is
`true` for `image_generate` / `narration_generate`, so those actions were
re-derived as `ready` and executed again (attempts 1 → 2, image assets 6 → 12 in
the P24 repro `project_9a7c27a0-…` / `run_9c0a976e-…`). With `force:false` the
same run was already correct (`action_current`, no duplication).

## 2. Fix

Two-link change; no ownership, claim, or API surface changes.

### 2.1 Runner: seed completed ids and separate "already complete" from "executed this batch"

`lib/production/production-runner.ts`:

- `RunProductionBatchInput` gained an optional `initialCompletedActionIds?: string[]`
  (`production-runner.ts:116`), documented as "restored from a recovered run".
- The planner's completed set is seeded from it:
  `const completedActionIds = new Set<string>(input.initialCompletedActionIds ?? [])`
  (`:265`). This set is passed to `derivePlan` (`:302`), so the planner treats
  those actions as complete and, under `force:true`, `forceRegenerate` returns
  `false` for them.
- A new `executedActionIds` set (`:269`) tracks only what **this** batch
  executed. The ready-action filter now uses it
  (`deriveReadyProductionActions(plan).filter((action) => !executedActionIds.has(action.id))`,
  `:387`) instead of `completedActionIds`. On success both sets are updated
  (`:467-468`).

This split is the crux: `completedActionIds` (which can include recovered ids)
suppresses forced re-execution, while `executedActionIds` only prevents
re-running an action twice **within** the current batch. Because the recovered
ids are *not* in `executedActionIds`, an action whose artifact turned out to be
missing still re-derives as `ready` and runs.

### 2.2 Service: forward the persisted completed ids to the batch

`lib/production/run-service.ts` now passes the run's persisted set next to the
failed set:

```
// run-service.ts:746-750
initialFailedActionIds: run.failedActionIds,
// Completed actions are restored so a forced recovered run does not
// re-execute generation that already produced its artifacts. The planner
// still re-derives any action whose artifact is missing or stale.
initialCompletedActionIds: run.completedActionIds,
```

## 3. Why missing/stale artifacts are still regenerated

The fix deliberately does **not** let a recorded action id short-circuit the
planner. Artifact gating stays authoritative and independent of the batch seed:

- `hasUsableGeneratedAsset` requires the linked image/video asset to exist and
  be `available`; otherwise the generated-image action falls through to `ready`
  (`production-planner.ts:150-198`).
- `deriveNarrationFreshness` (`lib/generation/narration-freshness.ts`) returns
  `no_audio` / `stale` / `failed` when the audio artifact is missing or no longer
  matches the current narration inputs, so `narration_generate` becomes `ready`.
- `deriveSceneRenderStatus` / `deriveCompositionArtifactStatus`
  (`lib/render/render-status.ts`) re-derive renders and composition from the
  current project, not from the recorded ids.

So a recovered run with a completed id but a missing artifact is regenerated;
one whose artifact is genuinely present is left alone.

## 4. Tests

### 4.1 New runner-level regression suite

`tests/production-runner-force-recovery.test.ts` (5 tests) — real planner
(`deriveProductionPlan`) + real runner (`runProductionBatch`), with a
deterministic executors harness that produces render and composition artifacts.
Fixture state = "generation done, rendering pending" (one generated-image scene,
image + narration already produced, no renders/composition).

| Test | Asserts |
| --- | --- |
| fresh forced run, no completed ids | `image_generate`, `narration_generate`, `scene_render`, `final_compose` all run (1 attempt each); 1 image + 1 audio asset; 1 composition |
| forced recovery, completed = image+narration | image/narration **not** executed (0 attempts); render + compose run; assets unchanged; composition produced |
| unforced recovery, completed = image+narration | same as above (baseline) |
| forced recovery, artifacts missing | image **and** narration re-executed (1 attempt each) despite recorded completed ids; composition produced |
| forced recovery, only image artifact missing | only `image_generate` re-runs; narration stays current |

### 4.2 Recovery wiring test

`tests/run-recovery.test.ts` — "forwards persisted completed actions to the
recovered batch so forced runs stay idempotent": seeds a persisted running run
with `policy.force = true` and `completedActionIds`, recovers it, and asserts the
batch received `initialCompletedActionIds` equal to the persisted ids.

## 5. Verification

| Check | Command | Result |
| --- | --- | --- |
| Targeted | `npx vitest run tests/production-runner-force-recovery.test.ts tests/run-recovery.test.ts` | 26 passed (2 files) |
| Typecheck | `npm run typecheck` | clean |
| Lint | `npm run lint` | clean |
| Full suite | `npm test` | **99 files / 744 tests passed** (was 98 / 738) |
| Build | `npm run build` | success (all routes compiled) |

The real-FFmpeg integration test
(`tests/production-run-e2e.integration.test.ts`) still passes, confirming the
happy path (fresh run → image assets, narration audio, scene renders, composed
MP4) is unaffected.

## 6. Preserved guarantees

- Blank-only runs still complete.
- Generated-image runs still complete with exactly one image asset, one audio
  asset and a composition when run fresh.
- The P23 cross-process execution lock and stale-lock reclaim are untouched
  (`tests/run-recovery.test.ts` lock tests still pass).
- `force:true` on a **fresh** run still regenerates everything (the fix only
  suppresses re-execution of ids restored from a recovered run).

## 7. Remaining risks / out of scope

- **F2 (out of scope, unfixed):** the mock `generated_video` path stops after a
  single poll and ends `unresolved`
  (`production-runner.ts` dedupes `video_poll` via the completed set); repro
  `project_36af2e59-…` / `run_4f759050-…`. This still blocks a live mid-flight
  video-restart check and is not addressed by P25.
- The runner-level tests simulate executor artifacts; the real-FFmpeg e2e path
  covers the fresh-run happy case but not the forced-recovery branch end to end.
  A live dev-server forced-recovery replay (F1 repro) was validated in P24 and
  is consistent with the unit-level fix here.

## 8. Changed files (uncommitted)

- `lib/production/production-runner.ts` — `initialCompletedActionIds` seed,
  `executedActionIds` set, ready-filter and success-add updates.
- `lib/production/run-service.ts` — pass `initialCompletedActionIds:
  run.completedActionIds`.
- `tests/production-runner-force-recovery.test.ts` — new.
- `tests/run-recovery.test.ts` — new forwarding test.
