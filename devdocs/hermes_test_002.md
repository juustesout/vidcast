# hermes_test_002.md - Local production-flow integration test (Hermes / MCP)

Status: ready to run
Owner: Hermes (MCP client agent)
Scope: prove the durable **production-run** lifecycle end-to-end on a local
machine with **real FFmpeg** and **only free mock providers** (no paid
generation). Explicitly exercises: a clean happy path, re-fetching the run
status, a **deterministic failed action**, and **recovery after the browser is
closed or hidden**.

This document is a runnable script. Follow the steps in order. For every step
the expected observation and the pass/fail rule are given. Record the exact
values you observe (ids, statuses, codes) - do not paraphrase.

---

## 0. At a glance

| # | Scenario | Paid providers | Browser | Primary tools |
| --- | --- | --- | --- | --- |
| A | Mock happy path (image + voice + render + compose) | No | No | `run_production`, `get_run_status`, `get_run_log`, `get_project_compositions` |
| B | Re-fetch run status (reuse + poll + log paging + NOT_FOUND) | No | No | `run_production`, `get_run_status`, `get_run_log` |
| C | Deterministic failed action (FFmpeg unavailable; optional provider failure) | No | No | `run_production`, `get_run_status`, `get_run_log`, `get_scene` |
| D | Recovery after browser close / hidden tab | No | Yes | UI + `get_run_status` |
| E | (optional) Process-restart recovery | No | No | `get_run_status`, `get_run_log` |

Everything below runs in `mode: "mock"`. Mock mode calls **no** paid provider,
even if API keys exist in `.env`. Real-provider policy can stay disabled
(`PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=false`).

---

## 1. What this test proves

1. The server-side run is **durable and authoritative**: it keeps running while
   no browser is watching, and can be re-read at any time by `runId`.
2. A **single failed action** is recorded precisely (action id, error code,
   log event) and does not crash the run.
3. Run status is **re-readable and idempotent**: starting a second run for a
   project with an active run reuses it (`reused: true`); the log paginates.
4. The **client polls only while the tab is visible** and does one catch-up poll
   on return (idle-aware polling).

Behavior this test also touches (browser checks in Scenario D, step D4):

- first page load performs **no** network font fetch (offline system fonts);
- the anonymous session is bootstrapped with **exactly one** `POST /api/auth/session`.

---

## 2. Preconditions and environment

| Item | Value |
| --- | --- |
| Repo root | `/workspace` (adjust to your checkout) |
| App | Next.js dev server, `http://localhost:3000` (API is on the **same** port, `/api/*`) |
| MCP server | one stdio server, entrypoint `mcp/read-only/server.ts`; start via `npm run mcp:local` |
| Auth | `Authorization: Bearer <EXPLAINER_API_TOKEN>` |
| Security mode | `local` (default outside production) |
| Minimum Node | the version in `package.json` (tested with Node 22) |

### 2.1 FFmpeg is a hard prerequisite

`scene_render` and `final_compose` shell out to real FFmpeg. Verify before you
start:

```bash
ffmpeg -version
ffprobe -version
```

Both must print a version. If they are not on `PATH`, set `FFMPEG_PATH` /
`FFPROBE_PATH` to absolute binaries when launching the app. `FFMPEG_UNAVAILABLE`
in the run log means FFmpeg was not found by the server process.

### 2.2 Token (do not print it)

The app reads `EXPLAINER_API_TOKEN` from `.env` automatically. The MCP server
only forwards a token; it never mints one. Use the **same** value for both, but
never echo the secret into logs or chat:

```bash
# The app is started normally (it loads .env). The MCP needs the same values:
export EXPLAINER_API_BASE_URL="http://localhost:3000"
export EXPLAINER_API_TOKEN="<same value as the app's EXPLAINER_API_TOKEN>"
```

If they differ, every authenticated call returns `UNAUTHENTICATED`.

### 2.3 Start the app and the MCP server

```bash
# Terminal 1 - app (mock-safe; keys in .env are ignored in mock mode)
npm run dev

# Warm the routes once so the run-service singleton is not re-instantiated
# mid-run by dev-mode on-demand compilation:
curl -s -o /dev/null -H "Authorization: Bearer $EXPLAINER_API_TOKEN" http://localhost:3000/api/projects
curl -s -o /dev/null -H "Authorization: Bearer $EXPLAINER_API_TOKEN" http://localhost:3000/api/production-runs/does-not-exist
```

