# P24: Hermes E2E Recovery Validation

Status: **executed, mock-only.** Scenario D was validated for **server
durability without a browser** (PASS) and its **real-browser checks were marked
BLOCKED** (no browser engine is installed — see §2). Scenario E
(process-restart recovery) was executed end-to-end for a blank-only and a
generated-image project: run re-import, `run_recovered`, stale-lock reclaim, and
final composition all **PASS**, but a **force:true recovery re-executes already
completed `image_generate` actions** (duplicate assets) — documented as finding
**F1**. No application code was changed during this validation. No commit or
push. The existing reports (`hermes_test_002.md`,
`p22.2-claim-security-and-scenario-d-results.md`,
`p23-generated-image-run-deadlock.md`) are preserved untouched.

---

## 1. Scope and method

Read first (unchanged): `hermes_test_002.md` (scenarios A–E, esp. §7 Scenario D
and §8 Scenario E), `p22.2-claim-security-and-scenario-d-results.md` (§5–§7,
including the P22.2 note that D2/D4 were NOT EXECUTED), and
`p23-generated-image-run-deadlock.md` (the cross-process execution lock).

Method:

- Real Next.js dev server on `http://localhost:3000`, started with
  `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=false PRODUCTION_RUN_DEFAULT_MODE=mock`.
- All runs via the real MCP stdio server (`mcp/read-only/server.ts`) with
  `mode:"mock"` and service Bearer auth. No paid provider was ever called.
- Scenario E used a **controlled kill** of the dev-server process
  (`background_terminal_kill` of the terminal that launched `npm run dev`) —
  **not** a simulated crash and **not** production data. Dedicated fresh
  projects only.
- Recovery logic inspected in `lib/production/run-service.ts`
  (`recoverRun`/`recoverRuns`) and `lib/production/run-recovery.ts`
  (`reconcileInterruptedGenerations`).
- Lock semantics confirmed by the existing unit tests in
  `tests/run-recovery.test.ts` (no new code written).

## 2. Environment and browser availability

| Item | Value |
| --- | --- |
| Node | 22.22.0 |
| App | `npm run dev`, port 3000, `NODE_ENV=development` |
| Providers (mock) | `{ image: "fake", video: "local", narration: "fake", music: "fake" }` |
| FFmpeg / ffprobe | 5.1.9 (present on PATH) |
| Real providers | forced off (`PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=false`) |
| Browser engine | **none** — `chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable`, `firefox` all absent; no `playwright`/`puppeteer` in `node_modules`; no `~/.cache/ms-playwright` or `~/.cache/puppeteer` |

Because no browser engine exists, every check that needs `document.visibilityState`,
DevTools network inspection, or a real page load is marked **BLOCKED** (§3),
not PASS — consistent with the P22.2 treatment.

## 3. Scenario D — browser checks

| Check | Description | Result |
| --- | --- | --- |
| D1 | Prepare an observable run (server + status re-read) | PASS |
| D2 | Hidden tab: polling pauses while hidden, exactly one catch-up on return | **BLOCKED** (no browser) |
| D3a | Server durability while no browser is attached (status advances / terminal) | PASS |
| D3b | Closed-browser UI re-attach behavior ("No tracked server run" → Reuse active run) | **BLOCKED** (no browser; UI click-path not exercised) |
| D4 | Offline fonts (no Google Fonts) + exactly one `POST /api/auth/session` on first load | **BLOCKED** (no browser) |

### D1 / D3a observed values (no browser attached at any point)

| Project | Scene kind | Run id | status first → final | summary | composition | image assets | renders |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `project_4b96060a-c850-4cc3-adbd-0f39d9ad13fe` | blank-only | `run_8452bca2-2404-439b-b078-ba8bbb2403b4` | `running` → `completed` | `{completed:3,failed:0,running:0,waiting:0}` | `available:true` | 0 | 1 |
| `project_744707ad-5349-4d4b-a1f7-16bc9157f1cd` | generated_image | `run_4c7b1c1d-660c-430e-a45a-f55b2842a9e6` | `running` → `completed` | `{completed:4,failed:0,running:0,waiting:0}` | `available:true` | 1 (attempts:1) | 1 |

