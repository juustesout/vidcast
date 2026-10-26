# Agent Manual (canonical)

Operational manual for an AI agent (Hermes or any MCP client) that drives the
Local Explainer Video Studio end-to-end through the local MCP server.

This file is the single maintained source of truth for agent-facing behavior.
`docs/hermes-mcp-manual.md` is kept only as a pointer to this document.

Last verified: 2026-10-25
Base commit: `ba08522` plus P210.4 mandate budget enforcement.

## 1. Compatibility summary

Hermes can run the complete product workflow through MCP: read projects, author
scenes, manage music and references, run a mock or real production, and fetch
the finished MP4. Presenter generation is part of that production run.

| Function | Available to Hermes | How |
| --- | --- | --- |
| List/read projects, scenes, validation, plan | Yes | Read-only tools |
| Production mandate status | Yes, read-only | `get_mandate_status`; MCP never mints or revokes |
| Create/update project, scenes, narration, overlays | Yes | `create_project`, `update_project` |
| Story beats to scenes | Plan/materialize yes; approve is human-session only | `plan_scene_intents`, `materialize_scene_intents`; `approve_scene_intents` is refused for the service token |
| Reference images | Yes | `create_reference` (base64 JSON) |
| Music select/generate/clear | Yes | `manage_project_music` |
| Per-scene video submit/poll/cancel | Yes | `generate_video`, `get_generation_job`, `cancel_video` |
| Motion Canvas template list/render/attach | Yes | `list_animation_templates`, `render_animation_template`, `attach_animation` |
| Full production incl. render and final compose | Yes | `run_production` |
| Presenter authoring | Yes | `update_project` with a complete `presenter` object |
| Presenter generation and polling | Yes, only inside a production run | `run_production` with `providers.presenter` |
| Standalone presenter submit/poll | No | No MCP tool and no REST route; use a production run |
| Standalone narration generation | No | No MCP tool; use a production run |
| Standalone image generation | No | No MCP tool; use a production run |
| Standalone render/compose | No | No MCP tool; use a production run |
| Asset upload/listing | REST listing; MCP import for PNG/JPEG/WebP stills and studio stills | `GET /api/projects/{id}/assets`; `import_asset`; `import_studio_assets` |
| Stock photo search | Yes, discovery only | `search_stock_photos` |
| Stock photo select | Yes, choose one search hit | `select_stock_photo` |
| Stock photo auto-select | Production only | `stock_select` inside `run_production` |
| Studio stills from tmp_images | Yes | `import_studio_assets` |
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

There are 27 tools: 10 read-only, 14 authoring, 3 production.

