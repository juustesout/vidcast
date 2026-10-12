# Hermes MCP Manual

Hand-off manual for an agent (Hermes) that must drive an Explainer project end-to-end through the local MCP server: read, author, run production, and fetch the finished video.

## 1. What and where

- There is exactly **one** MCP server process, a **stdio** server named `explainer-local-mcp` (v0.1.0).
- Source / entrypoint: `mcp/read-only/server.ts`. It registers every tool group (read-only, authoring, production).
- Transport: **stdio** (not HTTP/SSE). Hermes launches it as a child process and talks JSON-RPC over stdin/stdout.
- The server holds no state of its own; every tool call proxies to the running Explainer app's REST API over HTTP.

## 2. Launch

Equivalent npm scripts (run from the repo root):

```bash
npm run mcp:local
npm run mcp:readonly
```

Both execute `tsx mcp/read-only/server.ts`. Direct invocation without npm:

```bash
npx tsx mcp/read-only/server.ts
```

You normally do **not** run this by hand — Hermes starts it via stdio config (section 3).

## 3. Hermes stdio configuration

Point Hermes at the server and tell it where your app is. This app is running on **`http://localhost:3000`**:

```json
{
  "mcpServers": {
    "explainer-local": {
      "command": "npx",
      "args": ["tsx", "mcp/read-only/server.ts"],
      "cwd": "/absolute/path/to/explainer",
      "env": {
        "EXPLAINER_API_BASE_URL": "http://localhost:3000",
        "EXPLAINER_API_TOKEN": "<the-same-token-your-app-was-started-with>"
      }
    }
  }
}
```

Using the npm script instead of `npx`:

```json
{
  "mcpServers": {
    "explainer-local": {
      "command": "npm",
      "args": ["run", "mcp:local"],
      "cwd": "/absolute/path/to/explainer",
      "env": {
        "EXPLAINER_API_BASE_URL": "http://localhost:3000",
        "EXPLAINER_API_TOKEN": "<the-same-token-your-app-was-started-with>"
      }
    }
  }
}
```

## 4. Configuration reference

| Variable | Purpose | Default |
| --- | --- | --- |
| `EXPLAINER_API_BASE_URL` | Base URL of the running Explainer app API (no trailing slash needed; one is stripped). | `http://127.0.0.1:5555` |
| `EXPLAINER_API_TOKEN` | Sent as `Authorization: Bearer <token>` on every request. | unset (no auth header sent) |

Two things to get right:

1. **Base URL / port.** The MCP default is `127.0.0.1:5555`, but the app is served on **`localhost:3000`**. You MUST set `EXPLAINER_API_BASE_URL=http://localhost:3000` or every call hits the wrong port and returns `API_UNAVAILABLE`.
2. **Token must match the server.** The app accepts bearer auth only when the token equals the app server's own `EXPLAINER_API_TOKEN` (service token). The MCP server never mints tokens; it forwards exactly what you give it. So the app must be started with `EXPLAINER_API_TOKEN=<secret>` and the MCP launched with the *same* `<secret>`. If they differ, every authenticated tool returns `UNAUTHENTICATED`.

The MCP server never reads secrets on its own and never returns them in tool payloads.

## 5. Response envelope

Every tool returns MCP `structuredContent` plus a text mirror. Shape:

```json
{ "ok": true, "data": { ... } }
```

```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "...", "details": { ... } } }
```

Failed calls also set `isError: true`. React on `error.code` (section 9), not on message text.

## 6. Tool catalog