Both runs ran to terminal **with no browser watching**, proving the server run is
authoritative and durable. No `.lock` files remained after completion.

### D2 / D3b / D4 — BLOCKED

- D2 requires DevTools network timing under hidden/visible transitions.
- D3b requires clicking **Start Server Run** in the UI after a reload and
  observing "Reused active server run".
- D4 requires a real page load to count `POST /api/auth/session` and inspect font
  requests.

None could be executed. Recommend running these on a host with Chrome + DevTools
(or adding Playwright) as `hermes_test_002.md` §6 already notes.

## 4. Scenario E — process-restart recovery

Two full cycles (start → kill mid-run → restart → observe). In both, the run was
`running` with a held lock owned by the now-dead dev-server worker when the
server was killed.

| Field | E (force:false) | E (force:true) |
| --- | --- | --- |
| Project | `project_ac68469c-0094-46a2-9f0c-01b9d9bee5d0` | `project_9a7c27a0-de3c-488f-80bb-89707963926a` |
| Run | `run_4695a595-a6ca-430b-b10b-e467a949484b` | `run_9c0a976e-d64c-4cb6-b3f9-3b8120832ac8` |
| Pre-kill status | `running` (12 completed) | `running` (12 completed) |
| Pre-kill lock | present, `pid 6326` (dead after kill) | present, `pid 6195` (dead after kill) |
| Pre-kill image assets / attempts | 6 / 1 each | 6 / 1 each |
| After restart | `run_recovered` event; re-imported; `queued`→`running` | `run_recovered` event; re-imported; `queued`→`running` |
| Completed images after recovery | `action_current` → **not re-executed** | `action_scheduled` → **re-executed** |
| Final status | `completed` | `completed` |
| Final summary | `{completed:7,failed:0,running:0,waiting:0}` | `{completed:19,failed:0,running:0,waiting:0}` |
| Final composition | `available:true` (1) | `available:true` (1) |
| Final image assets / attempts | **6 / 1 each (no duplicate)** | **12 / 2 each (DUPLICATE)** |
| Lock files after completion | `[]` (stale lock reclaimed) | `[]` (stale lock reclaimed) |

Recovery event observed in both (verbatim):
`run_recovered` — "Recovered run after process restart; resuming from persisted state."

Result:

- **E status recovery — PASS.** The run re-imported from
  `projects/<id>/runs/<runId>.json`, appended `run_recovered`, and resumed.
- **E stale-lock reclaim — PASS.** The lock file left by the dead worker PID was
  reclaimed automatically and removed on completion (`[]` at end).
- **E artifacts + final composition — PASS.** FFmpeg renders completed and a
  final composition was produced in both cycles.
- **E completed-action idempotency — FAIL for `force:true` (see F1); PASS for
  `force:false`.**

An earlier same-day E attempt on a single-scene image run
(`project_71f9e4bb-…` / `run_68e0d2bc-…`) **completed before the kill landed**,
so it produced no mid-run state; it is discarded and not counted.

## 5. Second worker must not re-execute an active run; stale lock only if owner is dead

Established by the existing regression tests (unchanged by P24), all passing:

| Test (`tests/run-recovery.test.ts`) | What it proves | Result |
| --- | --- | --- |
| `does not re-execute a run another instance is already executing` | With a **live** owner PID, a second service instance's `recoverRuns()` does not enter a second batch; lock stays held; run remains readable; lock released after completion | PASS |
| `reclaims a stale lock left by a dead process and resumes the run` | A lock file with a **dead** PID is reclaimed exactly once and the run resumes | PASS |
| `resumes a stored video job by polling and does not resubmit` (planner resume) | Recovery resumes a stored provider job by polling rather than issuing a new submission | PASS |

Suite result: `npx vitest run tests/run-recovery.test.ts tests/run-store.test.ts`
→ **26/26 pass**.

