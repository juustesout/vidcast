# P16 MCP Authoring & Test Workflow

This document describes the authoring and composition-verification MCP tools added in P16, so an agent (Hermes) can drive a project end-to-end: create, edit, plan and materialize scenes, optionally manage background music, run production, and fetch the finished video.

All tools live on the **same** local stdio MCP server as the read-only (P11.1) and production (P11.3) tools. There is a single server process; no second server is introduced.

## Entrypoint

One entrypoint, two equivalent npm scripts:

```bash
npm run mcp:local
npm run mcp:readonly
```

Both run `tsx mcp/read-only/server.ts`, which registers every tool group:

```text
createReadOnlyMcpServer()
  -> registerReadOnlyTools()     // list_projects, get_project, get_scene,
                                 // get_validation_report, get_production_plan,
                                 // get_project_compositions
  -> registerAuthoringTools()    // create_project, update_project,
                                 // plan_scene_intents, materialize_scene_intents,
                                 // manage_project_music
  -> registerProductionTools()   // run_production, get_run_status, get_run_log
```

Direct invocation without npm:

```bash
npx tsx mcp/read-only/server.ts
```

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `EXPLAINER_API_BASE_URL` | Base URL of the running Explainer app API | `http://127.0.0.1:5555` |
| `EXPLAINER_API_TOKEN` | Bearer token sent as `Authorization: Bearer <token>` on every request | unset (local session cookie fallback) |

Important: `npm run dev` serves the app on **port 3000**, but the MCP default base URL is **port 5555**. For local development against `next dev` you must set:

```bash
export EXPLAINER_API_BASE_URL=http://127.0.0.1:3000
export EXPLAINER_API_TOKEN=<token>
```

Token source: the app issues API tokens through the existing auth surface (`POST /api/auth/session` for the cookie, or a provisioned API token). The MCP server never reads secrets itself; it only forwards the token you provide in its own environment. Secrets are never returned in tool payloads.

### Hermes stdio configuration

```json
{
  "mcpServers": {
    "explainer-local": {
      "command": "npm",
      "args": ["run", "mcp:local"],
      "env": {
        "EXPLAINER_API_BASE_URL": "http://127.0.0.1:3000",
        "EXPLAINER_API_TOKEN": "<token>"
      }
    }
  }
}
```

## Tool inventory

Read-only (P11.1): `list_projects`, `get_project`, `get_scene`, `get_validation_report`, `get_production_plan`, `get_project_compositions`.

Authoring (P16):

| Tool | REST contract | Mutating |
| --- | --- | --- |
| `create_project` | `POST /api/projects` | yes |
| `update_project` | `PUT /api/projects/{id}` | yes |
| `plan_scene_intents` | `POST /api/projects/{id}/scene-intents/plan` | yes |
| `materialize_scene_intents` | `POST /api/projects/{id}/scene-intents/materialize` | yes |
| `manage_project_music` | `POST /api/projects/{id}/music` | yes (generate/regenerate may be paid) |

Production (P11.3): `run_production`, `get_run_status`, `get_run_log`.

## Workflow example

A typical author-and-produce flow, all through MCP:

```text
1. create_project          { "title": "How CPUs work", "durationTarget": 60 }
   -> { projectId, title, valid: true }

2. update_project          { "projectId": "<id>", "project": {
                               "explainer": { "story": { "beats": [ ... ] } }
                             } }

3. plan_scene_intents      { "projectId": "<id>" }
   -> { createdIntentIds: [ ... ] }

4. materialize_scene_intents { "projectId": "<id>" }
   -> { materialized: [ { intentId, sceneId } ], skipped: [] }

5. get_validation_report   { "projectId": "<id>" }        // inspect blockers

6. manage_project_music    { "projectId": "<id>", "action": "generate",
                             "prompt": "calm ambient", "mode": "mock" }

7. run_production          { "projectId": "<id>", "mode": "mock" }
   -> { run: { runId, status } }

8. get_run_status          { "runId": "<runId>" }
9. get_run_log             { "runId": "<runId>", "cursor": 0 }

10. get_project_compositions { "projectId": "<id>" }
    -> { available: true, latest: { compositionId, downloadPath } }

11. GET <downloadPath> with the same bearer token to download the MP4 bytes.
```

## Tool contracts

### `create_project`

- Arguments: `{ title?, description?, durationTarget?, aspectRatio?, fps? }` (all optional).
- Returns: `{ projectId, title, valid: true }`.
- Not idempotent: calling it twice creates two projects. Use `list_projects` first if you want to reuse an existing project.
- Errors: `INVALID_ARGUMENT`, `UNAUTHENTICATED`, `RATE_LIMITED`, `API_UNAVAILABLE`, `API_ERROR`.

### `update_project`

- Arguments: `{ projectId, project }` where `project` is a partial project patch (title, description, narration, scenes, `explainer.story.beats`, `renderSettings`, music reference).
- The server merges the patch and validates the merged project.
- Returns: `{ projectId, valid: true }`.
- Errors: `INVALID_ARGUMENT`, `VALIDATION_FAILED` (with `details.errors` and `details.warnings`), `NOT_FOUND`, `FORBIDDEN`, `UNAUTHENTICATED`.

### `plan_scene_intents`