### Read-only

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_projects` | `{}` | `{ projects: ProjectSummary[] }` |
| `get_project` | `{ projectId }` | `{ project }` including assets, scenes, presenter and presenterClips. Compositions omit `outputPath` and use the same `downloadPath` projection as `get_project_compositions`. |
| `get_scene` | `{ projectId, sceneId }` | `{ projectId, scene }` |
| `get_validation_report` | `{ projectId }` | `{ projectId, report }` with blockers and warnings |
| `get_production_plan` | `{ projectId }` | `{ projectId, report }` with action statuses and dependencies |
| `get_project_compositions` | `{ projectId, compositionId? }` | `{ projectId, available, latest, compositions }` |
| `get_generation_job` | `{ projectId, attemptId }` | Current video attempt state |
| `get_mandate_status` | `{ projectId }` | `{ projectId, live, mandate }` for the existing user-minted production mandate |
| `list_animation_templates` | `{}` | `{ templates }` with id, destination, output, allowedParamKeys, paramsSchema, defaults |
| `search_stock_photos` | `{ projectId, query, orientation?, providers?, limit?, mode? }` | `{ searchId, query, orientation?, cached, results, diagnostics, quota }` |

`get_project_compositions` entries carry `compositionId`, `createdAt`,
`duration`, `width`, `height`, `fps`, `sceneCount`, `filesize`, and
`downloadPath`. It never returns MP4 bytes.

`get_generation_job` is **not** a pure read. Each call refreshes the attempt
against the provider and persists the new state, exactly like a run's
`video_poll` step. A transient failure returns `providerStatus:
"status_unresolved"` and keeps the job resumable. Retry the same attempt; never
resubmit a live provider job.

`get_mandate_status` reads `GET /api/projects/{id}/mandates`. It never mints,
revokes, or forges a mandate. `live` is true when the mandate currently
authorizes service real/paid work (`active`, or `consumed` with `boundRunId`
and not expired/revoked/failed). Status is resolved at read time. Missing
mandate returns `NOT_FOUND`. Mint and revoke remain browser-session
`POST`/`DELETE` on the same route.

`search_stock_photos` discovers stock candidates through
`GET /api/projects/{id}/stock/search`. It returns `searchId`, sanitized results
(provider, photoId, dimensions, preview/image/source URLs, photographer,
`license`, `usagePolicy`), diagnostics, and quota. Searching is not selecting
and not downloading: it never writes a scene, never persists a stock asset, and
never assigns `templateData.imageAssetId`. HTML slots accept local project
asset ids from `import_asset`, not stock CDN URLs. Mock mode is locked to the
`fake` provider. Real mode requires a current human approval of the project
snapshot (`explainer.humanApproval`) for a browser session, or a live
production mandate for the service token. The call may consume provider quota
and refresh the server-side candidate cache.

### Authoring

| Tool | Arguments |
| --- | --- |
| `create_project` | `{ title?, description?, durationTarget? (<=600), aspectRatio? ("16:9"\|"1:1"\|"9:16"), fps? (<=120) }` |
| `update_project` | `{ projectId, project }` where `project` is a partial project patch |
| `plan_scene_intents` | `{ projectId, project? }` |
| `approve_scene_intents` | `{ projectId, intentIds? }` (browser user session only; service token returns FORBIDDEN) |
| `materialize_scene_intents` | `{ projectId, project?, intentIds? }` |
| `manage_project_music` | `{ projectId, action, ... }` |
| `create_reference` | `{ projectId, name, contentBase64, mimeType?, fileName?, description?, tags? }` |
| `import_asset` | `{ projectId, filename, mimeType, dataBase64 }` |
| `import_studio_assets` | `{ projectId, fileNames }` |
| `generate_video` | `{ projectId, sceneId, regenerate?, provider?, model?, mode? }` |
| `cancel_video` | `{ projectId, sceneId }` |
| `render_animation_template` | `{ projectId, templateId, params? }` |
| `attach_animation` | `{ projectId, sceneId, assetId, destination, startSeconds?, durationSeconds?, scale?, position?, rect? }` |
| `select_stock_photo` | `{ projectId, sceneId, searchId, photoId, query?, orientation?, regenerate?, mode? }` |

`manage_project_music` accepts `action: "generate" | "regenerate" | "select" |
"clear"`, plus `prompt`, `musicLengthMs` (3000-600000), `instrumental`, `model`,
`provider`, `seed`, `outputFormat`, `assetId`, and `mode: "mock" | "real"`.
`select` requires `assetId`; `clear` needs neither. `generate` refuses with
`CONFLICT` if music already exists; `regenerate` overwrites.

`create_reference` takes raw base64 or a full `data:image/...;base64,...` URL.
Accepted decoded formats are PNG, JPEG, and WebP, capped at 25 MB. Returns the
`referenceId`, stored path, dimensions, and size.

`import_asset` imports a PNG, JPEG, or WebP still into `project.assets[]` for
later HTML-slot assignment. `filename` must be a bare name with a matching
extension; `mimeType` must be `image/png`, `image/jpeg`, or `image/webp`;
`dataBase64` is raw base64 image bytes (not a data URL, path, or remote URL).
Declared MIME, extension, and actual bytes must agree. Decoded payload is
capped at 25 MB. The server generates `assetId` and `localPath`; provenance is
`imported`. Assign the returned `assetId` with `update_project` as
`templateData.imageAssetId` or `products[i].imageAssetId`. This is not
`create_reference` (video keyframes), not `import_studio_assets`, not
`search_stock_photos`, and not `select_stock_photo`. HTML slots reject stock
CDN URLs.

`select_stock_photo` applies one candidate from a prior `search_stock_photos`
call through `POST /api/projects/{id}/scenes/{sceneId}/select-stock-image`
with `action: "choose"`. Required: `projectId`, `sceneId`, `searchId`, and
`photoId` (the composite `results[].id`, e.g. `pexels:42`). The server-side
search cache is the only candidate authority; image URLs, download URLs, file
paths, and client-supplied asset ids are rejected. The scene must already be
`visual.kind="stock_image"`. Download providers (Pexels, Pixabay, fake) may
persist a local asset with provenance `stock` and set `scene.visual.assetId`;
hotlink providers (Unsplash) keep the CDN URL and attribution without creating
an asset. This never writes HTML-slot `imageAssetId`. Production auto-select
for stock scenes remains the `stock_select` action inside `run_production`.
Mock mode is locked to `fake`. Expired or unknown candidates return
`CONFLICT` (`stock.search.expired`).

`import_studio_assets` copies named files from `STUDIO_IMPORT_SOURCE_DIR`
(the operator `tmp_images` folder) into `assets/studio/` on the project.
`fileNames` must be an explicit list of bare names such as `studio_back.png`,
`studio_desk.png`, `studio_intro.png`, and `studio_outtro.png`. Extra
png/jpg/jpeg/webp names are allowed. Absolute paths, `..`, and overwrite of
existing project files are rejected. Returns project-relative `localPath`
values; later work must use those, never `tmp_images`.

`create_project` is not idempotent. Call `list_projects` first if reuse is
intended. It creates one default scene; overwrite the scene array when authoring
your own scenes.

When the caller is a service, `create_project` returns a single-use
`claimToken`. Hand it to the intended browser user out-of-band; never put it in
a URL, log, or analytics event. It is returned only once.

`generate_video` is the manual single-scene path. Submit once, then poll with
`get_generation_job`. A scene with an active job returns `CONFLICT`, so a second
paid submit cannot start.

`list_animation_templates` returns the server-owned Motion Canvas catalog.
Known ids are `northwind_arr_chart` (opaque 1920x1080 H.264 bigscreen) and
`nix_overlay` (transparent 520x780 VP9/WebM overlay). Do not invent ids.

`render_animation_template` renders one catalog template into a project asset
through the local headless Motion Canvas pipeline. `params` is optional
structured JSON merged with catalog defaults. Unknown keys, generated code,
and unsafe paths are rejected. A failed render does not attach anything.

`attach_animation` writes that asset onto `scene.composition`.
`destination=bigscreen` updates `studio-screen` (`type: image`, z=10).
`destination=overlay` updates `studio-overlay` (`type: overlay`, z=25,
rect default `{x:1648,y:200,width:260,height:390}`). Presenter PiP and desk
stay unchanged. Timed playback uses `startSeconds` / `durationSeconds`.

### Production

| Tool | Arguments | Returns |
| --- | --- | --- |
| `run_production` | `{ projectId, mode?, providers?, music?, force?, maxIterations?, limits? }` | `{ run, reused }` |
| `get_run_status` | `{ runId }` | `{ run }` including `run.report` on terminal runs |
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

### Visual source playbook

`narrativeRole` and `visualIntent` are scene-intent metadata. They never
select a visual source. `plan_scene_intents` leaves `visualIntent` empty;
beat 1 is `hook` and the rest are `explanation`. `materialize_scene_intents`
always creates `type: "blank"` / `visual.kind: "blank"` and copies
`visualIntent` into `scene.notes`. The production planner then follows
`scene.visual.kind` only: it does not infer HTML, stock, or generation from
the story.

#### Propose → Wait → Apply

Do not set `visual.kind` until the user has approved a per-scene proposal.
There is no suggest tool. During this step, only read existing project state
with `get_project` or `get_scene` and show the proposal in chat. Do not call
`search_stock_photos`, `select_stock_photo`, `update_project`,
`generate_video`, or `run_production`.

For each scene, output:

```text
sceneId:
action: keep_existing | propose | ask
proposed.kind:
proposed.template:          // when html or graphic
reason:
missingInputs:              // asset ids to import, query text, or none
permissionRequired: none | image_generate | video_submit
```

- `visual.kind` other than `blank` → `keep_existing`, even if another template
  looks better. This includes `asset`, `html`, `text`, `graphic`,
  `stock_image`, `generated_image`, and `generated_video`. A composition
  layer is not a reason to replace `visual.kind`. A stock selection with
  `selection.origin` `manual` stays pinned.
- Empty or unclear `visualIntent`, or uncertainty → `ask`. Leave the scene
  blank.
- Product template that needs an image, with no suitable local asset → `ask`.
  Name the missing product still, or ask whether a product card without
  `imageAssetId` is acceptable. Do not import an asset and do not patch the
  scene before approval.
- Mood or environment on a blank scene → `propose` `stock_image` even when
  the search query is still missing. Set `missingInputs: search query`. This
  proposal does not call `search_stock_photos` or `select_stock_photo`. After
  approval, ask for a query or suggest one, then follow the stock tool chain.
- Other `propose` cases: blank scenes where the playbook has a first choice
  and every listed input already exists on the project.
- Template ids must be known HTML or graphic ids. Asset ids must already
  appear in `get_project`. Do not invent `photoId` or stock CDN URLs. Stock
  choose happens only after approval, from a later `search_stock_photos`.
- `permissionRequired` is `none` unless the user already asked for generated
  imagery or video. Paid generation is never a default proposal.

**Stop after the proposal. Wait for explicit user approval.** Only then follow
the playbook tool chains below. A proposal is not a patch.

Choose a source first (after approval), then set `visual.kind` with
`update_project`. Do not change an existing non-blank kind. Do not replace a
stock selection with `origin: "manual"`. Prefer local or HTML sources. Paid
image or video generation requires explicit user permission. If the intent is
missing or ambiguous, leave the scene blank and ask.

| Intent | First choice | Fallback | Do not do autonomously |
| --- | --- | --- | --- |
| Fact, statistic, chart | HTML `chart` or `stat_card` | graphic `statistic` | `image_generate` |
| Process or system | HTML `flow_diagram`, `system_diagram`, or `decision_tree` | graphic `simple_diagram` | generated video |
| Product with a local still | HTML `product_card` or `feature_callouts` plus `import_asset` | `visual.kind: "asset"` | stock CDN URL in an HTML slot |
| Product without a still | `ask` (missing product photo, or confirm a card without `imageAssetId`) | — | generated product photo; do not import before approval |
| Mood or environment | `propose` `stock_image` (`missingInputs: search query` if needed); after approval, `search_stock_photos` then `select_stock_photo`, or an existing local asset | — | `image_generate` unless asked; do not search during propose |
| Motion or demonstration | existing video asset, or `generated_video` after permission | still plus overlay | extra `video_submit` |
| Hook or CTA | HTML `headline` or graphic `title_card` / `end_card` | `text` | stock unless mood is requested |
| Missing or unclear intent | leave blank and ask | `get_project` for assets and references | set a paid kind |

#### Tool chains

After every write, verify with `get_project` (and `get_scene` when checking
one scene). Confirm `visual.kind`, template / `templateData`, local asset ids,
and stock `selection.origin`.

HTML fact or diagram:

```text
get_project
update_project    // type=html, visual.kind=html, template + templateData
get_project       // confirm template and local imageAssetId if any
run_production    // html_render writes the PNG
```

Product with a still:

```text
import_asset
get_project       // copy the returned assetId
update_project    // html product_card or feature_callouts; templateData.imageAssetId
get_project       // confirm the slot is a local asset id, not a URL
```

Mood / stock:

```text
update_project              // visual.kind=stock_image, query, optional orientation
search_stock_photos
select_stock_photo          // searchId + photoId; action=choose only
get_project                 // selection.origin=manual; download may set visual.assetId
```

If `select_stock_photo` returns `CONFLICT` (`stock.search.expired`), call
`search_stock_photos` again and choose explicitly. Do not invent `photoId`,
do not pass image URLs or file paths, and do not write stock CDN URLs into
HTML slots. `select_stock_photo` never assigns `templateData.imageAssetId`.

Local still as the scene visual:

```text
import_asset
update_project    // visual.kind=asset, visual.assetId
get_project
```

Graphic card (no `html_render`):

```text
update_project    // visual.kind=graphic, template title_card|bullet_list|statistic|quote|comparison|simple_diagram|callout|end_card
get_project
```

Generated video, only after explicit permission:

```text
create_reference              // if image-to-video frames are needed
update_project                // visual.kind=generated_video, prompt, refs
generate_video                // or run_production
get_generation_job
```

There is no standalone image-generation MCP tool. Setting
`visual.kind: "generated_image"` and calling `run_production` in real mode is
a paid `image_generate`. Do not do that unless the user asked for generated
imagery. Production `stock_select` still auto-selects unpinned `stock_image`
scenes; use `select_stock_photo` when the photo must be a specific search hit.

#### Safety rules

- Do not treat `visualIntent` or `narrativeRole` as a source selector.
- Set or change `visual.kind` only after a deliberate source choice.
- Keep existing non-blank visuals. Keep stock selections with
  `origin: "manual"`.
- HTML `imageAssetId` and `products[i].imageAssetId` must be local project
  asset ids from `import_asset`. Stock CDN URLs are rejected.
- `select_stock_photo` is choose-only. Do not call production auto-select for
  curation.
- Expired search: re-search, then choose. Never auto-choose.
- No paid image, video, music, or presenter call without explicit permission.
  Use mock mode first when exploring structure.
- Missing asset, unclear intent, mock/real provider conflict, or
  `POLICY_DENIED`: fail closed, do not guess, ask for input.
- `materialize_scene_intents` does not pick a visual. Author `visual.kind`
  afterwards.

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
- `outputFormat`: `"mp4"` or `"webm"`; default `mp4`. A generated clip is
  current only when its stored format matches this request. An MP4 clip is
  not reused for a WebM request, and the reverse is also true. Code checks
  do not prove that a chosen avatar supports WebM matting.
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
| `presenter.scene.alreadyGenerated` (409) | Current clip exists for this format; regenerate explicitly |

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
`log.nextCursor` and `log.hasMore`. Terminal snapshots include `run.report`: QC
status (`passed` / `failed` / `partial`), MP4 download path and probe
(codec, resolution, fps, duration, audio), scene counts, recovery attempts,
warnings, failure causes, and mandate/budget status when available. A successful
compose job is not enough; treat `run.report.qcStatus` as the output quality
result. QC never starts a new paid submit. If `report.recovery.resumeSafe` is
true, resume the same run instead of submitting again.

Notes:

- `mode: "real"` requires `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true` on
  the app server. A browser session also needs a current human approval of the
  project snapshot (`explainer.humanApproval`). That includes real stock search.
  A service token cannot grant that approval. `update_project` cannot forge intent `status: "approved"` or
  the human-approval record. For MCP, check `get_mandate_status` first: a
  previously user-minted live production mandate for that exact project is the
  service-token substitute. The first accepted real `run_production` binds
  `boundRunId`; reuse rechecks the mandate. Revoked, expired, or failed
   mandates block new paid work. MCP never mints, revokes, or forges a mandate.
   When a live mandate has `budgets`, those submit counts are enforced
   server-side before every paid image, video, narration, music, or presenter
   submit, together with the host spend cap. `maxCostUsd` is enforced only for HeyGen presenter estimates; OpenAI, FAL, and ElevenLabs costs are recorded
   after the fact when known and never invented. Failed and unresolved submits
   still count. Stock search is not a billed submit on this ledger.
- Mock FFmpeg compose and `mode: "mock"` production may still be started by the
  service token without human approval.
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
approve_scene_intents           // human browser session only; MCP/service token is FORBIDDEN
materialize_scene_intents
get_project                     // propose visual sources in chat; wait for approval
update_project                  // visual.kind per the visual source playbook; narration and overlays
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
approve_scene_intents           // human browser session only; service uses a live mandate instead
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

### D. Motion Canvas chart + Nix overlay

```text
list_animation_templates
render_animation_template { templateId: "northwind_arr_chart" }
attach_animation { destination: "bigscreen", startSeconds: 0, durationSeconds: 5 }
render_animation_template { templateId: "nix_overlay" }
attach_animation { destination: "overlay", startSeconds: 0.2, durationSeconds: 4 }
get_scene
run_production { mode: "mock" }
get_project_compositions
```

Do not eval TypeScript, do not call a shell, and do not invent template ids.
Use only the assetId/localPath returned by `render_animation_template`.

### E. Download the final file

```bash
# Use the token the app and MCP share.
curl -H "Authorization: Bearer $EXPLAINER_API_TOKEN" \
  -o final.mp4 \
  "http://localhost:3000/api/projects/PROJECT_ID/compositions/COMPOSITION_ID/file"