```bash
# Terminal 2 - MCP server (stdio). Hermes normally launches this from its config.
npm run mcp:local
```

Hermes connects over stdio. On this host the operator wrapper is
`/opt/data/profiles/operator/scripts/explainer-mcp.sh` (sets the env vars and
starts `mcp/read-only/server.ts`). Tool names are shown below as
`run_production`; in a client that prefixes the server they look like
`mcp_explainer_local_run_production`.

### 2.4 Response envelope

Every tool returns:

```json
{ "ok": true, "data": { ... } }
```

```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "...", "details": { ... } } }
```

React on `error.code`, not on message text. Failed calls also set `isError: true`.

### 2.5 Stability settings (recommended)

Project writes are atomic (`project.json` is written to a temp file then
renamed), so concurrent writers no longer corrupt state. Still, to keep runs
easy to observe and to avoid a dev-mode route compile re-instantiating a service
mid-run, the examples below pass `limits` with every entry set to `1` and a
modest `maxIterations`.

---

## 3. Shared authoring helpers

Run these once; they define the exact objects reused by Scenarios A-E.
`update_project` **replaces the whole `scenes` array**, so always send complete
scene objects (every field you want to keep).

### 3.1 Create the happy-path project (project H)

```jsonc
// tool: create_project
{ "title": "hermes_test_002 happy path", "durationTarget": 12, "aspectRatio": "16:9", "fps": 30 }
// -> data.projectId  (call it PROJECT_H)
```

`create_project` auto-seeds one default scene; step 3.2 replaces it.

### 3.2 Author scenes (image + blank), each with scene-level narration

```jsonc
// tool: update_project
{
  "projectId": "<PROJECT_H>",
  "project": {
    "scenes": [
      {
        "id": "scene-1",
        "order": 1,
        "duration": 4,
        "type": "image",
        "narration": { "text": "This scene uses a generated still image.", "status": "planned" },
        "visual": {
          "kind": "generated_image",
          "generation": { "kind": "image", "status": "planned", "prompt": "A calm blue gradient background" }
        },
        "render": { "motion": { "preset": "zoom_in" }, "transition": { "type": "fade" } },
        "overlay": { "type": "title", "text": "Hermes test 002" },
        "referenceIds": []
      },
      {
        "id": "scene-2",
        "order": 2,
        "duration": 4,
        "type": "blank",
        "narration": { "text": "This scene is a plain blank frame.", "status": "planned" },
        "visual": { "kind": "blank" },
        "render": { "motion": { "preset": "zoom_out" }, "transition": { "type": "fade" } },
        "overlay": { "type": "none" },
        "referenceIds": []
      }
    ]
  }
}
// expect: ok:true, data.valid:true
```

### 3.3 Inspect before running

```jsonc
// tool: get_validation_report
{ "projectId": "<PROJECT_H>" }   // expect: valid:true, errors:[]

// tool: get_production_plan
{ "projectId": "<PROJECT_H>" }   // expect several "ready" actions (image/narration/render) and final_compose waiting
```

> A scene with empty `narration.text` is **blocked** (`Narration text is
> missing.`). Image/video scenes need a valid generation `prompt`.

---

## 4. Scenario A - Mock happy path (free, end-to-end)

Goal: a project becomes a real, playable MP4 using only mock providers.

```jsonc
// tool: run_production
{
  "projectId": "<PROJECT_H>",
  "mode": "mock",
  "force": true,
  "maxIterations": 24,
  "limits": { "image_generate": 1, "video_submit": 1, "video_poll": 1, "narration_generate": 1, "scene_render": 1, "final_compose": 1 }
}
// expect: ok:true, data.reused:false, data.run.status:"queued" (or "running"), data.run.runId -> RUN_A
```

Poll until terminal (`completed` | `partial` | `failed` | `unresolved`):

```jsonc
// tool: get_run_status  (repeat every ~2-3s)
{ "runId": "<RUN_A>" }
// expect data.run.status to walk queued -> running -> completed
// expect in the terminal snapshot:
//   summary.completed >= 6 (image_generate x1, narration x2, scene_render x2, final_compose x1)
//   failedActionIds: []
//   status: "completed"
```

Read the structured log:

```jsonc
// tool: get_run_log
{ "runId": "<RUN_A>", "cursor": 0, "limit": 50 }
// expect data.log.items[] events including at least:
//   run_started, plan_created, action_scheduled, action_started, action_completed,
//   refresh_started/refresh_completed, composition_started/composition_completed, run_completed
// note data.log.nextCursor and data.log.hasMore (use them in Scenario B)
```

Fetch and verify the artifact:

```jsonc
// tool: get_project_compositions
{ "projectId": "<PROJECT_H>" }
// expect data.available:true, data.latest.downloadPath, data.latest.filesize, data.latest.duration
```

```bash
# HTTP GET with the same bearer token (MP4 bytes are never an MCP payload)
curl -s -o /tmp/opencode/hermes_test_002_a.mp4 \
  -H "Authorization: Bearer $EXPLAINER_API_TOKEN" \
  "http://localhost:3000<downloadPath>"

# Verify it is a real, decodable MP4:
ffprobe -v error -show_entries format=format_name,duration,bit_rate -of default=nw=1 /tmp/opencode/hermes_test_002_a.mp4
ffmpeg -v error -i /tmp/opencode/hermes_test_002_a.mp4 -f null -   # exit code 0, no output
```

Pass criteria A:

- terminal run status `completed`, `failedActionIds.length === 0`;
- MP4 exists, `ffprobe` reports a container + a video stream, full decode exits 0;
- log shows each action executed once (idempotent re-plan marks work `current`).

---

## 5. Scenario B - Re-fetch run status (reuse + poll + paging + NOT_FOUND)

Goal: confirm run state is re-readable and that a duplicate start is coalesced.

### B1 - A second start reuses the active run

Start another run for the **same** project while one is still active. If
`RUN_A` already finished, first start a slow one (use a project with more
scenes, or act quickly):

```jsonc
// tool: run_production   (same projectId as an in-flight run)
{ "projectId": "<PROJECT_H>", "mode": "mock" }
// expect: ok:true, data.reused:true, data.run.runId === <RUN_A>   (same run, not a new one)
```

### B2 - Re-read the same run at any time

```jsonc
// tool: get_run_status
{ "runId": "<RUN_A>" }
// expect the same runId; failedActionIds and completedActionIds are stable arrays
```

### B3 - Paginate the log

```jsonc
// tool: get_run_log
{ "runId": "<RUN_A>", "cursor": 0, "limit": 5 }      // first page
// then:
{ "runId": "<RUN_A>", "cursor": <nextCursor>, "limit": 5 }   // second page
// expect: monotonic `cursor` values, no duplicates, and `hasMore` true until the end
```

### B4 - Unknown run is a clean NOT_FOUND

```jsonc
// tool: get_run_status
{ "runId": "run_does_not_exist" }
// expect: ok:false, error.code === "NOT_FOUND", data absent
```

Pass criteria B: B1 `reused:true` with the same runId; B3 pages are contiguous;
B4 returns `NOT_FOUND` (not a 500 / crash).

---

## 6. Scenario C - Deterministic failed action (free)

A production action lands in the run's `failedActionIds` only when its
**execution throws**. The most reliable, free way to force that is to make
FFmpeg unavailable to the app: `scene_render` then throws `FFMPEG_UNAVAILABLE`,
the action is marked failed, and `final_compose` (which depends on renders)
stays unresolved - so the run ends `failed`.

### C1 - Restart the app with a broken FFmpeg path

```bash
# stop the dev server, then relaunch pointing at a non-existent binary:
FFMPEG_PATH=/nonexistent/ffmpeg FFPROBE_PATH=/nonexistent/ffprobe npm run dev
# warm the routes again (as in 2.3)
```

### C2 - Run a render-bearing project

Reuse project H (it has 2 scenes) so several renders are attempted:

```jsonc
// tool: run_production
{
  "projectId": "<PROJECT_H>",
  "mode": "mock",
  "force": true,
  "maxIterations": 24,
  "limits": { "scene_render": 1, "final_compose": 1 }
}
// -> RUN_C
```

### C3 - Observe the failed actions

```jsonc
// tool: get_run_status
{ "runId": "<RUN_C>" }
// expect terminal status "failed" (failed count > 0 AND unresolved actions > 0)
// and failedActionIds.length >= 1 (the scene_render action(s))
```