Real-server corroboration: in Scenario D the image-only run was polled
continuously through the status endpoint yet produced exactly **one** image asset
(no duplicate execution). The stale-lock rule is confirmed live by the two
Scenario E cycles: a dead-owner lock was reclaimed on restart, and the unit test
shows a live-owner lock is **not** reclaimed.

## 6. External jobs / completed actions on recovery

- **Completed actions — not duplicated when `force:false`.** After recovery the
  planner marks completed `image_generate`/`narration_generate` as
  `action_current` ("Generated image asset is current." / "Narration audio is
  current.") and does not re-run them; `attempts` stayed at 1 (§4).
- **Completed actions — duplicated when `force:true`.** See **F1**.
- **External provider jobs.** The mock image/narration providers complete
  synchronously and persist no external job id. The mock video provider does mint
  a `providerJobId` (`fake-video-job-…`), and the recovery/planner logic is
  unit-proven to **resume that stored job by polling without resubmitting**
  (`reconcileInterruptedGenerations` leaves an active video attempt with a job id
  for polling; planner test "resumes a stored video job by polling and does not
  resubmit"). A live mid-flight **video** restart could not be captured: the mock
  video run terminated `unresolved` before the kill (see **F2**), so the
  end-to-end resubmission check is NOT RUN in this environment.

### What the mock tests cannot prove (explicit)

- They cannot prove **real-provider idempotency**: `fake`/`local` make no network
  call, so nothing verifies that a real provider (OpenAI, fal, ElevenLabs) does
  not double-charge or double-submit when a job is resumed after a crash.
- They cannot prove **real FFmpeg process behavior on crash**: FFmpeg renders
  here are short-lived subprocesses on a healthy host; the mock run does not
  exercise orphaned/zombie `ffmpeg` processes, partial temp files, or
  `SIGKILL`-during-encode. A real crash mid-encode and its cleanup are unverified.
- They cannot prove **cross-machine / multi-instance** locking (the lock is a
  local file), nor network-partition recovery.
- Non-terminal runs are auto-recovered except under `NODE_ENV=test` and during
  `next build`; those guards are not exercised here.

## 7. Findings (no code changed)

### F1 — `force:true` recovery re-executes completed generation actions (duplicate work)

**Severity:** functional / cost (in real mode this would re-bill providers).

**Symptom.** With `force:true`, a run that is killed after `image_generate` and
`narration_generate` completed and then restarted **re-runs those actions**,
doubling attempts and assets (`attempts:2`, image assets `6→12`), though the run
still finishes `completed` with a composition.

**Why.** On recovery the executor seeds the runner only with
`initialFailedActionIds` from the persisted run
(`run-service.ts` `executeRunInternal`), **not** the persisted
`completedActionIds`. With `force:true`, the planner derives `image_generate` as
`ready` again, and because the recovered runner has an empty completed set
(`production-runner.ts:376-378` only filters ids already in its own
`completedActionIds`), it re-executes them. With `force:false` the planner marks
those outputs `action_current` and they are skipped.

**Minimal repro (mock).**

1. Create a project with 6 `generated_image` scenes (each with narration).
2. `run_production { mode:"mock", force:true, maxIterations:40, limits:{image_generate:1,narration_generate:1,scene_render:1,final_compose:1} }`.
3. Wait until the log shows all `image_generate` + `narration_generate`
   completed and `scene_render` started, then kill the dev server.
4. Restart `npm run dev`; hit the status/service once to trigger recovery.
5. Observe: image `attempts` become `2`, image asset count doubles.

**Observed:** project `project_9a7c27a0-…`, run `run_9c0a976e-…` (§4, right
column). `force:false` control: project `project_ac68469c-…`, run
`run_4695a595-…` (§4, left column) — no duplication.

**Fix proposal (separate task, not applied):** on recovery, seed the runner's
completed set from the persisted run (e.g. pass `initialCompletedActionIds` into
`runProductionBatch` and honor it alongside `initialFailedActionIds`), and/or
have the planner keep an already-completed generation `current` for the same run
even under `force:true`. Add a regression test: multi-scene image run with
`force:true`, kill mid-render, restore → image `attempts` stay `1`.

### F2 — (out of scope, observation) mock `generated_video` runs stop `unresolved` after one poll

**Symptom.** A single `generated_video` scene (mock, `force:true`) with a valid
prompt reached `unresolved` in ~0.1 s: after `video_submit` (job queued) and one
`video_poll` (returned `queued`), the runner stopped `run_stopped_unresolved`
with `video_poll` already in `completedActionIds`.

**Why (code reading).** The runner adds a successful `video_poll` to
`completedActionIds` (`production-runner.ts:457`) and then filters ready actions
by `!completedActionIds.has(action.id)` (`:376-378`). A video job that needs more
than one poll therefore has no executable action on the next iteration and the
run stops. The mock provider needs three polls (`fake-provider.ts`).

**Minimal repro:** project `project_36af2e59-…`, run `run_4f759050-…` (single
`generated_video` scene, `mode:"mock"`, `force:true`, `limits.video_poll:5`) →
terminal `unresolved`, summary `{completed:3,waiting:1}`, video generation left
`queued` with `providerJobId: fake-video-job-…`.

**Note:** this is **not** a recovery defect and is out of scope for P24; it is
recorded because it blocked the end-to-end mid-flight video restart check. It
needs its own investigation (does the planner/runner intend `video_poll` to be
re-issuable across iterations?). No fix proposed here.

## 8. Verdict summary

| # | Test | Result |
| --- | --- | --- |
| D1 | Prepare observable run (blank + image) | PASS |
| D2 | Hidden-tab polling pause / single catch-up | BLOCKED (no browser) |
| D3a | Server durability with no browser | PASS |
| D3b | Closed-browser UI re-attach | BLOCKED (no browser) |
| D4 | Offline fonts + single session POST | BLOCKED (no browser) |
| Ea | Run re-import + `run_recovered` after restart (force:false) | PASS |
| Eb | Run re-import + `run_recovered` after restart (force:true) | PASS |
| Ec | Stale-lock reclaim after restart | PASS |
| Ed | Final artifacts + composition after restart | PASS |
| Ee | Completed actions not duplicated on recovery (force:false) | PASS |
| Ef | Completed actions not duplicated on recovery (force:true) | **FAIL** (F1) |
| 5a | Live-owner lock not reclaimed / second instance no re-exec | PASS (unit) |
| 5b | Dead-owner stale lock reclaimed | PASS (unit + live) |
| 6a | Stored external video job resumed by polling, not resubmitted | PASS (unit) |
| 6b | Live mid-flight video restart end-to-end | NOT RUN (blocked by F2) |

## 9. Test data created (kept for inspection; nothing deleted)

- D blank-only: `project_4b96060a-c850-4cc3-adbd-0f39d9ad13fe` / `run_8452bca2-…`
- D image-only: `project_744707ad-5349-4d4b-a1f7-16bc9157f1cd` / `run_4c7b1c1d-…`
- E force:false: `project_ac68469c-0094-46a2-9f0c-01b9d9bee5d0` / `run_4695a595-…`
- E force:true: `project_9a7c27a0-de3c-488f-80bb-89707963926a` / `run_9c0a976e-…`
- E (timing-miss, discarded): `project_71f9e4bb-df99-449b-9063-2bf0105a8936` / `run_68e0d2bc-…`
- F2 video observation: `project_36af2e59-760c-4235-a217-f665fed19759` / `run_4f759050-…`
- Drivers: `/tmp/opencode/p24_d.mjs`, `/tmp/opencode/p24_e_multi_start.mjs`
  (`P24_FORCE`), `/tmp/opencode/p24_e_start.mjs`,
  `/tmp/opencode/p24_e_video_start.mjs`.

## 10. Caveats

- Browser-dependent items (D2/D3b/D4) are BLOCKED strictly because no browser
  engine is installed; they are not claimed as passing.
- Mock providers cannot validate real-provider idempotency or real FFmpeg
  crash/cleanup semantics (§6).
- The working tree still carries the earlier P22.1/P23 changes; **P24 added no
  application-code changes** (verified via `git status`/`git diff`).
- No commit or push was performed.
