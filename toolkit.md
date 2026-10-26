# Toolkit — Local Explainer Video Studio

Capability palette for Hermes / Claude. Use this to pick a visual language before authoring. Operational contract, error codes, and safety rules live in `agent_manual.md`. This file does not invent tools.

Last verified against branch `261021-feat-motion-canvas-animation-mcp` (commit `ba08522` plus P210.4).

MCP is a stdio proxy over the app REST API. 27 tools: 10 read-only, 14 authoring, 3 production. Start the app (`npm run dev`, usually `:3000`) before the MCP server (`npm run mcp:local`). Same `EXPLAINER_API_TOKEN` on both sides. Default MCP base URL is **not** `:3000`; set `EXPLAINER_API_BASE_URL`.

Every tool returns `{ ok: true, data }` or `{ ok: false, error: { code, message, details? } }`. Branch on `error.code`.

---

## 1. What a video is

A project is local JSON plus files under `projects/{id}/`. Production turns scenes into one H.264 `yuv420p` MP4 (default 1920x1080 @ 30 fps).

```
story beats -> intents -> scenes -> visuals/assets -> production run -> compositions[].downloadPath
```

Two look-and-feel modes:

| Look | How | Typical use |
| --- | --- | --- |
| Full-frame scene | no `scene.composition`, optional `renderSettings.studio` | classic explainer |
| Photo studio set | `scene.composition.preset = "studio"` plus imported stills | news / desk show |

Studio stills are **imported, never generated**: `studio_back.png`, `studio_desk.png`, `studio_intro.png`, `studio_outtro.png` (spelling is `outtro`). Unsplash hotlinks cannot fill `studio-screen`; that layer needs a local file (Pixabay/Pexels/fake download, HTML still, Motion Canvas, or `import_asset`).

---

## 2. MCP tools

### Read

| Tool | Args | Notes |
| --- | --- | --- |
| `list_projects` | `{}` | summaries |
| `get_project` | `{ projectId }` | full document; compositions omit `outputPath` |
| `get_scene` | `{ projectId, sceneId }` | one scene |
| `get_validation_report` | `{ projectId }` | blockers + warnings |
| `get_production_plan` | `{ projectId }` | actions, deps, status |
| `get_project_compositions` | `{ projectId, compositionId? }` | metadata + `downloadPath`; no MP4 bytes |
| `get_generation_job` | `{ projectId, attemptId }` | **mutates**: polls provider, may download asset |
| `get_mandate_status` | `{ projectId }` | existing user-minted mandate; never mints or revokes |
| `list_animation_templates` | `{}` | catalog only |
| `search_stock_photos` | `{ projectId, query, orientation?, providers?, limit?, mode? }` | discovery; refreshes server cache |

### Author

| Tool | Args | Notes |
| --- | --- | --- |
| `create_project` | `{ title?, description?, durationTarget? (<=600), aspectRatio? ("16:9"\|"1:1"\|"9:16"), fps? }` | not idempotent; service caller also gets one-time `claimToken` |
| `update_project` | `{ projectId, project }` | shallow top-level merge; **`scenes` replaces the whole array** |
| `plan_scene_intents` | `{ projectId, project? }` | from `explainer.story.beats` |
| `approve_scene_intents` | `{ projectId, intentIds? }` | **browser session only**; service token = `FORBIDDEN` |
| `materialize_scene_intents` | `{ projectId, project?, intentIds? }` | creates `type/visual = blank`; does not pick a source |
| `manage_project_music` | `{ projectId, action, ... }` | `generate` \| `regenerate` \| `select` \| `clear` |
| `create_reference` | `{ projectId, name, contentBase64, mimeType?, fileName?, ... }` | video keyframes; PNG/JPEG/WebP <= 25 MB |
| `import_asset` | `{ projectId, filename, mimeType, dataBase64 }` | stills for HTML slots / `visual.kind=asset` |
| `import_studio_assets` | `{ projectId, fileNames }` | copy from `STUDIO_IMPORT_SOURCE_DIR` |
| `generate_video` | `{ projectId, sceneId, regenerate?, provider?, model?, mode? }` | one scene; then poll `get_generation_job` |
| `cancel_video` | `{ projectId, sceneId }` | explicit cancel only |
| `render_animation_template` | `{ projectId, templateId, params? }` | Motion Canvas -> asset |
| `attach_animation` | `{ projectId, sceneId, assetId, destination, startSeconds?, durationSeconds?, scale?, position?, rect? }` | `bigscreen` or `overlay` |
| `select_stock_photo` | `{ projectId, sceneId, searchId, photoId, query?, orientation?, regenerate?, mode? }` | choose one search hit |