### Read-only

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_projects` | `{}` | `{ projects: ProjectSummary[] }` |
| `get_project` | `{ projectId }` | `{ project }` |
| `get_scene` | `{ projectId, sceneId }` | `{ projectId, scene }` (NOT_FOUND if missing) |
| `get_validation_report` | `{ projectId }` | `{ projectId, report }` (blockers/warnings) |
| `get_production_plan` | `{ projectId }` | `{ projectId, report }` (statuses + dependencies) |
| `get_project_compositions` | `{ projectId, compositionId? }` | `{ projectId, available, latest, compositions }` |

`get_project_compositions` entries carry `compositionId, createdAt, duration, width, height, fps, sceneCount, filesize, downloadPath` (newest first). It never returns MP4 bytes — Hermes fetches the file from `downloadPath` with the same bearer token.

### Authoring

| Tool | Arguments |
| --- | --- |
| `create_project` | `{ title?, description?, durationTarget? (≤600), aspectRatio? ("16:9"\|"1:1"\|"9:16"), fps? (≤120) }` |
| `update_project` | `{ projectId, project }` (`project` is a partial patch) |
| `plan_scene_intents` | `{ projectId, project? }` |
| `approve_scene_intents` | `{ projectId, intentIds? }` |
| `materialize_scene_intents` | `{ projectId, project?, intentIds? }` |
| `manage_project_music` | `{ projectId, action ("generate"\|"regenerate"\|"select"\|"clear"), prompt?, musicLengthMs? (3000-600000), instrumental?, model?, provider?, seed?, outputFormat?, assetId?, mode? ("mock"\|"real") }` |

Notes:

- `create_project` is **not** idempotent — two calls create two projects. Call `list_projects` first to reuse.
- `update_project` merges your patch into the stored project, then validates. Invalid input returns `VALIDATION_FAILED` with `details.errors` / `details.warnings`. **`project.scenes` is replaced wholesale, not merged**: when you send `scenes`, include every field you want to keep (each scene's `id`, `order`, `type`, `visual`, `render`, `overlay`, `narration`, ...). Send only complete scene objects.
- `plan_scene_intents` derives intents from `explainer.story.beats`; re-planning skips beats that already have an intent. New intents are created with status `draft`.
- `approve_scene_intents` moves intents to status `approved`. Pass `intentIds` to approve a subset, or omit it to approve every intent. Already-approved ids are reported under `skipped`; an unknown id returns `NOT_FOUND`. Approval is **required** before materialization — drafts are never auto-approved.
- `materialize_scene_intents` turns **approved** intents into concrete scenes; already-materialized intents are reported under `skipped`. Requesting a draft intent directly fails.
- `manage_project_music`: `select` needs `assetId` and is free; `clear` is free; `generate` refuses with `CONFLICT` if music exists; `regenerate` overwrites. `generate`/`regenerate` in `real` mode is an **explicit paid action**, executed once and never retried automatically.

#### Narration is scene-level

The **source of truth for production narration is `scene.narration.text`, per scene** — there is no project-level narration fallback for production. Write narration by sending scenes through `update_project` (remember: the whole `scenes` array is replaced):

```json
{
  "projectId": "project-...",
  "project": {
    "scenes": [
      {
        "id": "scene-1",
        "order": 1,
        "type": "blank",
        "visual": { "kind": "blank" },
        "render": { "motion": { "preset": "zoom_in" }, "transition": { "type": "fade" } },
        "overlay": { "type": "none" },
        "narration": { "text": "First scene spoken line." }
      },
      {
        "id": "scene-2",
        "order": 2,
        "type": "blank",
        "visual": { "kind": "blank" },
        "render": { "motion": { "preset": "zoom_in" }, "transition": { "type": "fade" } },
        "overlay": { "type": "none" },
        "narration": { "text": "Second scene spoken line." }
      }
    ]
  }
}
```

A scene with narration text but no audio asset is planned as a `narration_generate` action. A scene with empty narration is blocked (`Narration text is missing.`) until you set `narration.text`.

#### Text overlays are scene-level (`scene.overlay`)

Each scene can draw one text overlay on top of its frame. It is authored inside the same complete scene objects:

```json
{
  "type": "title",
  "text": "50% faster: a quick look",
  "position": "top",
  "style": { "fontSize": 72, "color": "#f8fafc", "box": true, "margin": 64 },
  "timing": { "fadeInSeconds": 0.5, "fadeOutSeconds": 0.4 }
}
```

Contract:

- `type`: `"none" | "text" | "title" | "subtitle" | "callout" | "statistic" | "quote"`. The overlay only renders when `type` is not `"none"` **and** `text` is non-blank.
- `position` (optional): `"top" | "center" | "bottom"`. When omitted a sensible default is derived from `type` (`title` -> top; `statistic`/`quote` -> center; otherwise bottom).
- `style` (optional): `fontSize` (24-220), `color` (hex `#rgb`/`#rrggbb`, `0xrrggbb`, or FFmpeg named color such as `white`/`black@0.45`), `box` (boolean background plate), `margin` (16-240).
- `timing` (optional): `fadeInSeconds` / `fadeOutSeconds` (0-600; additionally clamped to the scene duration at render time).
- All `style`/`timing` fields are optional. Omitted or `null` fields fall back to the renderer defaults (`fadeInSeconds` defaults to `0.4`, `fadeOutSeconds` to `0`; font size and margin derive from the frame size and overlay type). Explicitly present values are validated; out-of-range or wrong-typed values are rejected with `VALIDATION_FAILED` rather than silently clamped.
- `data` (optional) is retained as free-form metadata.
- Overlays are **not** drawn on `text` scenes: their whole frame is authored copy, so adding an overlay would duplicate it.
- Changing any overlay field changes the scene render fingerprint, so an already-rendered scene becomes **stale** and is re-rendered by the next production run.