```jsonc
// tool: get_run_log
{ "runId": "<RUN_C>", "cursor": 0, "limit": 100 }
// expect action_failed event(s) for scene_render with
//   event.error.code === "FFMPEG_UNAVAILABLE" and event.error.httpStatus === 503
```

```jsonc
// tool: get_run_status
{ "runId": "<RUN_C>" }   // re-fetch: the failed set is stable across reads
```

### C4 - Restore the app

```bash
# stop and restart normally (no FFMPEG_PATH override), then re-warm the routes
npm run dev
```

Pass criteria C: at least one `action_failed` with code `FFMPEG_UNAVAILABLE`
(HTTP 503); the run terminates `failed`; re-fetch returns the same
`failedActionIds`.

### C5 - (optional) Provider failure vs action failure

The mock video provider (`local`) fails when the scene's generation prompt
contains the substring `fail` (it fails on the second poll with `PROVIDER_FAILED`).
Understand the distinction: this is a **provider/attempt failure**, not a
run-level failed action. The planner treats a `failed` generation as eligible to
retry, so with a large `maxIterations` the run re-submits and retries - bound it
to observe the failure without looping:

```jsonc
// tool: create_project
{ "title": "hermes_test_002 provider failure", "durationTarget": 5, "aspectRatio": "16:9", "fps": 30 }
// -> PROJECT_F

// tool: update_project - one scene whose generation prompt contains "fail":
//   "visual": { "kind": "generated_video",
//               "generation": { "kind": "video", "status": "planned", "prompt": "Please fail this clip" } }
// then:
{ "projectId": "<PROJECT_F>", "mode": "mock", "force": true, "maxIterations": 3,
  "limits": { "video_submit": 1, "video_poll": 1 } }
// -> RUN_C2
```

```jsonc
// tool: get_scene
{ "projectId": "<PROJECT_F>", "sceneId": "<sceneId>" }
// expect visual.generation.status === "failed" with errorCode "PROVIDER_FAILED"

// tool: get_run_status
{ "runId": "<RUN_C2>" }
// expect status "unresolved" (retries were bounded; failedActionIds possibly empty)
```

This shows that a provider failure is surfaced on the scene/attempt and bounded
by `maxIterations`, whereas an execution throw (C1) is what populates
`failedActionIds`.

---

## 7. Scenario D - Recovery after browser close / hidden tab

This has two layers. The **server run is authoritative and durable**; the
browser is only a viewer.

### D1 - Prepare an observable run

Start a mock run for a project with several scenes (length keeps it observable),
or reuse project H with `force:true`:

```jsonc
// tool: run_production
{ "projectId": "<PROJECT_H>", "mode": "mock", "force": true, "limits": { "scene_render": 1 } }
// -> RUN_D  (record the runId!)
```

Immediately open `http://localhost:3000/projects/<PROJECT_H>` in a browser and
click **Start Server Run**. The "Server runner" panel should show **Running**
with a Run ID.

### D2 - Hidden tab: polling must pause and resume (idle-aware polling)

1. Open DevTools -> Network, filter on `production-runs`.
2. While the tab is **visible**, note polls arriving about every **2.5 s**
   (`GET /api/production-runs/<RUN_D>` and `.../log`).
3. Switch to another tab / minimize (document becomes hidden). Note that
   polling **stops** (no new `production-runs` requests) while hidden.
4. Switch back. Expect **exactly one immediate catch-up poll**, then the normal
   ~2.5 s cadence resumes and the summary/status update.

Expected: no background polling while hidden; a single catch-up on return; the
run is **not** cancelled or restarted by hiding the tab.

### D3 - Closed browser: the run survives and can be re-attached

1. Note `RUN_D` and its current status (`get_run_status { runId: "<RUN_D>" }`).
2. **Close the browser tab entirely.** Wait 15-30 s.
3. Confirm the run kept going **without any browser**:

   ```jsonc
   // tool: get_run_status
   { "runId": "<RUN_D>" }
   // expect status to have advanced (or be terminal) versus step 1
   ```

4. Reopen `http://localhost:3000/projects/<PROJECT_H>`. The panel resets to
   **"No tracked server run."** (the UI does not auto-rebind an old runId after a
   reload). This is expected.
