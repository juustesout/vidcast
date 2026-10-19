# Agent Manual (canonical)

Operational manual for an AI agent (Hermes or any MCP client) that drives the
Local Explainer Video Studio end-to-end through the local MCP server.

This file is the single maintained source of truth for agent-facing behavior.
`docs/hermes-mcp-manual.md` is kept only as a pointer to this document.

Last verified: 2026-10-18
Base commit: `5ef4a87` plus the P40.3 working-tree changes (presenter cost guard
and scene-end timing fix).

## 1. Compatibility summary

Hermes can run the complete product workflow through MCP: read projects, author
scenes, manage music and references, run a mock or real production, and fetch
the finished MP4. Presenter generation is part of that production run.

| Function | Available to Hermes | How |
| --- | --- | --- |
| List/read projects, scenes, validation, plan | Yes | Read-only tools |
| Create/update project, scenes, narration, overlays | Yes | `create_project`, `update_project` |
| Story beats to scenes | Yes | `plan_scene_intents`, `approve_scene_intents`, `materialize_scene_intents` |
| Reference images | Yes | `create_reference` (base64 JSON) |
| Music select/generate/clear | Yes | `manage_project_music` |
| Per-scene video submit/poll/cancel | Yes | `generate_video`, `get_generation_job`, `cancel_video` |
| Full production incl. render and final compose | Yes | `run_production` |
| Presenter authoring | Yes | `update_project` with a complete `presenter` object |
| Presenter generation and polling | Yes, only inside a production run | `run_production` with `providers.presenter` |
| Standalone presenter submit/poll | No | No MCP tool and no REST route; use a production run |
| Standalone narration generation | No | No MCP tool; use a production run |
| Standalone image generation | No | No MCP tool; use a production run |
| Standalone render/compose | No | No MCP tool; use a production run |
| Asset upload/listing | REST only | `POST`/`GET /api/projects/{id}/assets` |
| Download final MP4 | REST only | Authenticated `GET` of `downloadPath` |
| Delete project | No | Not exposed |

The presenter path is the only feature with a deliberate asymmetry: authoring is
granular, but paid execution is intentionally reachable only through the
budgeted production runner. That is a safety property, not an oversight.

## 2. Architecture and launch

- Exactly one MCP server process: `explainer-local-mcp` v0.1.0.
- Entrypoint: `mcp/read-only/server.ts`.
- Transport: stdio JSON-RPC. Hermes launches it as a child process.
- The MCP server keeps no state. Every tool call proxies to the running app's
  REST API.
- The app and the MCP server are separate processes. Start the app first.

Start the app from the repository root:

```bash
npm run dev
```

Start the MCP server manually (normally Hermes does this):

```bash
npm run mcp:local
```

### Hermes stdio configuration

```json
{
  "mcpServers": {
    "explainer-local": {
      "command": "npx",
      "args": ["tsx", "mcp/read-only/server.ts"],
      "cwd": "/absolute/path/to/explainer",
      "env": {
        "EXPLAINER_API_BASE_URL": "http://localhost:3000",
        "EXPLAINER_API_TOKEN": "<same token the app was started with>"
      }
    }
  }
}
```

If the `npx` launcher closes the stdio connection in your environment, use a
wrapper script that exports the two variables and runs
`npx tsx mcp/read-only/server.ts`. A wrapper avoids launcher resolution issues.

### Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `EXPLAINER_API_BASE_URL` | App base URL, trailing slash stripped | `http://127.0.0.1:5555` |
| `EXPLAINER_API_TOKEN` | Sent as `Authorization: Bearer <token>` | unset (no auth header) |

The default port is **not** the dev-server port. Always set the base URL to the
port the app actually listens on, normally `http://localhost:3000`.

The token must be identical on both sides. The app accepts bearer auth only when
the token matches its own `EXPLAINER_API_TOKEN`; the MCP server forwards exactly
what it is given and never mints or prints tokens.

## 3. Response envelope and errors

Every tool returns MCP `structuredContent` plus a text mirror.

```json
{ "ok": true, "data": { } }
```

```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "..." } }
```

Failed calls also set `isError: true`. Branch on `error.code`, not on message
text.

