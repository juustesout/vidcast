# P18 Hermes Local End-to-End Smoke Test Report

Status: COMPLETED. The local mock end-to-end chain is proven. No application
code, dependency, or config files were changed. No commits were made.

Objective: prove that Hermes (an MCP client) can drive the single MCP server to
autonomously create a project and produce a real, playable MP4 via mock
production, using only MCP tools, and report the exact journey.

Result summary: a Hermes-authored project was turned into a valid, decodable
H.264/AAC MP4 through MCP-only calls. The mock production run reached
`completed` with 3/3 actions completed and no failures.

## 1. Scope and method

- Driver: an MCP client (`@modelcontextprotocol/sdk` `StdioClientTransport`)
  that spawns `npm run mcp:local` in `/workspace` and calls tools over stdio.
- All project creation, authoring, planning, materialization, production, polling,
  logging, and composition listing went through MCP tools.
- The only non-MCP step is the final MP4 byte transfer, which by design happens
  over authenticated HTTP (`downloadPath`), not as an MCP payload (P16 decision).
- Providers used: `image: fake`, `video: local`, `narration: fake`. No paid AI
  generation was performed. `mode: mock`.
- Local-only target: Next.js dev server on port 3000 + the single MCP server.

## 2. Environment

| Item | Value |
| --- | --- |
| Node / npm | v22.22.0 / 10.9.4 |
| Next.js | 15.5.27 (dev server, port 3000) |
| FFmpeg / FFprobe | 5.1.9-0+deb12u1 (`/usr/bin/ffmpeg`, `/usr/bin/ffprobe`) |
| API base URL | `http://127.0.0.1:3000` |
| Auth | `Authorization: Bearer $EXPLAINER_API_TOKEN` (48-hex token) |
| Security mode | `EXPLAINER_SECURITY_MODE=local` |
| MCP entrypoint | `npm run mcp:local` = `tsx mcp/read-only/server.ts` |

Note: FFmpeg is an environment prerequisite. On this host it was installed for
the test; the pipeline itself does not fake render/compose, so FFmpeg must exist
wherever `scene_render`/`final_compose` run.

## 3. Exact tool order (successful run)

| # | Tool | Outcome |
| --- | --- | --- |
| 0 | `listTools` | 14 tools (6 read-only + 5 authoring + 3 production) |
| 1 | `create_project` | `project_c87d96b1-b5e3-4475-82f9-eaaa0304c160` |
| 2 | `update_project` | seeded 1-beat story, `scenes: []` (clears the auto-seeded default scene), 1280x720 render settings |
| 3 | `plan_scene_intents` | 1 draft intent created |
| 4 | `get_project` | read intent `explainer` to approve |
| 5 | `update_project` | set intent `status: 'approved'`, `timing.durationSeconds: 2` |
| 6 | `materialize_scene_intents` | 1 blank scene `scene_83c9b3be-...` |
| 7 | `get_project` | confirmed 1 scene, settings 1280x720 |
| 8 | `get_validation_report` | `valid: true`, 0 errors, 0 warnings |
| 9 | `get_production_plan` | 2 ready (`narration_generate`, `scene_render`) + 1 waiting (`final_compose`) |
| 10 | `run_production` | `run_43b35c1d-c6b3-44a8-bbfe-499175ece048`, 202 queued |
| 11 | `get_run_status` (poll) | terminal `completed`, summary `{completed:3, failed:0}` |
| 12 | `get_run_log` | 22 events, coherent start→finish |
| 13 | `get_project_compositions` | 1 composition, `available: true` |
| 14 | HTTP GET `downloadPath` | 200, `video/mp4`, 7307 bytes |

## 4. Artifacts

| Field | Value |
| --- | --- |
| Project ID | `project_c87d96b1-b5e3-4475-82f9-eaaa0304c160` |
| Run ID | `run_43b35c1d-c6b3-44a8-bbfe-499175ece048` |
| Composition ID | `composition_fdf20c59-9e4b-4bc1-8eef-e1a7b9d15f3e` |
| Download path | `/api/projects/project_c87d96b1-b5e3-4475-82f9-eaaa0304c160/compositions/composition_fdf20c59-9e4b-4bc1-8eef-e1a7b9d15f3e/file` |
| MP4 (local) | `/tmp/opencode/p18-composition.mp4` |
| Filesize | 7307 bytes |
| Duration / size / fps | 2.034 s / 1280x720 / 30 |
| Scene count | 1 |

Run log (`get_run_log`) event sequence (22 items, condensed):

```
run_started -> plan_created(2 ready/1 waiting) -> action_waiting(final_compose)
-> narration_generate (scheduled/started/completed)
-> scene_render       (scheduled/started/completed)
-> refresh -> plan_created(1 ready)
-> action_current(narration) + action_current(scene_render)   # idempotency, not re-run
-> final_compose (scheduled/composition_started/composition_completed)
-> refresh -> plan_created(0 ready) -> action_current(final_compose)
-> run_completed(3 actions completed)
```