5. Re-attach by clicking **Start Server Run** again. Because a run for this
   project is still active, the server returns the existing run:
   - if still running: the panel shows **"Reused active server run."** and
     resumes tracking `RUN_D`;
   - if already finished: it starts a fresh run that completes quickly with
     `0 action(s) completed` (all outputs already current).

Pass criteria D:

- D2: polling pauses while hidden and produces exactly one catch-up poll on
  return;
- D3: `get_run_status` advances while the browser is closed; re-attaching reuses
  the active run (or completes deterministically).

### D4 - Regression checks tied to the recent refactor

With DevTools open on a fresh `/projects/<PROJECT_H>` load:

- **Offline fonts**: the Network tab shows **no** request to
  `fonts.googleapis.com` / `fonts.gstatic.com`. Fonts are local system stacks.
- **Single session bootstrap**: there is **exactly one** `POST /api/auth/session`
  on first load (not two), even under React StrictMode double-mount.

Pass criteria D4: no Google Font requests; session POST count === 1.

---

## 8. Scenario E - (optional) Process-restart recovery

The run store is file-backed at `projects/<projectId>/runs/<runId>.json`, and the
service auto-recovers non-terminal runs when the process restarts (disabled
under `NODE_ENV=test` and during `next build`).

1. Start a run and confirm `get_run_status` shows `running`.
2. Stop the dev server (Ctrl-C) while the run is active.
3. Restart `npm run dev`.
4. `get_run_status { "runId": "<runId>" }` - expect it to still resolve (run
   re-imported; status typically returns to `queued` then `running`).
5. `get_run_log` - look for `run_recovered` events.

Documented caveats (record what you actually see):

- an in-flight generation with a stored provider job id is **resumed**;
- an interrupted generation with a usable persisted asset is restored to
  `generated`;
- an interrupted generation with **no** recoverable job is marked `failed` with
  `errorCode: "INTERNAL"` and reason `"Interrupted by process restart."`, and the
  run may end `unresolved` (previously observed).

---

## 9. Evidence checklist

Collect and paste the raw values into the report:

| Field | Scenario | Value |
| --- | --- | --- |
| `PROJECT_H` id | setup | |
| `RUN_A` id + terminal status | A | |
| `RUN_A` `summary` + `completedActionIds.length` | A | |
| MP4 download path + filesize + `ffprobe` output | A | |
| `run_production` second-call `reused` | B1 | |
| first/second log page `nextCursor`/`hasMore` | B3 | |
| unknown-run `error.code` | B4 | |
| `RUN_C` terminal status + `failedActionIds` | C3 | |
| `action_failed` `event.error.code` + `httpStatus` | C3 | |
| `RUN_C2` status + `visual.generation.status`/`errorCode` | C5 | |
| runs while hidden / catch-up count | D2 | |
| `RUN_D` status before vs after browser close | D3 | |
| Google Font requests / session POST count | D4 | |
| restart recovery status + `run_recovered` events | E | |

Report format: one short table of observed values, then a pass/fail line per
scenario, then any deviations with the exact error `code`, HTTP status, and the
relevant log event. Do **not** claim a pass for a scenario you did not execute.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `API_UNAVAILABLE` on every call | MCP pointed at the wrong port | `EXPLAINER_API_BASE_URL=http://localhost:3000` (MCP default is not 3000) |
| `UNAUTHENTICATED` on every call | token mismatch | app and MCP must share the same `EXPLAINER_API_TOKEN` |
| `FFMPEG_UNAVAILABLE` in `scene_render`/`final_compose` | FFmpeg not on the server's `PATH` (or a bad `FFMPEG_PATH`) | install FFmpeg / set the correct path; restart the app |
| `VALIDATION_FAILED` on `update_project` | incomplete scene object (scenes are replaced wholesale) | send every field you want to keep for every scene |
| run completes with `0 action(s) completed` ("already current") | outputs already exist | pass `force: true` |
| `POLICY_DENIED` / `PROVIDER_NOT_CONFIGURED` | real mode requested | this test is mock-only; use `mode: "mock"` |
| second start creates a new run instead of reusing | the first run already reached a terminal status | reuse only applies to an **active** run |

---

## 11. Cleanup

The scenarios create projects under `/workspace/projects/`. List them and keep
them for inspection:

```bash
ls -1 projects
```

Do **not** delete anything without explicit confirmation. If cleanup is
requested, remove only the `hermes_test_002` projects identified above.