### Produce

| Tool | Args |
| --- | --- |
| `run_production` | `{ projectId, mode?, providers?, music?, force?, maxIterations?, limits? }` |
| `get_run_status` | `{ runId }` | terminal `run.report` has QC status, MP4 probe, scene counts |
| `get_run_log` | `{ runId, cursor?, limit? }` |

`mode`: `"mock"` (default) or `"real"`. Real needs `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true`. A browser session also needs current `explainer.humanApproval`. A service token cannot approve; it needs a previously user-minted live production mandate (`get_mandate_status`). MCP never mints or revokes a mandate.

Providers (real vs mock):

| Modality | Mock | Real |
| --- | --- | --- |
| image | `fake` | `openai` |
| video | `local` | `openai` \| `fal` |
| narration | `fake` | `elevenlabs` |
| music | `fake` | `elevenlabs` |
| presenter | `mock` | `heygen` |

Run actions, in order: `stock_select` -> `image_generate` -> `html_render` -> `video_submit` -> `video_poll` -> `narration_generate` -> `presenter_submit` -> `presenter_poll` -> `scene_render` -> `final_compose`.

Do **not** invent: scene-render MCP, compose MCP, generate_narration, generate_image, presenter_submit, list_assets, download_mp4, extra animation template ids, `create_mandate`, `revoke_mandate`.

---

## 3. REST map (same capabilities)

MCP tools are thin wrappers. Useful extras with **no** MCP tool:

| REST | Why |
| --- | --- |
| `POST /api/auth/session` | anonymous local session for the UI |
| `POST /api/projects/{id}/claim` | body `{ token }`; browser user only |
| `POST` / `DELETE /api/projects/{id}/mandates` | mint/revoke; **browser user only**. MCP reads via `get_mandate_status` |
| `GET /api/projects/{id}/compositions/{compositionId}/file` | MP4 bytes (bearer token) |
| `GET /api/projects/{id}/assets` | list assets |
| `GET /api/projects/{id}/assets/{assetId}/file` | asset bytes |
| `GET /api/projects/{id}/files/{...path}` | project file |
| `POST /api/projects/{id}/scenes/{sceneId}/render` | one scene MP4 |
| `POST /api/projects/{id}/compose` | final compose |
| `POST /api/projects/{id}/scenes/{sceneId}/select-stock-image` `action=auto` | production auto-select |
| `POST /api/projects/{id}/scenes/{sceneId}/generate-image` | paid image; no MCP |
| `POST /api/projects/{id}/scenes/{sceneId}/generate-narration` | paid TTS; no MCP |
| `POST /api/projects/{id}/scenes/{sceneId}/render-html-still` | Chromium still |
| `GET /api/animation-templates` | same catalog as the MCP tool |
| `GET /api/health` | liveness |

UI Produce ready uses the same server-run as MCP: `POST /api/projects/{id}/production-runs`. Claim form is on `/` and `/projects`. After claim, the MCP service token still bypasses owner checks.

---

## 4. Building blocks to mix

### Project

- `title`, `description`, `durationTarget` (s, max 600), `aspectRatio`, `fps`
- `renderSettings`: size, `fit` (`cover`\|`contain`), background color, audio mix, `subtitlesEnabled`, project `logo`, `graphicStyle`, optional `studio` overlay
- `explainer.story.beats` for the intent pipeline
- `music` via `manage_project_music` (not a scene field)
- `presenter` object is replaced wholesale when patched