Each action executed exactly once in this run; the re-plan pass correctly marked
prior work as `current` instead of redoing it.

## 5. Verification results (executed, not code-assessed)

- `ffprobe`: container `mov,mp4,m4a,3gp,3g2,mj2`; stream 0 `h264` video
  1280x720 @ 30/1; stream 1 `aac` audio 48000 Hz mono; `format.duration=2.034`,
  `bit_rate=28739`.
- Full decode: `ffmpeg -v error -i <mp4> -f null -` completed with exit code 0
  and no error output -> the file is well-formed and playable.
- `project.json` for the project parses cleanly (1 scene, 1 composition);
  1 render artifact produced (no duplicate renders).
- `GET /api/projects` returns 200 with the project listed.

## 6. Executed vs. code-assessed

| Claim | Basis |
| --- | --- |
| MCP create→author→plan→materialize→produce→download chain works | EXECUTED end to end |
| Composition is a valid playable MP4 | EXECUTED (ffprobe + full decode) |
| `get_run_log` paging shape (`items[].event`) | EXECUTED (22 events read) |
| Draft-intent approval requirement | EXECUTED (planner emits draft, materializer needs approved) |
| Mock-only default; real refused | CODE-ASSESSED in P17 (not re-run here) |
| Concurrency corruption root cause | EXECUTED (reproduced; see B1) |
| Hot-reload singleton churn hypothesis | PARTIAL (observed one duplicate render, see B3) |

The mock E2E chain is proven for the local environment. This smoke test does
NOT prove real-provider behavior, crash recovery, or multi-scene scale.

## 7. Blockers encountered and resolutions

### B1 - Concurrent writes corrupt `project.json` (REPRODUCED, worked around)
- Symptom: project `project_5ec5b7c3-...` had an unparseable `project.json`
  (`Unexpected non-whitespace character after JSON at position 10610`).
- Cause: the runner executes same-type actions concurrently (default
  `narration_generate` limit 2) while `project.json` is written non-atomically,
  so two writers interleaved and produced invalid JSON. The run died before any
  render.
- Workaround used: serialize the run by setting every `limits` entry to 1.
- Note: a corrupt project is silently skipped by `GET /api/projects` (the
  corrupted id is absent from the list; listing still returns 200). This hides
  the damage rather than surfacing it. Recommend an atomic write (temp file +
  rename) in `projectStore` so concurrency can never corrupt state; this is a
  concrete, demonstrated defect worth a follow-up fix.

### B2 - Scene render exceeds the 60 s per-scene timeout at 1920x1080 (ENV, worked around)
- Symptom: run `run_80f1badb-...` failed `scene_render` with
  `"FFmpeg failed while rendering the scene."` / code `FFMPEG_UNAVAILABLE`.
- Cause: `lib/render/renderer.ts` passes `timeoutMs: 60_000` to the FFmpeg
  process. At 1920x1080 the encoder ran at ~0.1x realtime in this container
  (compounded by CPU contention while Next compiled routes mid-run), so the
  process was killed; a killed process has no exit code, which maps to
  `FFMPEG_UNAVAILABLE` rather than a timeout-specific code.
- Workaround used: render at 1280x720 with a 2 s scene, which completed in a few
  seconds. This is an environment throughput issue, not a logic defect.

### B3 - Duplicate scene render observed once (PARTIAL, mitigated)
- Symptom: in run `run_80f1badb-...`, scene `scene_15ac7dec-...` produced three
  render files with different render IDs, while the other two scenes produced
  one each.
- Hypothesis: Next.js dev re-instantiates the `headlessProductionRunService`
  singleton (autoRecover) when a route compiles mid-run, re-scheduling actions.
- Mitigation used: pre-compile every API route before starting a run, and
  serialize limits. The final successful run produced exactly one render.
- Not conclusively proven; recommend confirming under a built server
  (`next build && next start`) or a single-run test with metrics.

## 8. False positives corrected during the test

- The driver first read `get_run_log` as `log.events[].code`; the real shape is
  `log.items[].event.{code,status,message}`. The log was never empty. These were
  test-driver bugs, not product defects.

## 9. Recommendations (not implemented)

1. Make `projectStore` writes atomic (temp file + `rename`) to eliminate B1.
2. Surface unreadable/corrupt projects instead of silently skipping them.
3. Distinguish "FFmpeg process killed by timeout" from genuinely missing FFmpeg
   so operators get an actionable error instead of `FFMPEG_UNAVAILABLE`.
4. Consider a configurable/default lower render resolution for local/dev to keep
   scene renders inside the 60 s budget on modest hosts.
5. Confirm B3 under a production build before treating it as a real bug.

## 10. Cleanup note

The test created these artifacts under `/workspace/projects/`:
`project_c87d96b1-...` (success), `project_c805a7ab-...` (B2/B3),
`project_5ec5b7c3-...` (B1, corrupt), `project_afca8256-...` (auth probe).
They were intentionally left in place (no deletions without confirmation).
`project_5ec5b7c3-...` can be removed on request.
