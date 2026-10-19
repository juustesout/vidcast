# Hermes Compatibility Assessment and Plan

Date: 2026-10-18
Scope: can the Hermes MCP agent drive the current authoring, production, and
presenter features; what remains for full parity.

## Verdict

Hermes can run the complete standard workflow today, including AI-presenter
generation: author the project, configure presenter scenes and budgets, run
production in mock or real mode, poll the run, and download the composed MP4.
No compatibility fix is required for that path.

Two limitations remain, both outside the standard production run:

1. There is no standalone presenter submit/poll tool. Presenter generation is
   reachable only through `run_production`.
2. After a failed real presenter clip, the runner intentionally blocks an
   automatic paid retry. There is no agent-facing, explicitly approved retry
   operation.

Neither limitation is caused by the production runner. The runner's default
dependencies call `submitPresenterClip` and `pollPresenterClip` directly; the
`/generate-presenter` and `/presenter` endpoint strings in run logs are labels,
not HTTP calls. Production therefore works even though no matching REST route
exists under `app/api/projects/[id]/scenes/[sceneId]/`.

## Compatibility matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Read projects, scenes, validation, production plan | Ready | 7 read-only tools |
| Create/update project, scenes, narration, overlays | Ready | `update_project` shallow-merges and replaces arrays |
| Story beats to scenes | Ready | Plan, approve, materialize |
| Reference images | Ready | Base64 JSON, 25 MB decoded cap |
| Music | Ready | `manage_project_music` or run `music` object |
| Single-scene video submit/poll/cancel | Ready | `generate_video`, `get_generation_job`, `cancel_video` |
| Mock production | Ready | Default; no paid calls |
| Real production | Ready | Server real-provider opt-in and credentials required |
| Presenter authoring | Ready | Complete `presenter` object plus per-scene settings |
| Presenter generation/poll in a run | Ready | `presenter_submit` / `presenter_poll`, budgeted |
| Presenter cost visibility | Ready | `get_project` returns attempts with `cost` |
| Standalone presenter submit/poll | Missing | No MCP tool and no REST route |
| Explicit paid presenter retry | Missing | Runner blocks it by design; no approval path |
| Standalone narration/image/render/compose | Missing | Production run covers them |
| Asset upload/list, MP4 download, claim | REST only | Documented in `agent_manual.md` |
| Presenter budget authoring in the browser UI | Missing | Human UI only; Hermes can patch it |
| Project deletion | Missing | Not exposed |

## What Hermes must know for presenter work

- `presenter` is a complete object, not a nested merge. Read it first and send
  it back whole.
- Paid generation requires `maxCostUsd`, `HEYGEN_PRICING_JSON`, and
  `HEYGEN_AVATAR_TYPE`. Missing pricing fails closed with
  `presenter.cost.notConfigured` before any provider call.
- Budget overruns fail with `presenter.budget.exceeded`.
- Narration must be current before presenter submission.
- `force: true` does not force a presenter clip. A stale clip is regenerated
  automatically; a failed real clip stays blocked.
- Presenter clip attempts and estimated/observed cost are visible on
  `project.presenterClips[].attempts[]`.
- Publication of stock-avatar output remains blocked pending written HeyGen
  confirmation; see `docs/heygen-stock-avatar-licensing.md`.

## Remaining work plan

### Phase 0 - Documentation baseline (done)

- Added canonical `agent_manual.md` with the full tool catalog, authoring
  contract, presenter contract, production behavior, REST-only operations, and
  maintenance rules.
- Replaced `docs/hermes-mcp-manual.md` with a pointer to the canonical file.
- Added `tests/agent-manual.test.ts`, which fails if a registered MCP tool is
  absent from the manual.

### Phase 1 - Standalone presenter control (optional, only if needed)

Needed only when an agent must generate or poll one presenter clip outside a
production run, for example targeted repair.

- Add `POST /api/projects/{id}/scenes/{sceneId}/generate-presenter` and
  `GET /api/projects/{id}/scenes/{sceneId}/presenter` using the existing
  presenter service, access control, and throttles.
- Add MCP tools `generate_presenter` and `get_presenter_job` with the same
  provider, mode, and regenerate arguments as the service.
- Reuse the existing fail-closed cost guard; return the same error codes.
- Add route and MCP tests, including a zero-provider-call assertion for missing
  pricing or budget.
- Update `agent_manual.md`; the coverage test enforces the tool entries.

### Phase 2 - Approved paid retry (only if operations require it)

- Add an explicit, audited retry operation that requires a cost confirmation
  and records who approved it.
- Do not bypass the guard by clearing `presenterClips`; that loses attempt and
  cost history.
- Gate it behind an operator-only capability, not a default agent tool.
- Document the approval flow and add tests proving a retry cannot start without
  confirmation.

### Phase 3 - Cost reporting (optional)

- Add a read tool summarizing presenter estimates and observed wallet deltas per
  project or run.
- Keep the distinction between estimate and observed wallet delta explicit.

### Phase 4 - UI parity (human-facing, optional)

- Add presenter budget and avatar-class fields to the browser authoring UI so
  humans can set the same values Hermes patches.

## Recommended next step

Adopt Phase 0 as the baseline. Do not implement Phase 1 unless a concrete
standalone presenter workflow appears; the standard end-to-end Hermes path is
already compatible and keeping paid presenter execution inside the budgeted
runner is the safer default.