### Scene skeleton

Every scene needs `id`, `order`, `type`, `visual`, `render`, `overlay`, `narration`, `referenceIds`, `notes`. Optional: `logo`, `composition`, `duration`. Missing fields on a wholesale `scenes` patch are gone.

`type`: `image` | `video` | `graphic` | `text` | `blank` | `html`

### Visual source (`scene.visual.kind`)

Pick **one** per scene. `narrativeRole` / `visualIntent` are metadata only; they never select a source. Materialize always yields `blank`.

| Kind | When | Production action |
| --- | --- | --- |
| `blank` | placeholder | none (blocked if you need a picture) |
| `text` | full-frame copy | scene_render |
| `asset` | local still (`import_asset`) | scene_render |
| `graphic` | built-in card, no Chromium | scene_render |
| `html` | Chromium template or custom html/css | `html_render` then scene_render |
| `stock_image` | query + optional orientation/providers | `stock_select` (or `select_stock_photo` first) |
| `generated_image` | paid still; **no MCP submit** | `image_generate` inside a run |
| `generated_video` | prompt + optional refs/provider/model | `video_submit` / `video_poll` or `generate_video` |

Prefer HTML / graphic / local / stock. Paid image or video only after explicit permission. Keep existing non-blank kinds. Keep stock `selection.origin = "manual"`.

### HTML stills (`type` + `visual.kind` = `html`)

Canonical templates:

| Id | Intent | Key `templateData` |
| --- | --- | --- |
| `headline` | hook / title | `title`, `subtitle?`, `kicker?`, `source?`, `imageAssetId?` |
| `stat_card` | one number | `label`, `value`, `detail?`, `trend?` (`up`\|`down`\|`flat`), `delta?` |
| `comparison` | 2-4 columns | `title`, `items[].name/features` |
| `chart` | bar or line | `title`, `kind` (`bar`\|`line`), `points[].label/value`, `unit?` |
| `timeline` | sequence | `title`, `events[].label/detail/date?` |
| `location_card` | place | `place`, `region?`, `detail?`, `lat?`, `lon?` |
| `route_map` | schematic map | `title`, `locations[]`, `links[]` |
| `product_card` | one product | `name`, `price?`, `features?`, `imageAssetId?` |
| `product_comparison` | products | `title`, `products[].name/imageAssetId?/features` |
| `feature_callouts` | annotated still | `name`, `imageAssetId?`, `callouts[].label/detail/side?` |
| `flow_diagram` | process | `title`, `steps[]`, `links[]` |
| `decision_tree` | Q/A tree | `title`, `nodes[]` (`question`\|`outcome`), `branches[]` |
| `system_diagram` | components | `title`, `components[]`, `links[]` |

Aliases still valid: `headline_card`, `comparison_card`, `stat-card`. Custom `html`/`css` is allowed without a template. `imageAssetId` must be a **local** project asset from `import_asset`, never a stock CDN URL. Optional colors: `background`, `accent`, `textColor`. `html_render` writes a PNG and binds it to the studio bigscreen when composition is studio.

### Graphic cards (`visual.kind = graphic`)

No Chromium. Templates: `title_card`, `bullet_list`, `statistic`, `quote`, `comparison`, `simple_diagram`, `callout`, `end_card`. Palette via `visual.style` or `renderSettings.graphicStyle` (`background`, `textColor`, `accentColor`, `statisticLabelColor`). AI Dev Forum preset: `#0056a7` / white / `#ff5a5f`.

### Stock

1. Set `visual.kind = "stock_image"` with `query` (orientation `landscape`\|`portrait`\|`squarish`, optional `preferredProviders`).
2. `search_stock_photos` with `providers`: `unsplash` | `pexels` | `pixabay` | `fake`.
3. `select_stock_photo` with server `searchId` + `photoId` (e.g. `pixabay:42`). No URLs, no paths.