| Condition | Code |
| --- | --- |
| Bad tool arguments | `INVALID_ARGUMENT` |
| Project validation failure | `VALIDATION_FAILED` with `details.errors` and `details.warnings` |
| Missing project/scene/asset/intent | `NOT_FOUND` |
| Duplicate or conflicting state | `CONFLICT` |
| Missing or wrong bearer token | `UNAUTHENTICATED` |
| Ownership or policy denial | `FORBIDDEN` (production may return `POLICY_DENIED`) |
| Provider credentials missing | `PROVIDER_NOT_CONFIGURED` |
| Provider rejected or failed | `PROVIDER_ERROR` |
| App unreachable | `API_UNAVAILABLE` |
| FFmpeg missing on the app host | `FFMPEG_UNAVAILABLE` |
| Rate limit | `RATE_LIMITED` |
| Other non-2xx | `API_ERROR` |

## 4. Tool catalog

There are 19 tools: 7 read-only, 9 authoring, 3 production.

### Read-only

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_projects` | `{}` | `{ projects: ProjectSummary[] }` |
| `get_project` | `{ projectId }` | `{ project }` including assets, scenes, presenter and presenterClips |
| `get_scene` | `{ projectId, sceneId }` | `{ projectId, scene }` |
| `get_validation_report` | `{ projectId }` | `{ projectId, report }` with blockers and warnings |
| `get_production_plan` | `{ projectId }` | `{ projectId, report }` with action statuses and dependencies |
| `get_project_compositions` | `{ projectId, compositionId? }` | `{ projectId, available, latest, compositions }` |
| `get_generation_job` | `{ projectId, attemptId }` | Current video attempt state |

`get_project_compositions` entries carry `compositionId`, `createdAt`,
`duration`, `width`, `height`, `fps`, `sceneCount`, `filesize`, and
`downloadPath`. It never returns MP4 bytes.

`get_generation_job` is **not** a pure read. Each call refreshes the attempt
against the provider and persists the new state, exactly like a run's
`video_poll` step. A transient failure returns `providerStatus:
"status_unresolved"` and keeps the job resumable. Retry the same attempt; never
resubmit a live provider job.

### Authoring

| Tool | Arguments |
| --- | --- |
| `create_project` | `{ title?, description?, durationTarget? (<=600), aspectRatio? ("16:9"\|"1:1"\|"9:16"), fps? (<=120) }` |
| `update_project` | `{ projectId, project }` where `project` is a partial project patch |
| `plan_scene_intents` | `{ projectId, project? }` |
| `approve_scene_intents` | `{ projectId, intentIds? }` |
| `materialize_scene_intents` | `{ projectId, project?, intentIds? }` |
| `manage_project_music` | `{ projectId, action, ... }` |
| `create_reference` | `{ projectId, name, contentBase64, mimeType?, fileName?, description?, tags? }` |
| `generate_video` | `{ projectId, sceneId, regenerate?, provider?, model?, mode? }` |
| `cancel_video` | `{ projectId, sceneId }` |

`manage_project_music` accepts `action: "generate" | "regenerate" | "select" |
"clear"`, plus `prompt`, `musicLengthMs` (3000-600000), `instrumental`, `model`,
`provider`, `seed`, `outputFormat`, `assetId`, and `mode: "mock" | "real"`.
`select` requires `assetId`; `clear` needs neither. `generate` refuses with
`CONFLICT` if music already exists; `regenerate` overwrites.

`create_reference` takes raw base64 or a full `data:image/...;base64,...` URL.
Accepted decoded formats are PNG, JPEG, and WebP, capped at 25 MB. Returns the
`referenceId`, stored path, dimensions, and size.

`create_project` is not idempotent. Call `list_projects` first if reuse is
intended. It creates one default scene; overwrite the scene array when authoring
your own scenes.

When the caller is a service, `create_project` returns a single-use
`claimToken`. Hand it to the intended browser user out-of-band; never put it in
a URL, log, or analytics event. It is returned only once.

`generate_video` is the manual single-scene path. Submit once, then poll with
`get_generation_job`. A scene with an active job returns `CONFLICT`, so a second
paid submit cannot start.

### Production

| Tool | Arguments | Returns |
| --- | --- | --- |
| `run_production` | `{ projectId, mode?, providers?, music?, force?, maxIterations?, limits? }` | `{ run, reused }` |
| `get_run_status` | `{ runId }` | `{ run }` |
| `get_run_log` | `{ runId, cursor?, limit? (<=2000) }` | `{ log }` |

Provider values:

- `image`: `"fake" | "openai"`
- `video`: `"local" | "openai" | "fal"`
- `narration`: `"fake" | "elevenlabs"`
- `music`: `"fake" | "elevenlabs"`
- `presenter`: `"mock" | "heygen"`

Mode defaults:

| Modality | Mock mode | Real mode |
| --- | --- | --- |
| image | `fake` | `openai` |
| video | `local` | `openai` |
| narration | `fake` | `elevenlabs` |
| music | `fake` | `elevenlabs` |
| presenter | `mock` | `heygen` |

Limits are per action type and bounded to 1-128, except `presenter_submit`
(1-4), `presenter_poll` (1-8), and render/compose (bounded by the FFmpeg
concurrency limit).

## 5. Authoring contract

### Patches replace top-level values

`update_project` performs a shallow merge at the top level. Objects such as
`presenter`, `renderSettings`, and `music` are replaced wholesale, and arrays
are replaced wholesale. To change one nested field, first read the current
object with `get_project`, then send the complete object back.

`project.scenes` is always replaced wholesale. Send every scene you want to
keep, with every field you want to keep: `id`, `order`, `type`, `visual`,
`render`, `overlay`, `narration`, `referenceIds`, `notes`, and existing
`renders`. There is no nested merge for `overlay.style` or `overlay.timing`.

### Narration

Production narration is per scene in `scene.narration.text`. There is no
project-level narration fallback for production. A scene with text but no audio
is planned as `narration_generate`; an empty scene is blocked.

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
      }
    ]
  }
}
```