- Arguments: `{ projectId, project? }` (optional patch applied first).
- Derives scene intents from `explainer.story.beats`. Idempotent: beats that already have an intent are skipped.
- Returns: `{ projectId, valid: true, createdIntentIds }`.
- Errors: `INVALID_ARGUMENT`, `VALIDATION_FAILED`, `NOT_FOUND`, `FORBIDDEN`, `UNAUTHENTICATED`.

### `materialize_scene_intents`

- Arguments: `{ projectId, project?, intentIds? }`.
- Idempotent: already-materialized intents are reported under `skipped`.
- Returns: `{ projectId, valid: true, materialized: [{ intentId, sceneId }], skipped: [...] }`.
- Errors: `INVALID_ARGUMENT`, `VALIDATION_FAILED`, `NOT_FOUND` (unknown intent), `FORBIDDEN`, `UNAUTHENTICATED`.

### `manage_project_music`

- Arguments: `{ projectId, action, prompt?, musicLengthMs?, instrumental?, model?, provider?, seed?, outputFormat?, assetId?, mode? }`.
- `action` is one of `generate`, `regenerate`, `select`, `clear`.
  - `select` requires `assetId` and only updates the reference (no paid call).
  - `clear` drops the reference (no paid call).
  - `generate` refuses with `CONFLICT` if music already exists; `regenerate` overwrites the selection.
- **`generate`/`regenerate` in real mode is an explicit paid action.** It is executed only on this call and is never retried automatically. In local mock mode no paid provider is called.
- Returns: `{ projectId, action, status, assetId?, musicLengthMs?, musicProvider?, musicModel? }`.
- Errors: `INVALID_ARGUMENT`, `PROVIDER_NOT_CONFIGURED` (missing credentials), `PROVIDER_ERROR` (provider failure), `RATE_LIMITED` (quota), `CONFLICT` (`music.alreadyGenerated`/`music.alreadyRunning`), `NOT_FOUND`, `FORBIDDEN`, `UNAUTHENTICATED`.

### `get_project_compositions`

- Arguments: `{ projectId, compositionId? }`.
- Returns: `{ projectId, available, latest, compositions }` where each entry carries `compositionId, createdAt, duration, width, height, fps, sceneCount, filesize, downloadPath`. Newest first. `compositionId` filters to one entry and raises `NOT_FOUND` when absent.
- Never returns MP4 bytes. Fetch the file yourself from `downloadPath` with the same bearer token.
- Errors: `INVALID_ARGUMENT`, `NOT_FOUND`, `API_UNAVAILABLE`, `API_ERROR`.

## Error code mapping

The authoring client maps HTTP status and API codes into stable MCP error codes so an agent can react programmatically:

| Condition | MCP code |
| --- | --- |
| Bad tool arguments (schema) | `INVALID_ARGUMENT` |
| HTTP 400 / `music.invalid` / `music.asset.invalidType` | `INVALID_ARGUMENT` |
| HTTP 422 (project validation) | `VALIDATION_FAILED` (`details.errors`, `details.warnings`) |
| HTTP 401 | `UNAUTHENTICATED` |
| HTTP 403 / `POLICY_DENIED` | `FORBIDDEN` |
| HTTP 404 / `music.project.notFound` / `music.asset.notFound` | `NOT_FOUND` |
| HTTP 409 / `music.alreadyGenerated` / `music.alreadyRunning` | `CONFLICT` |
| HTTP 429 / `music.provider.rateLimited` | `RATE_LIMITED` |
| `music.provider.notConfigured` | `PROVIDER_NOT_CONFIGURED` |
| `music.provider.auth/rejected/unsupported/failed` | `PROVIDER_ERROR` |
| Network failure reaching the app | `API_UNAVAILABLE` |
| Other non-2xx | `API_ERROR` |

Production tools additionally map `503` (missing FFmpeg) to `FFMPEG_UNAVAILABLE`.

## Steps that still require REST

The MCP surface covers authoring + production + composition metadata. These remain REST-only and must be called directly:

- **Asset / reference upload and listing** (`POST /api/projects/{id}/assets`, references): multipart uploads are not exposed as MCP tools.
- **Downloading the final MP4 bytes**: `GET /api/projects/{id}/compositions/{compositionId}/file` is a plain authenticated HTTP GET. `get_project_compositions` returns the `downloadPath` but never the bytes.
- **Session/token acquisition** (`POST /api/auth/session`): identity bootstrap is outside the MCP server.

## Guarantees and non-goals

- All authoring tools reuse existing REST routes, validation, ownership, and throttling; there is no second REST implementation and no new production engine.
- Identity/ownership is enforced server-side; the MCP server never returns secrets.
- Music generation is a single explicit paid action per call, with no automatic retries.
- `run_production` continues to respect the existing run policy; it does not call paid providers outside that policy.
- Tests use mocked MCP/REST only; no real paid provider calls are made.

## Known environment blockers

- **No FFmpeg/ffprobe**: this environment has no `ffmpeg`/`ffprobe` on `PATH`, so `scene_render`/`final_compose` fail with `FFMPEG_UNAVAILABLE` (HTTP 503). The two pre-existing render tests (`tests/fake-image-provider-render.test.ts`, `tests/local-ffmpeg-renderer.test.ts`) fail for the same reason.
- **Real-mode credentials**: real provider runs need `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true`, `OPENAI_API_KEY`, and `ELEVENLABS_API_KEY`, plus a correctly configured `EXPLAINER_API_TOKEN`.
- **Base URL/port**: remember `next dev` is on port `3000`, while the MCP default is `5555`.