To disable an overlay, set `type` to `"none"` (or omit `overlay`, which normalizes to `{ "type": "none" }`).

> **`scenes[]` is replaced wholesale.** `update_project` does not merge scenes field-by-field. When you send `scenes`, include every field you want to keep for every scene (`id`, `order`, `type`, `visual`, `render`, `overlay`, `narration`, `referenceIds`, `notes`, and any existing `renders`) — otherwise those fields are lost. There is no nested merge for `overlay.style`/`overlay.timing` either; send the complete overlay object. Fetch the current project/scene first (`get_project` / `get_scene`) and modify the returned objects.

### Production

| Tool | Arguments | Returns |
| --- | --- | --- |
| `run_production` | `{ projectId, mode? ("mock"\|"real"), providers? { image? ("fake"\|"openai"), video? ("local"\|"openai"), narration? ("fake"\|"elevenlabs") }, force? (boolean), maxIterations? (≤10000), limits? { image_generate, video_submit, video_poll, narration_generate, scene_render, final_compose (each 1-128) } }` | `{ run, reused }` |
| `get_run_status` | `{ runId }` | `{ run }` |
| `get_run_log` | `{ runId, cursor?, limit? (≤2000) }` | `{ log }` |

Notes:

- There is **no `music` key in `providers`** — music is controlled only via `manage_project_music`.
- `run_production` returns the existing active run instead of starting a duplicate; check `reused`.
- Poll `get_run_status` until `run.status` is terminal: `completed`, `partial`, `failed`, or `unresolved`. Read `get_run_log` (paginated via `log.nextCursor` / `log.hasMore`) for per-action detail.
- `mode: "real"` requires the app server to run with `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true`. Credentials are required **only for the modalities the run actually executes**: if the plan needs image generation and/or video generation with the `openai` provider, the app server needs `OPENAI_API_KEY`; if it needs narration with `elevenlabs`, it needs `ELEVENLABS_API_KEY`. Unused modalities do not force a choice — an image-only project may leave `video` at `"local"` (or omit `video` entirely) without affecting the run. Missing real-provider mode returns `POLICY_DENIED`; a non-real provider for a needed modality returns `PROVIDER_NOT_ALLOWED`; missing credentials return `PROVIDER_NOT_CONFIGURED`. Default is mock; keep mock unless a paid run is explicitly intended.
- `mode: "real"` does **not** mean every modality makes a paid call — only the actions in the production plan that are `ready`/`running` run, and only their providers are validated.
- By default a run **reuses existing outputs**: an action whose asset is already `current` is skipped with `already current` in the log, even in real mode. So a real run over mock-generated assets may complete with `0 action(s) completed`. Pass `force: true` to regenerate the current outputs once (image/video/narration regeneration cascades into re-render and re-compose). Forcing does not loop: each action is forced only until it completes in that run.
- **Image model**: the OpenAI image model defaults to `gpt-image-1` and can be set with `OPENAI_IMAGE_MODEL`, or per scene at `scenes[].visual.generation.model`. `dall-e-3` and `dall-e-2` are supported with their own valid sizes. `gpt-image-1` is often rejected (`provider.request.unauthorized` / `provider.request.rejected`) for organizations that are not verified for it — switch to `dall-e-3` if that happens.
- **Failure detail**: a failed generation records `status: "failed"` plus `error`/`errorMessage` and a machine-readable `errorCode` (e.g. `PROVIDER_AUTH`, `PROVIDER_RATE_LIMIT`, `PROVIDER_REJECTED`, `MEDIA_INVALID`, `NOT_CONFIGURED`). A generation marked failed by recovery after a process restart carries `error: "Interrupted by process restart."`.

## 7. Typical end-to-end flow (all via MCP)