### Text overlays

`scene.overlay` supports `type`: `"none" | "text" | "title" | "subtitle" |
"callout" | "statistic" | "quote"`.

- `text` must be non-blank for a visible overlay.
- `position`: `"top" | "center" | "bottom"`; defaults by type.
- `style`: `fontSize` 24-220, hex or named `color`, `box`, `margin` 16-240.
- `timing`: `fadeInSeconds` and `fadeOutSeconds` from 0 to 600, clamped to the
  scene duration at render time.
- Overlays are not drawn on `text` scenes.

Out-of-range explicit style/timing values are rejected with
`VALIDATION_FAILED`, not silently clamped. Changing an overlay changes the scene
render fingerprint and makes the scene stale.

### Per-scene logo overlays

`scene.logo` is optional and accepts an `assetId` plus `position`
(`top_left`, `top_right`, `bottom_left`, `bottom_right`), `scale` (0.02-0.5),
`maxWidth` (8-4096 px), `margin` (0-400 px) and `opacity` (0-1). The asset must
be an `image` or `graphic`. `null` explicitly disables a project-level default
from `renderSettings.logo`; an explicit scene value wins. The same asset may be
reused by any number of scenes. Logos are composited above stock images,
generated visuals and graphic cards, after text overlays. References are not
logo overlays.

When patching `scenes`, include the `logo` field on every scene that should keep
one; scenes are replaced wholesale. Missing or invalid logo assets produce
validation warnings and the scene renders without the logo. See
`docs/scene-logo-overlay.md`.

### Graphic palette

`visual.style` on a `graphic` visual, or `renderSettings.graphicStyle` as a
project default, accepts hex colors for `background`, `textColor`,
`accentColor` and `statisticLabelColor`. Omitted fields keep the historical
template colors. The AI Dev Forum preset is `AI_DEV_FORUM_GRAPHIC_STYLE` in
`lib/render/graphic-style.ts` (`#0056a7` background, white primary text,
`#ff5a5f` accent, light coral statistic label).

### Visuals and references

Set video scenes through `update_project`:

```json
{
  "visual": {
    "kind": "generated_video",
    "generation": {
      "prompt": "A slow push-in on the subject",
      "provider": "fal",
      "model": "minimax/h3-max-turbo/image-to-video",
      "startFrameReferenceId": "ref-start",
      "endFrameReferenceId": "ref-end"
    }
  },
  "referenceIds": ["ref-start", "ref-end"]
}
```

Start and end frame ids must be part of the effective reference set
(`scene.referenceIds`, or `generation.referenceIds` when set).

### Presenter authoring

The `presenter` object is complete and replaces the previous object:

```json
{
  "projectId": "project-...",
  "project": {
    "presenter": {
      "enabled": true,
      "avatarId": "your-heygen-avatar-id",
      "provider": "heygen",
      "outputFormat": "mp4",
      "sceneSettings": [
        {
          "sceneId": "scene-1",
          "layout": "pip",
          "pip": {
            "position": "bottom_right",
            "widthRatio": 0.28,
            "marginRatio": 0.03
          }
        }
      ],
      "maxGeneratedSeconds": 60,
      "maxPaidRequests": 1,
      "maxCostUsd": 1.0
    }
  }
}
```