Download providers (Pexels, Pixabay, fake) persist a local asset. Unsplash **hotlinks** the CDN; that cannot fill `studio-screen`. Mock search is locked to `fake`. Expired cache -> re-search, then choose. Production `stock_select` auto-picks unpinned scenes.

### Studio composition (`scene.composition`)

Canvas 1920x1080. Preset `"studio"`. Layers (back to front):

| Id | Type | Role | z |
| --- | --- | --- | --- |
| `studio-back` | background | set wall (`studio_back` or intro/outtro still) | 0 |
| `studio-screen` | image | bigscreen content (photo, HTML PNG, Motion Canvas MP4) | 10 |
| `studio-presenter` | presenter | avatar clip | 20 |
| `studio-overlay` | overlay | Nix / lower-third video (default rect 1648,200 260x390) | 25 |
| `studio-desk` | foreground | `studio_desk.png` | 30 |

Presenter layer on the composition (this is what the UI inspector edits):

- `mode`: `full_canvas` | `pip`
- `pipPreset`: `intro` (larger, top-right) | `news` (smaller, top-right)

Do not confuse with `project.presenter.sceneSettings.layout` (`fullscreen` | `pip`), which is generation placement, not compositor mode.

Bigscreen rect is roughly `{ x: 293, y: 98, width: 1346, height: 761 }`. Fit: `contain` | `cover`. Timed layers: `startSeconds`, `durationSeconds`.

Import stills:

```text
import_studio_assets { fileNames: ["studio_back.png", "studio_desk.png", "studio_intro.png", "studio_outtro.png"] }
```

Typical three-beat show: intro still on back + title on screen; news with stock/HTML on screen + desk + optional PiP; outro still. Presenter may be off (`presenter.enabled: false`).

### Presenter (HeyGen / mock)

Patch the **complete** `presenter` object:

- `enabled`, `avatarId`, `provider` (`mock`\|`heygen`), `outputFormat` (`mp4`\|`webm`)
- `sceneSettings[]`: `sceneId`, `layout` (`fullscreen`\|`pip`), `pip.position/widthRatio/marginRatio`, `startOffsetSeconds`
- paid guards: `maxGeneratedSeconds` (ceiling 300), `maxPaidRequests` (ceiling 5), **`maxCostUsd` required for real** (ceiling 25)

No standalone presenter MCP. Generation only inside `run_production`. Needs current per-scene narration audio. `presenterClips` is server output; do not author it. Stock HeyGen avatars are not automatically cleared for publication.

For a no-avatar studio video: `enabled: false`, mock run, no presenter actions.

### Overlays, logo, motion

Text overlay `scene.overlay.type`: `none` | `text` | `title` | `subtitle` | `callout` | `statistic` | `quote`. Non-blank `text` for visible types. `position`: `top` | `center` | `bottom`. `style`: fontSize 24-220, color, box, margin 16-240. `timing`: fade 0-600 s. Not drawn on `text` scenes.

Logo `scene.logo`: `{ assetId, position, scale 0.02-0.5, maxWidth 8-4096, margin 0-400, opacity 0-1 }` or `null` to disable a project default. Positions: `top_left` | `top_right` | `bottom_left` | `bottom_right`. Asset must be image/graphic.

Motion `scene.render.motion.preset`: `none`, `zoom_in`, `zoom_out`, `pan_left`, `pan_right`, `pan_up`, `pan_down`, `zoom_left`, `zoom_right`. Transition: `none` | `fade` | `crossfade`.

### Narration and music

Production copy is **per scene**: `scene.narration.text`. Empty scene is blocked; text without audio plans `narration_generate`. Optional `voiceId`, `model`, `format` (`mp3`\|`wav`\|`m4a`), or reuse `audioAssetId` (existing project audio; `import_asset` is images only).

Music is project-level. `manage_project_music`: generate/regenerate (paid in real), select existing `assetId`, or clear. `generate` conflicts if music already exists.

### Motion Canvas

Only these ids:

| Id | Destination | Output | Params |
| --- | --- | --- | --- |
| `northwind_arr_chart` | bigscreen | 1920x1080 H.264 MP4 | `title`, `subtitle`, `labels[]`, `values[]`, `colors[]`, `background`, `holdSeconds` |
| `nix_overlay` | overlay | 520x780 VP9 WebM + alpha | `badge`, `bodyColor`, `headColor`, `badgeColor` |

`list_animation_templates` -> `render_animation_template` -> `attach_animation`. No generated code, no extra ids. Attach does not move presenter PiP or desk.

### Video generation (when asked)

`visual.kind = "generated_video"` with `generation.prompt`, optional `provider` (`openai`\|`fal`\|`local`), `model` (FAL hints: `minimax/h3-max-turbo/text-to-video` or `.../image-to-video`), `startFrameReferenceId` / `endFrameReferenceId` from `create_reference` + `scene.referenceIds`. Submit once (`generate_video` or a run); poll the same `attemptId`. Never resubmit a live job.

---

## 5. Recipes (pick and adapt)

### A. No-cost studio news (default for experiments)

```text
create_project
import_studio_assets
update_project                 // 3 scenes, presenter.enabled=false, composition preset studio
                               // intro/outtro stills; news bigscreen = fake stock or HTML
get_validation_report
run_production { mode: "mock" }
get_run_status -> terminal     // inspect run.report.qcStatus before treating the MP4 as good
get_project_compositions
GET downloadPath               // bearer token
```

Hand `claimToken` to the operator (never in a URL). Operator claims on `/` or `/projects`, edits inspector (overlay / logo / presenter mode / Motion Canvas), Save, Produce ready. Then `get_project` again before any further `update_project`.

### B. Fact explainer without studio

HTML `chart` / `stat_card` / `flow_diagram` scenes, graphic `title_card` hook, per-scene narration, mock run. No presenter.

### C. Product walkthrough

`import_asset` product stills -> HTML `product_card` / `feature_callouts` with `imageAssetId` -> mock run.

### D. Mood B-roll

`stock_image` + search + `select_stock_photo` (Pixabay if it must land on studio-screen). Not Unsplash for studio.

### E. Chart animation + mascot

`render_animation_template northwind_arr_chart` -> attach `bigscreen`; `nix_overlay` -> attach `overlay` with timing; mock run.

### F. Paid talking-head (explicit permission only)

Complete `presenter` with `maxCostUsd`, current narration, human approval or a live mandate, `run_production mode=real` with `providers.presenter=heygen`. Read `get_production_plan` first. Do not auto-retry a failed real clip.

### G. Autonomous one-project videoproductie (user-minted mandate)

User already minted a mandate in the UI (**Let the agent finish this video**). Hermes does not mint, revoke, or wait for `approve_scene_intents`.

```text
get_mandate_status              // stop unless live=true
update_project                  // complete scenes; skip intent approve
run_production { mode: "real" }
get_run_status -> terminal
get_project_compositions
GET downloadPath
```

---

## 6. Authoring discipline

1. `get_project` before every patch. After a UI save, re-fetch before sending `scenes`.
2. Propose visual kinds in chat; wait for approval; then patch. Do not search stock during propose.
3. `update_project` replaces `scenes`, `presenter`, `renderSettings`, `music` wholesale.
4. Mock first. Real/paid needs env flag + credentials for **used** modalities only, plus human approval (browser) or a live production mandate (service / Hermes). Check `get_mandate_status` before paid MCP work. Mandate `budgets.max*Submits` are hard server limits; `maxCostUsd` is hard only for HeyGen presenter estimates.
5. Fail closed: missing file, unclear intent, `POLICY_DENIED`, `PROVIDER_NOT_CONFIGURED` -> stop and report. Do not invent tools, template ids, photoIds, or studio PNGs.
6. Download MP4 yourself from `downloadPath`. There is no MCP download tool.

`agent_manual.md` remains the operational source of truth (errors, presenter cost, maintenance). This toolkit is the menu.