```text
 1. list_projects              {}                         // find or confirm a project
 2. create_project             { title, durationTarget, fps }        -> { projectId }
 3. update_project             { projectId, project: { explainer: { story: { beats: [...] } } } }
 4. plan_scene_intents         { projectId }                        -> { createdIntentIds }
 5. approve_scene_intents      { projectId }                        -> { approved[], skipped[] }
 6. materialize_scene_intents  { projectId }                        -> { materialized[], skipped[] }
 7. update_project             { projectId, project: { scenes: [...] } }   // set scene.narration.text per scene
 8. get_validation_report      { projectId }                        // inspect blockers before running
 9. manage_project_music       { projectId, action: "generate", prompt, mode: "mock" }   // optional, separate from runs
10. run_production             { projectId, mode: "mock" }          -> { run: { runId, status }, reused }
11. get_run_status             { runId }                            // poll to terminal
12. get_run_log                { runId, cursor: 0, limit: 50 }      // paginate via nextCursor
13. get_project_compositions   { projectId }                        -> { latest: { downloadPath } }
14. GET <downloadPath>                                              // HTTP GET with the same bearer token -> MP4 bytes
```

Steps 4-6 turn story beats into scenes (plan creates drafts; approve unblocks; materialize creates scenes). Step 7 is where production narration text is written. If you already know your scenes, you can skip 4-6 and author `scenes` directly in step 7.

## 8. Steps that are REST-only (not MCP tools)

- **Asset / reference upload and listing** (`POST /api/projects/{id}/assets`, references) — multipart; call directly.
- **Downloading the finished MP4** — `get_project_compositions` gives the `downloadPath`; do a plain authenticated HTTP GET yourself.
- **Session / token bootstrap** — `POST /api/auth/session` issues a browser session cookie. This is outside the MCP server and is only relevant in local non-production mode.

## 9. Error codes

| Condition | MCP code |
| --- | --- |
| Bad tool arguments (schema) | `INVALID_ARGUMENT` |
| HTTP 400 (authoring) / `music.invalid` / `music.asset.invalidType` | `INVALID_ARGUMENT` |
| HTTP 422 (project validation) | `VALIDATION_FAILED` (`details.errors`, `details.warnings`) |
| HTTP 401 | `UNAUTHENTICATED` |
| HTTP 403 / `POLICY_DENIED` | `FORBIDDEN` (production client keeps `POLICY_DENIED`) |
| HTTP 404 / `music.project.notFound` / `music.asset.notFound` | `NOT_FOUND` |
| HTTP 409 / `music.alreadyGenerated` / `music.alreadyRunning` | `CONFLICT` |
| HTTP 429 / `music.provider.rateLimited` | `RATE_LIMITED` |
| `music.provider.notConfigured` | `PROVIDER_NOT_CONFIGURED` |
| `music.provider.auth/rejected/unsupported/failed` | `PROVIDER_ERROR` |
| HTTP 503 (missing FFmpeg) — production tools | `FFMPEG_UNAVAILABLE` |
| Network failure reaching the app | `API_UNAVAILABLE` |
| Other non-2xx | `API_ERROR` |

## 10. Guarantees and boundaries

- All tools reuse the app's existing REST routes, validation, ownership checks, and throttling. No second REST implementation, no separate production engine, no extra server process.
- Identity and ownership are enforced server-side; the MCP server never returns secrets.
- Mock mode calls no paid providers. Real-mode generation (music, and any real provider run) is a single explicit action per call, with no automatic retries.
- Tool tests use mocked MCP/REST only; no real paid provider calls.

## 11. Troubleshooting

- **`API_UNAVAILABLE` on every call** — wrong base URL/port. Set `EXPLAINER_API_BASE_URL=http://localhost:3000` (MCP default is 5555).
- **`UNAUTHENTICATED` on every call** — the MCP `EXPLAINER_API_TOKEN` does not match the app server's `EXPLAINER_API_TOKEN`. Start/restart the app with the token and give the MCP the identical value.
- **`FFMPEG_UNAVAILABLE`** — no `ffmpeg`/`ffprobe` on the app server's `PATH`; install FFmpeg where the app runs.
- **Real run rejected** — `POLICY_DENIED` means server real-provider mode is off; `PROVIDER_NOT_ALLOWED` means a needed modality is set to a non-real provider in real mode (or a real provider in mock mode); `PROVIDER_NOT_CONFIGURED` means a needed modality's credentials are missing on the app server (`OPENAI_API_KEY` for image/video, `ELEVENLABS_API_KEY` for narration).
- **`materialize_scene_intents` produces no scenes** — the intents are still `draft`. Call `approve_scene_intents` first (approval is never automatic).
