# P16 MCP Authoring & Test Workflow — Report

Status: complete (typecheck, lint, build clean; full suite 357 passing, 2 pre-existing FFmpeg/PATH failures).

## Goal

Let a Hermes agent create, edit, plan and materialize an explainer project, optionally manage
background music, run production, and fetch the finished video — all through the existing local
MCP server, with the REST API as the source of truth.

## What changed

Single MCP entrypoint retained. New authoring tools and a composition-inspection tool are
registered on the same stdio server; no second server or REST implementation was added.

Entrypoint (unchanged, now exposes every tool group):

```bash
npm run mcp:local      # == npm run mcp:readonly
# both run: tsx mcp/read-only/server.ts
```

Registered tools:

- read-only: `list_projects`, `get_project`, `get_scene`, `get_validation_report`, `get_production_plan`, `get_project_compositions` (new)
- authoring (new): `create_project`, `update_project`, `plan_scene_intents`, `materialize_scene_intents`, `manage_project_music`
- production: `run_production`, `get_run_status`, `get_run_log`

### New / modified modules

- `mcp/authoring/tools.ts` — zod input schemas, `AUTHORING_TOOL_DEFINITIONS`, `createAuthoringToolService`, `registerAuthoringTools`.
- `mcp/authoring/api-client.ts` — `HttpAuthoringApiClient` (bearer token, base URL, HTTP→MCP error mapping; music API code mapping).
- `mcp/authoring/errors.ts`, `mcp/authoring/types.ts` — error/result types and authoring response shapes.
- `mcp/read-only/tools.ts`, `mcp/read-only/types.ts` — added `get_project_compositions` + `CompositionInfo`/`toCompositionInfo`, sorted newest-first.
- `mcp/read-only/server.ts` — registers authoring tools between read-only and production.
- `mcp/production/types.ts`, `mcp/production/api-client.ts` — enriched error codes (`VALIDATION_FAILED`, `PROVIDER_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED`, `FFMPEG_UNAVAILABLE`) and status mapping (401/403/400/409/429/503).
- `docs/p16-mcp-authoring.md` — user/agent-facing documentation (entrypoint, env, contracts, workflow, REST gaps, blockers).
- `package.json` — `test:mcp` now includes the new test files.

### Tests

- `tests/mcp-authoring.test.ts` (new) — tool registration; required-argument validation; structured create/update/plan/materialize responses; music select-without-asset rejected without a client call; music result mapping; HTTP client path/method assertions; 422→`VALIDATION_FAILED` with structured errors; music `notConfigured`→`PROVIDER_NOT_CONFIGURED`; `rateLimited`→`RATE_LIMITED`; 401→`UNAUTHENTICATED`, 403→`FORBIDDEN`; bearer token forwarded; exactly one request per action (no retries / no auto paid calls).
- `tests/mcp-compositions.test.ts` (new) — `get_project_compositions` newest-first ordering, download path, no MP4 bytes / no `outputPath`; empty→`available:false`; unknown id→`NOT_FOUND`; argument validation; single-server registration of all groups with no name collisions.
- `tests/mcp-stdio-transport.integration.test.ts` (extended) — asserts the new tool names over real stdio and exercises `create_project`, `plan_scene_intents`, `materialize_scene_intents`, `manage_project_music`, and `get_project_compositions` against a mock REST server.
- `tests/mcp-read-only.test.ts` (updated) — expected read-only tool list now includes `get_project_compositions`.

## Contract reuse

All authoring tools wrap existing REST routes and inherit their validation, ownership and throttling:

| MCP tool | REST |
| --- | --- |
| `create_project` | `POST /api/projects` |
| `update_project` | `PUT /api/projects/{id}` |
| `plan_scene_intents` | `POST /api/projects/{id}/scene-intents/plan` |
| `materialize_scene_intents` | `POST /api/projects/{id}/scene-intents/materialize` |
| `manage_project_music` | `POST /api/projects/{id}/music` |
| `get_project_compositions` | `GET /api/projects/{id}` (reads `project.compositions`) |

## Safety / idempotency decisions

- Run contract left unchanged. The run snapshot does not carry `compositionId`; threading it through run-types/run-store/registry would be a broad refactor. Instead a dedicated read-only `get_project_compositions` tool + the documented `get_project` follow-up cover the "completed composition awaiting fetch" case.
- Music generation is a single explicit paid action per call; the client never retries. Select/clear never hit a provider. Mock mode performs no paid call.
- Identity/ownership/token are enforced server-side by the app; the MCP server only forwards `EXPLAINER_API_TOKEN` and never returns secrets.
- No MP4 bytes are ever serialized into tool payloads; only metadata + `downloadPath`.

## Steps that still need REST

- Asset/reference multipart upload and listing.
- Downloading the final MP4: authenticated `GET /api/projects/{id}/compositions/{compositionId}/file` (bytes are deliberately out of MCP).
- Session/token bootstrap (`POST /api/auth/session`).

## Configuration

- `EXPLAINER_API_BASE_URL` (default `http://127.0.0.1:5555`).
- `EXPLAINER_API_TOKEN` → `Authorization: Bearer`.
- `next dev` serves on port **3000**; set `EXPLAINER_API_BASE_URL=http://127.0.0.1:3000` for local dev.

## Verification

- `npm run typecheck` — clean.
- `npm run lint` — no warnings or errors.
- `npm run build` — succeeded.
- `npx vitest run` — 357 passed, 2 failed. The 2 failures are pre-existing and environmental: `tests/local-ffmpeg-renderer.test.ts` and `tests/fake-image-provider-render.test.ts` (no `ffmpeg`/`ffprobe` on PATH).

## Remaining blockers

- No FFmpeg/ffprobe in this environment → `scene_render`/`final_compose` report `FFMPEG_UNAVAILABLE` (HTTP 503); real rendering cannot be exercised here.
- Real-provider runs require `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, and a valid `EXPLAINER_API_TOKEN`.

## Usage

See `docs/p16-mcp-authoring.md` for the full tool contracts, Hermes stdio configuration, an
end-to-end workflow example, and the error-code table.