```

### F. Autonomous one-project videoproductie under a user mandate

The user mints a production mandate in the project workspace with
**Let the agent finish this video** (`POST /api/projects/{id}/mandates`).
Hermes does not mint, revoke, or wait for per-step `approve_scene_intents` /
snapshot approval.

```text
get_mandate_status              // stop if NOT_FOUND or live=false
create_project / get_project
update_project                  // complete scenes, narration, visuals; skip intent approve
import_asset / create_reference / import_studio_assets as needed
search_stock_photos { mode: "real" }   // only with a live mandate
select_stock_photo
manage_project_music { mode: "real" }  // optional
get_validation_report
run_production { mode: "real", ... }   // binds boundRunId on first accept
get_run_status                  // poll to terminal; reuse is allowed while live
get_mandate_status              // if live=false, stop new paid work
get_project_compositions
GET downloadPath
```

If `get_mandate_status` returns `NOT_FOUND`, revoked, expired, or failed: stop
and tell the user to mint or refresh the mandate in the UI. Do not invent
`create_mandate` or `revoke_mandate` tools. Mock mode still needs no mandate.
A `mandate.budget.exceeded` error means the user-set submit or known USD limit
is spent; do not retry that paid submit.

## 9. REST-only operations

These have no MCP tool:

- Multipart browser upload `POST /api/projects/{id}/assets` and REST listing
  `GET /api/projects/{id}/assets`. There is no `list_assets` MCP tool; discover
  imported stills through `get_project`. JSON PNG/JPEG/WebP import uses
  `import_asset`. Studio stills from the operator source directory use
  `import_studio_assets` / `POST /api/projects/{id}/studio-assets`.
- Claiming an ownerless project with the single-use token:
  `POST /api/projects/{id}/claim`.
- Minting or revoking a production mandate:
  `POST` / `DELETE /api/projects/{id}/mandates` (browser user session only).
  Status reads use `get_mandate_status`.
- Downloading a composition file:
  `GET /api/projects/{id}/compositions/{compositionId}/file`.
- Direct single-scene render and project compose:
  `POST /api/projects/{id}/scenes/{sceneId}/render` and
  `POST /api/projects/{id}/compose`. The production runner calls the same logic.
- Direct presenter submit/poll: not exposed. Use `run_production`.
- Stock photo auto-select:
  `POST /api/projects/{id}/scenes/{sceneId}/select-stock-image` with
  `action: "auto"`. Manual choose of a search hit uses `select_stock_photo`.
  Production `stock_select` still runs the auto path.

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
- Materialized scenes are blank: expected. Choose `visual.kind` with the visual
  source playbook before `run_production`. Do not set `generated_image` just to
  make the planner busy.
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