Fields:

- `enabled`: required to activate presenter output.
- `avatarId`: project override. Real generation falls back to
  `HEYGEN_AVATAR_ID`; without either it fails.
- `provider`: `"mock"` or `"heygen"`. `fake` and `local` normalize to `mock`.
- `outputFormat`: `"mp4"` or `"webm"`; default `mp4`.
- `sceneSettings`: up to 40 entries, one per scene.
  - `layout`: `"fullscreen"` or `"pip"`.
  - `pip.position`: default `bottom_right`.
  - `pip.widthRatio`: 0.12-0.55, default 0.28; server clamps.
  - `pip.marginRatio`: 0-0.08, default 0.03; server clamps.
  - `startOffsetSeconds`: optional positive trim from the start of the clip.
- `maxGeneratedSeconds`: default 60, server ceiling 300.
- `maxPaidRequests`: default 1, server ceiling 5.
- `maxCostUsd`: required for paid generation, server ceiling 25. Authoring may
  lower these budgets but cannot raise them past the ceilings.

`presenterClips` is server-managed output. Do not author it. `get_project`
returns it, including per-attempt `cost` and wallet balance before submission.

## 6. Presenter pipeline

### Ordering

1. Author scenes and per-scene narration.
2. Author the complete `presenter` object.
3. Ensure narration audio is current. Presenter submission requires current
   narration; a stale, missing, or failed narration blocks it.
4. Run production with the desired presenter provider. The plan emits
   `presenter_submit` and, while a provider job is active, `presenter_poll`.
5. Render and compose wait for presenter actions to settle. The final frame of
   the presenter clip is held to the end of the scene when the clip is shorter
   than the scene.

### Paid safety

Real presenter generation is fail-closed:

- The app server must have `HEYGEN_PRICING_JSON` with an exact matching rate.
- `HEYGEN_AVATAR_TYPE` must identify the avatar class.
- The scene's rendered height selects `720p` or `1080p`.
- `presenter.maxCostUsd` must be set.
- The estimate uses billable increments, then rounds up to cents when
  configured.
- A blocked request makes **zero** provider calls.

Relevant failures:

| Error | Meaning |
| --- | --- |
| `presenter.cost.notConfigured` (409) | Pricing, avatar type, or USD budget missing |
| `presenter.budget.exceeded` (403) | Seconds, request count, or USD estimate over budget |
| `presenter.narration.notCurrent` (409) | Narration text/audio is missing or stale |
| `presenter.scene.notConfigured` (409) | Presenter is not enabled for that scene |
| `presenter.scene.alreadyRunning` (409) | A submit or provider job is in flight |
| `presenter.scene.alreadyGenerated` (409) | Clip exists; regenerate explicitly |

Pricing configuration is not a public tariff. It must reflect the account's
actual contract. Observed wallet delta is stored separately from the estimate;
it can include rounding or other account activity and is not a per-job invoice.

The production runner deliberately blocks an automatic paid retry after a
failed real presenter clip. There is currently no MCP tool or REST route for an
operator-approved presenter retry; use the application's explicit flow rather
than editing `presenterClips` to bypass the guard.

### Publication rights

Do not claim that a stock HeyGen avatar is licensed for publication. Paid
Creator/Pro/Business plans grant broad commercial use of generated output, but
stock-avatar model releases are not automatically included. Written HeyGen
confirmation is required before publishing such a video. Details are in
`docs/heygen-stock-avatar-licensing.md`.

## 7. Production runs

`run_production` starts a server-side run or returns the existing active run.
Check `reused`.

Poll `get_run_status` until `run.status` is terminal: `completed`, `partial`,
`failed`, or `unresolved`. Use `get_run_log` for per-action detail; paginate with
`log.nextCursor` and `log.hasMore`.

Notes:

- `mode: "real"` requires `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true` on the app
  server.
- Credentials are required only for modalities the run actually executes.
- A non-real provider for a needed modality in real mode is rejected.
- A real provider in mock mode is rejected.
- Existing current outputs are reused. A real run over mock assets can finish
  with zero completed actions.
- `force: true` regenerates current image, video, narration, render, and
  compose outputs once. It does **not** force a presenter regeneration, and it
  does not override the paid-retry guard.
- Background music can be handled by `providers.music` plus the `music` object,
  or separately by `manage_project_music`. `music.generate` and
  `music.selectAssetId` are mutually exclusive.
- Scene renders and final compose run inside the production runner. There are no
  standalone MCP tools for them.
- Each run updates durable project state, so an interrupted run can be resumed
  by calling `run_production` again.

## 8. Recipes

### A. Full mock explainer

```text
list_projects
create_project
update_project                  // story beats or complete scenes
plan_scene_intents
approve_scene_intents
materialize_scene_intents
update_project                  // per-scene narration and overlays
get_validation_report
run_production { mode: "mock" }
get_run_status                  // poll to terminal
get_project_compositions
GET downloadPath
```

### B. Real video with a presenter

```text
get_project                     // verify scenes, narration, presenter
update_project                  // complete presenter object with maxCostUsd
get_production_plan             // confirm presenter actions are ready, not blocked
run_production {
  mode: "real",
  providers: { image: "openai", video: "fal", narration: "elevenlabs", presenter: "heygen" },
  limits: { presenter_submit: 1, presenter_poll: 8 }
}
get_run_status
get_run_log
get_project                     // presenterClips[].attempts[].cost for accounting
get_project_compositions
```

### C. Single scene video

```text
create_reference
update_project                  // generated_video visual plus start/end frames
generate_video { mode: "real", provider: "fal", model: "..." }
get_generation_job              // repeat the same attemptId until terminal
cancel_video                    // only when cancellation is intended
```

### D. Download the final file

```bash
# Use the token the app and MCP share.
curl -H "Authorization: Bearer $EXPLAINER_API_TOKEN" \
  -o final.mp4 \
  "http://localhost:3000/api/projects/PROJECT_ID/compositions/COMPOSITION_ID/file"
```

## 9. REST-only operations

These have no MCP tool:

- `POST /api/projects/{id}/assets` and `GET /api/projects/{id}/assets`
  (multipart upload, listing).
- Claiming an ownerless project with the single-use token:
  `POST /api/projects/{id}/claim`.
- Downloading a composition file:
  `GET /api/projects/{id}/compositions/{compositionId}/file`.
- Direct single-scene render and project compose:
  `POST /api/projects/{id}/scenes/{sceneId}/render` and
  `POST /api/projects/{id}/compose`. The production runner calls the same logic.
- Direct presenter submit/poll: not exposed. Use `run_production`.

## 10. Troubleshooting

- `API_UNAVAILABLE` on every call: wrong base URL or port. Set
  `EXPLAINER_API_BASE_URL` to the app's actual URL, normally
  `http://localhost:3000`.
- `UNAUTHENTICATED` on every call: MCP and app tokens differ. Restart the app
  with `EXPLAINER_API_TOKEN` and give the MCP the identical value.
- `FFMPEG_UNAVAILABLE`: install FFmpeg on the app host so `ffmpeg` and
  `ffprobe` are on `PATH`.
- `POLICY_DENIED`: real provider mode is disabled on the app server.
- `PROVIDER_NOT_CONFIGURED`: the needed provider credentials are absent.
- `PROVIDER_ERROR`: inspect `get_run_log`; do not blindly resubmit a paid job.
- `materialize_scene_intents` creates nothing: intents are still drafts. Approve
  them first.
- Presenter submit is blocked: read the action reason from
  `get_production_plan`. Common causes are stale narration, a missing
  `maxCostUsd`, missing pricing configuration, an exhausted budget, or an
  interrupted submission that must be verified in the provider dashboard.
- Presenter clip looks shorter than the scene: expected. The final frame is held
  to the scene end; only a mismatch above 0.5 seconds emits a composition
  warning.

## 11. Maintenance contract

Keep this file current whenever any of these change:

- MCP tool names, arguments, or descriptions: `mcp/read-only`, `mcp/authoring`,
  `mcp/production`.
- Project patch semantics: `lib/projects/project-patch-shape.ts`,
  `lib/projects/project-update.ts`, `lib/projects/normalize-project.ts`.
- Presenter schema, budgets, or errors: `lib/types/presenter.ts`,
  `lib/presenter/config.ts`, `lib/presenter/pricing.ts`,
  `lib/generation/presenter-service.ts`.
- Production behavior: `lib/production/production-planner.ts`,
  `lib/production/run-service.ts`, `lib/production/run-policy.ts`.
- Agent-visible REST routes under `app/api/projects/[id]`.

Checklist for a change:

1. Update this manual in the same change as the behavior.
2. Run `npm test -- tests/agent-manual.test.ts` (or the full suite).
3. The test fails if a registered MCP tool is missing from this file, which
   keeps the catalog from silently drifting.
4. Update the "Last verified" line when the behavior is re-verified.
