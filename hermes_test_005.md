# hermes_test_005.md - Real studio assets + production E2E (Hermes / MCP)

Status: ready to run only after operator preconditions in section 2 are met
Owner: Hermes (MCP client agent)
Scope: prove the complete studio video workflow with the operator's real stills,
a real stock photo on the 1920x1080 bigscreen, a real transparent HeyGen WebM
presenter, and the existing production pipeline. A standalone FFmpeg demo is
not evidence.

This is a runnable runbook. Follow the steps in order. Record the exact values
you observe (ids, statuses, codes, paths). Do not paraphrase. Do not invent MCP
tools. Do not silently substitute generated or mock assets.

> Hard rule: if a required file, env var, credential, MCP tool, or production
> step is missing or fails, **stop that part of the test**, report the exact
> blocker, and mark the full test **FAIL**. Never generate `studio_back.png`,
> `studio_desk.png`, `studio_intro.png`, or `studio_outtro.png`. Never claim
> pass from a green unit-test suite alone.

---

## 0. At a glance

| # | Stage | Paid? | Who | Primary tools |
| --- | --- | --- | --- | --- |
| A | Operator: source dir, HeyGen pricing/avatar, app + MCP | No setup cost | Operator | env / filesystem |
| B | Create project | No | Hermes | `create_project` |
| C | Import real studio stills | No | Hermes | `import_studio_assets`, `get_project` |
| D | Author intro / news / outro + composition | No | Hermes | `update_project`, `get_validation_report` |
| E | Inspect production plan | No | Hermes | `get_production_plan` |
| F | Run production (stock + narration + HeyGen + render + compose) | **Yes** for narration and HeyGen | Hermes | `run_production`, `get_run_status`, `get_run_log` |
| G | Fetch MP4 + verify frames | No | Hermes | `get_project_compositions` + HTTP GET + ffprobe |

Default recipe for this test is **real mode**. Mock mode would use the fake
stock provider and a mock presenter; that is **not** a pass for P101.4.

---

## 1. What this proves

1. `import_studio_assets` copies the four named operator stills from
   `STUDIO_IMPORT_SOURCE_DIR` into `assets/studio/` and returns project-relative
   `localPath` values. Later work never reads `tmp_images`.
2. `scene.composition` is authored through `update_project` and executed by
   `run_production` on the existing RenderPlan / FFmpeg path (P101.2 + P101.3).
3. Intro uses `studio_intro.png`. Outro uses `studio_outtro.png`. News uses
   `studio_back.png`, a real downloaded stock photo at
   `{x:293,y:98,width:1346,height:761}`, a transparent HeyGen WebM, then
   `studio_desk.png` on top.
4. Scenes **without** `composition` keep the historical still/video/studio
   renderer. This test does not regress that path; it simply does not use it
   for these three scenes.
5. Final deliverable is one H.264 `yuv420p` 1920x1080 MP4 from
   `final_compose`, not a compositor unit-test file.

Feature stack used:

- MCP authoring: `create_project`, `update_project`, `import_studio_assets`
- MCP read: `get_project`, `get_scene`, `get_validation_report`,
  `get_production_plan`, `get_project_compositions`
- MCP production: `run_production`, `get_run_status`, `get_run_log`
- Production actions: `stock_select`, `narration_generate`, `presenter_submit`,
  `presenter_poll`, `scene_render`, `final_compose`
- Composition compositor: P100.7k `libvpx-vp9` decode + `overlay=format=auto`

Tools that **do not exist** and must not be invented:

- No MCP stock search / select tool. Stock is selected inside `run_production`
  via `stock_select`. Manual curation is REST-only:
  `POST /api/projects/{id}/scenes/{sceneId}/select-stock-image`.
- No standalone presenter submit/poll MCP tool. Presenter generation runs only
  inside `run_production`.
- No standalone narration, scene render, or compose MCP tool.
- No MCP MP4 download. Use authenticated HTTP GET of `downloadPath`.
- `create_reference` is for video-generation keyframes, not studio stills.

---

## 2. Preconditions and environment

| Item | Value |
| --- | --- |
| Repo root | `/workspace` (adjust to your checkout) |
| App | Next.js, `http://localhost:3000`, API on the same port `/api/*` |
| MCP | one stdio server, `mcp/read-only/server.ts`, `npm run mcp:local` |
| Auth | `Authorization: Bearer <EXPLAINER_API_TOKEN>` |
| Canvas | 1920x1080, 16:9, 30 fps |
| Bigscreen | `{ "x": 293, "y": 98, "width": 1346, "height": 761 }` |

### 2.1 Operator-only setup (Hermes cannot invent these)

Stop and FAIL if any of these are missing. Do not guess a Windows path. Do not
copy files from another project as a silent substitute for operator stills.

1. **Studio source directory**
   - Set `STUDIO_IMPORT_SOURCE_DIR` on the **app** process to an existing
     directory. Example shape (do not hardcode an operator machine path):
     the directory that actually contains the four files below.
   - Required files, exact bare names:
     - `studio_back.png`
     - `studio_desk.png`
     - `studio_intro.png`
     - `studio_outtro.png` (spelling is `outtro`, not `outro`)
   - Restart the app after setting the env var.
   - Unset or missing dir -> `import_studio_assets` returns
     `PROVIDER_NOT_CONFIGURED` (`studio.import.sourceNotConfigured`).
   - Missing file -> `NOT_FOUND` (`studio.import.fileMissing`).

2. **HeyGen paid presenter (real WebM)**
   - `HEYGEN_API_KEY` set on the app.
   - `HEYGEN_AVATAR_ID` set to the licensed photo avatar.
   - `HEYGEN_AVATAR_TYPE=photo_avatar`
   - `HEYGEN_PRESENTER_ENGINE=avatar_iii` (or omit only if the server default
     is already Avatar III; confirm in `get_production_plan` / logs, do not
     assume).
   - `HEYGEN_PRICING_JSON` with a matching rate row for
     `engine=avatar_iii`, `avatarType=photo_avatar`, `resolution=1080p`.
     Absent pricing **fail-closes** before the provider. That is correct; it
     is not a pass.
   - `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true` on the app.
   - Project `presenter.maxCostUsd` must be a finite positive number that
     covers the clip (a 3.6 s scene bills at least 4 s).

3. **Real stock photo**
   - Prefer a **download** provider so the photo becomes a project asset under
     `assets/` and can bind onto the composition image layer.
   - Pixabay is the download provider already wired (`PIXABAY_API_KEY`).
   - Unsplash is **hotlink-only** and is **not** copied into `assets/`. A
     composition bigscreen without `assetId`/`localPath` cannot use a hotlinked
     Unsplash URL. If only Unsplash is configured, STOP and report
     `scene.composition.asset.hotlinkUnsupported`; do not fake a PNG.
   - `UNSPLASH_ACCESS_KEY` is the env var the Unsplash provider reads. A
     differently named Unsplash key does not configure it.

4. **Narration**
   - Real mode narration uses ElevenLabs. `ELEVENLABS_API_KEY` must be set if
     any scene has `narration.text`. The news scene in this test does, because
     HeyGen needs narration audio.

5. **FFmpeg**

```bash
ffmpeg -version
ffprobe -version
```

Both must print a version. `FFMPEG_UNAVAILABLE` in the run log is a FAIL.

### 2.2 Start the app and MCP

Operator / Hermes launch (operator supplies the token; never print it):

```bash
# Terminal 1 - app. STUDIO_IMPORT_SOURCE_DIR must already be set in this process.
npm run dev

# Warm routes
curl -s -o /dev/null -H "Authorization: Bearer $EXPLAINER_API_TOKEN" http://localhost:3000/api/projects
```

```bash
# Terminal 2 - MCP stdio. Hermes normally launches this from its config.
export EXPLAINER_API_BASE_URL="http://localhost:3000"
export EXPLAINER_API_TOKEN="<same value as the app>"
npm run mcp:local
```

The MCP server is `explainer-local-mcp` v0.1.0. It keeps no state. Every tool
call proxies to the app REST API.

### 2.3 Presence check before authoring

Confirm, without printing secret values:

| Key / file | Required | Fail code if missing |
| --- | --- | --- |
| `EXPLAINER_API_TOKEN` | yes | `UNAUTHENTICATED` |
| `STUDIO_IMPORT_SOURCE_DIR` + four PNGs | yes | `PROVIDER_NOT_CONFIGURED` / `NOT_FOUND` |
| `PIXABAY_API_KEY` (or another download stock provider) | yes for real stock on the bigscreen | `stock.routing.failed` / `PROVIDER_NOT_CONFIGURED` |
| `ELEVENLABS_API_KEY` | yes (news narration) | `PROVIDER_NOT_CONFIGURED` |
| `HEYGEN_API_KEY` | yes | presenter blocked / `PROVIDER_NOT_CONFIGURED` |
| `HEYGEN_PRICING_JSON` | yes | presenter `blocked` (`HEYGEN_PRICING_JSON`) |
| `HEYGEN_AVATAR_ID` | yes | presenter blocked |
| `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true` | yes | `POLICY_DENIED` |

If this environment cannot satisfy a row, record it in the completion report
and do **not** mark the full test passed.

---

## 3. Exact MCP tools available in this repository

Single server registers all three groups (`mcp/read-only/server.ts`).

### 3.1 Read-only

| Tool | Arguments | Notes |
| --- | --- | --- |
| `list_projects` | `{}` | |
| `get_project` | `{ "projectId": "<id>" }` | Full project document |
| `get_scene` | `{ "projectId": "<id>", "sceneId": "<id>" }` | |
| `get_validation_report` | `{ "projectId": "<id>" }` | |
| `get_production_plan` | `{ "projectId": "<id>" }` | Actions + blockers |
| `get_project_compositions` | `{ "projectId": "<id>", "compositionId": "<optional>" }` | Metadata + `downloadPath`; no MP4 bytes |
| `get_generation_job` | `{ "projectId": "<id>", "attemptId": "<id>" }` | Video jobs only; mutates by polling |

### 3.2 Authoring

| Tool | Arguments |
| --- | --- |
| `create_project` | `{ "title"?, "description"?, "durationTarget"?, "aspectRatio"?: "16:9"\|"1:1"\|"9:16", "fps"? }` |
| `update_project` | `{ "projectId", "project": { ...patch } }` |
| `plan_scene_intents` | `{ "projectId", "project"? }` |
| `approve_scene_intents` | `{ "projectId", "intentIds"? }` |
| `materialize_scene_intents` | `{ "projectId", "project"?, "intentIds"? }` |
| `manage_project_music` | `{ "projectId", "action": "generate"\|"regenerate"\|"select"\|"clear", ... }` |
| `create_reference` | `{ "projectId", "name", "contentBase64", "mimeType"?, "fileName"?, "description"?, "tags"? }` |
| `import_studio_assets` | `{ "projectId", "fileNames": ["..."] }` (`fileNames` min 1, max 20) |
| `generate_video` | `{ "projectId", "sceneId", "regenerate"?, "provider"?, "model"?, "mode"?: "mock"\|"real" }` |
| `cancel_video` | `{ "projectId", "sceneId" }` |

This test does **not** use scene-intents, music, `create_reference`,
`generate_video`, or `cancel_video`.

### 3.3 Production

| Tool | Arguments |
| --- | --- |
| `run_production` | `{ "projectId", "mode"?: "mock"\|"real", "providers"?: { "image"?: "fake"\|"openai", "video"?: "local"\|"openai"\|"fal", "narration"?: "fake"\|"elevenlabs", "music"?: "fake"\|"elevenlabs", "presenter"?: "mock"\|"heygen" }, "music"?, "maxIterations"?, "force"?, "limits"? }` |
| `get_run_status` | `{ "runId": "<id>" }` |
| `get_run_log` | `{ "runId": "<id>", "cursor"?: number, "limit"?: 1-2000 }` |

`limits` may include `presenter_submit` (1-4), `presenter_poll` (1-8),
`scene_render`, `final_compose`, `stock_select`, `narration_generate`.

---

## 4. Layer order, geometry, expected picture

Canvas: 1920x1080. Layer order is `zIndex` then `id`.

| Scene | Layers (back to front) | Geometry |
| --- | --- | --- |
| Intro | `studio_intro.png` as background only | full canvas cover |
| News | back -> stock image -> presenter -> desk | back/desk full canvas; stock at 293,98 1346x761 contain; presenter full_canvas contain |
| Outro | `studio_outtro.png` as background only | full canvas cover |

News zIndex contract from `createStudioComposition`:

- background `studio-back` z=0
- image `studio-screen` z=10, rect `{x:293,y:98,width:1346,height:761}`, fit `contain`
- presenter `studio-presenter` z=20, mode `full_canvas`
- foreground `studio-desk` z=30

The desk must overlay the avatar. Transparent WebM regions must show the
yellow/stock bigscreen and navy back, not a baked rectangle. Final MP4 is
opaque H.264 `yuv420p`.

---

## 5. Step-by-step (Hermes)

Replace `<PROJECT_ID>`, `<INTRO_ASSET_ID>`, etc. with values returned by tools.
`update_project` **replaces** `project.scenes` wholesale. Always send complete
scene objects.

### 5.1 Create project

```json
{
  "title": "hermes_test_005 studio E2E",
  "description": "Real studio stills + stock bigscreen + HeyGen WebM",
  "durationTarget": 12,
  "aspectRatio": "16:9",
  "fps": 30
}
```

Tool: `create_project`. Record `data.projectId`. If `claimToken` is present,
hand it to the operator out-of-band; never log it.

`create_project` seeds one default scene. Step 5.3 replaces the array.

### 5.2 Import studio stills

```json
{
  "projectId": "<PROJECT_ID>",
  "fileNames": [
    "studio_back.png",
    "studio_desk.png",
    "studio_intro.png",
    "studio_outtro.png"
  ]
}
```

Tool: `import_studio_assets`.

Pass only if `ok: true` and `data.assets` has four entries with:

- `filename` matching the request
- `localPath` equal to `assets/studio/<filename>`
- `assetId` present

Then `get_project` `{ "projectId": "<PROJECT_ID>" }` and confirm those assets
exist. Record:

| filename | assetId | localPath |
| --- | --- | --- |
| studio_intro.png | | `assets/studio/studio_intro.png` |
| studio_back.png | | `assets/studio/studio_back.png` |
| studio_desk.png | | `assets/studio/studio_desk.png` |
| studio_outtro.png | | `assets/studio/studio_outtro.png` |

Failure handling:

| MCP `error.code` | Typical API code | Action |
| --- | --- | --- |
| `PROVIDER_NOT_CONFIGURED` | `studio.import.sourceNotConfigured` | STOP. Operator must set `STUDIO_IMPORT_SOURCE_DIR` and restart the app. |
| `NOT_FOUND` | `studio.import.sourceMissing` / `studio.import.fileMissing` | STOP. Operator must place the named files in that directory. |
| `CONFLICT` | `studio.import.alreadyExists` | STOP or reuse the existing `assets/studio/...` paths from `get_project`. Do not generate replacements. |
| `INVALID_ARGUMENT` | path / empty list | STOP. Do not send absolute paths or `..`. |
| `UNAUTHENTICATED` | 401 | STOP. Token mismatch. |

### 5.3 Author scenes

Use stable client scene ids so later steps are copy-pasteable, for example
`scene-intro`, `scene-news`, `scene-outro`. If the server rewrites ids, use
whatever `get_project` returns.

News visual is `stock_image` with an empty image-layer `assetId`/`localPath`.
After `stock_select` persists a **downloaded** Pixabay asset, the resolver
binds `scene.visual.assetId` onto that image layer. Do not pre-fill a fake
screen PNG.

Tool: `update_project`

```json
{
  "projectId": "<PROJECT_ID>",
  "project": {
    "title": "hermes_test_005 studio E2E",
    "durationTarget": 12,
    "renderSettings": {
      "aspectRatio": "16:9",
      "fps": 30,
      "width": 1920,
      "height": 1080,
      "background": { "type": "color", "value": "#070b10" },
      "audio": { "narrationVolume": 1, "musicVolume": 0.35, "effectsVolume": 0.2 },
      "subtitlesEnabled": false
    },
    "presenter": {
      "enabled": true,
      "provider": "heygen",
      "avatarId": "<HEYGEN_AVATAR_ID from operator>",
      "outputFormat": "webm",
      "sceneSettings": [
        { "sceneId": "scene-news", "layout": "fullscreen" }
      ],
      "maxGeneratedSeconds": 12,
      "maxPaidRequests": 1,
      "maxCostUsd": 1
    },
    "scenes": [
      {
        "id": "scene-intro",
        "order": 1,
        "duration": 3,
        "type": "blank",
        "visual": { "kind": "blank" },
        "render": { "motion": { "preset": "none" }, "transition": { "type": "none" } },
        "overlay": { "type": "none" },
        "composition": {
          "version": 1,
          "preset": "studio",
          "canvas": { "width": 1920, "height": 1080 },
          "layers": [
            {
              "id": "studio-back",
              "type": "background",
              "enabled": true,
              "zIndex": 0,
              "assetId": "<INTRO_ASSET_ID>",
              "localPath": "assets/studio/studio_intro.png",
              "rect": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
              "fit": "cover"
            }
          ]
        },
        "referenceIds": [],
        "notes": "intro still"
      },
      {
        "id": "scene-news",
        "order": 2,
        "duration": 4,
        "type": "image",
        "visual": {
          "kind": "stock_image",
          "query": "modern news studio control room wide shot",
          "orientation": "landscape",
          "preferredProviders": ["pixabay"]
        },
        "narration": {
          "text": "Welcome to the studio. This is the live news desk."
        },
        "render": { "motion": { "preset": "none" }, "transition": { "type": "none" } },
        "overlay": { "type": "none" },
        "composition": {
          "version": 1,
          "preset": "studio",
          "canvas": { "width": 1920, "height": 1080 },
          "layers": [
            {
              "id": "studio-back",
              "type": "background",
              "enabled": true,
              "zIndex": 0,
              "assetId": "<BACK_ASSET_ID>",
              "localPath": "assets/studio/studio_back.png",
              "rect": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
              "fit": "cover"
            },
            {
              "id": "studio-screen",
              "type": "image",
              "enabled": true,
              "zIndex": 10,
              "rect": { "x": 293, "y": 98, "width": 1346, "height": 761 },
              "fit": "contain"
            },
            {
              "id": "studio-presenter",
              "type": "presenter",
              "enabled": true,
              "zIndex": 20,
              "mode": "full_canvas",
              "rect": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
              "fit": "contain"
            },
            {
              "id": "studio-desk",
              "type": "foreground",
              "enabled": true,
              "zIndex": 30,
              "assetId": "<DESK_ASSET_ID>",
              "localPath": "assets/studio/studio_desk.png",
              "rect": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
              "fit": "cover"
            }
          ]
        },
        "referenceIds": [],
        "notes": "studio news"
      },
      {
        "id": "scene-outro",
        "order": 3,
        "duration": 3,
        "type": "blank",
        "visual": { "kind": "blank" },
        "render": { "motion": { "preset": "none" }, "transition": { "type": "none" } },
        "overlay": { "type": "none" },
        "composition": {
          "version": 1,
          "preset": "studio",
          "canvas": { "width": 1920, "height": 1080 },
          "layers": [
            {
              "id": "studio-back",
              "type": "background",
              "enabled": true,
              "zIndex": 0,
              "assetId": "<OUTTRO_ASSET_ID>",
              "localPath": "assets/studio/studio_outtro.png",
              "rect": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
              "fit": "cover"
            }
          ]
        },
        "referenceIds": [],
        "notes": "outro still"
      }
    ]
  }
}
```

`avatarId` and `maxCostUsd` are operator inputs. If the operator did not supply
a licensed avatar id and a finite `maxCostUsd`, STOP before `run_production`.

### 5.4 Validate

```json
{ "projectId": "<PROJECT_ID>" }
```

Tools: `get_validation_report`, then `get_project`, then `get_production_plan`.

Pass gate before production:

- validation `errors` empty
- each scene has `composition.version === 1`
- news image layer rect is `{x:293,y:98,width:1346,height:761}`
- intro/outro have **no** enabled presenter layer
- news presenter layer `enabled: true`, `mode: "full_canvas"`
- `get_production_plan` shows `stock_select` ready for news, `presenter_submit`
  not blocked on pricing, `scene_render` for news waiting on stock and/or
  presenter rather than executing early

If `presenter_submit` reason matches `HEYGEN_PRICING_JSON` or `maxCostUsd`,
STOP. Do not switch `providers.presenter` to `mock` to force a green run.

### 5.5 Run production

```json
{
  "projectId": "<PROJECT_ID>",
  "mode": "real",
  "providers": {
    "narration": "elevenlabs",
    "presenter": "heygen"
  },
  "force": true,
  "limits": {
    "stock_select": 1,
    "narration_generate": 1,
    "presenter_submit": 1,
    "presenter_poll": 4,
    "scene_render": 1,
    "final_compose": 1
  }
}
```

Tool: `run_production`. Record `data.run.id` as `RUN_ID` and `data.reused`.

Poll:

```json
{ "runId": "<RUN_ID>" }
```

```json
{ "runId": "<RUN_ID>", "cursor": 0, "limit": 200 }
```

Expected action order for news: `stock_select` -> `narration_generate` ->
`presenter_submit` / `presenter_poll` -> `scene_render` -> project
`final_compose`. Intro/outro skip stock and presenter.

Keep polling until `run.status` is a terminal value (`completed` or `failed`).
Do not start a second real presenter job. If `reused: true`, continue the
existing run.

Failure handling:

| Observation | Action |
| --- | --- |
| `POLICY_DENIED` | STOP. Real providers not allowed on the app. |
| `PROVIDER_NOT_CONFIGURED` | STOP. Name the missing provider in the report. |
| `stock_select` failed / fake provider in real mode | STOP. Do not accept `provider: "fake"`. |
| `presenter_submit` blocked | STOP. Quote `reason`. |
| `scene_render` completed before presenter on news | FAIL. Composition baked without the avatar. |
| `FFMPEG_UNAVAILABLE` / `FFMPEG_FAILED` | FAIL. |
| Run `failed` | FAIL. Copy failed action id, code, log excerpt. |

### 5.6 Fetch the MP4

```json
{ "projectId": "<PROJECT_ID>" }
```

Tool: `get_project_compositions`. Record `compositionId`, `downloadPath`,
`width`, `height`, `duration`, `sceneCount`, `available`.

Download with the same bearer token (REST, not MCP):

```bash
curl -fsS -H "Authorization: Bearer $EXPLAINER_API_TOKEN" \
  -o /tmp/hermes_test_005.mp4 \
  "http://localhost:3000<downloadPath>"
```

On-disk project copy (gitignored) is typically:

`projects/<PROJECT_ID>/renders/<compositionId>.mp4`

(confirm via `get_project` `compositions[].outputPath`; do not guess).

---

## 6. Final verification checklist

Run against the downloaded MP4. All boxes required for PASS.

```bash
ffprobe -v error -show_entries format=duration,format_name,size:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate -of json /tmp/hermes_test_005.mp4
```

| Check | Expected |
| --- | --- |
| container | mp4 / `mov,mp4,...` |
| video codec | `h264` |
| pix_fmt | `yuv420p` |
| width x height | 1920 x 1080 |
| fps | 30/1 (or 30) |
| sceneCount | 3 |
| duration | about 10 s (3+4+3 plus timing padding; record actual) |
| audio | present if narration mixed; record whether stream exists |

Extract one frame from each scene (adjust `-ss` to the actual durations):

```bash
ffmpeg -y -ss 1.2 -i /tmp/hermes_test_005.mp4 -frames:v 1 /tmp/hermes_test_005_intro.png
ffmpeg -y -ss 5.0 -i /tmp/hermes_test_005.mp4 -frames:v 1 /tmp/hermes_test_005_news.png
ffmpeg -y -ss 8.5 -i /tmp/hermes_test_005.mp4 -frames:v 1 /tmp/hermes_test_005_outro.png
```

Visual gate for news frame:

- Real `studio_back.png` visible in the side margins, not a generated solid.
- Real stock photo inside the 293,98 1346x761 rectangle.
- HeyGen avatar visible with transparency (studio/stock showing through).
- Real `studio_desk.png` covering the lower avatar, not sitting behind it.

Intro frame must match `studio_intro.png`. Outro frame must match
`studio_outtro.png`.

If you cannot tell the stills apart from generated placeholders, FAIL. P101.3's
synthetic navy/yellow/brown proof is **not** this test.

---

## 7. Failure policy (summary)

- Missing operator stills, source dir, or credentials: stop, do not generate
  replacements, do not use `.tmp/studio-smoke` or P101.3 synthetic PNGs.
- Missing HeyGen pricing/avatar: stop. Do not flip to `providers.presenter=mock`.
- Hotlink-only stock (Unsplash) with no downloaded asset: stop. Prefer Pixabay.
- Unsafe paths (`..`, absolute, `tmp_images/...` as `localPath`): stop.
- Partial run: report which steps passed and which blocked. Full test is FAIL
  until the MP4 and frame checks succeed.

---

## 8. Completion report template

Copy and fill. Status is `PASS` only if every required box in section 6 is true
**and** the stills/stock/WebM were the real operator/provider assets.

```text
hermes_test_005 completion report
status: PASS | FAIL | BLOCKED
projectId:
runId:
compositionId:
outputPath:
downloadPath:

MCP calls (name, ok, notable ids/codes):
- create_project:
- import_studio_assets:
- update_project:
- get_validation_report:
- get_production_plan:
- run_production:
- get_run_status (terminal):
- get_run_log:
- get_project_compositions:

Assets:
- studio_intro.png assetId / localPath:
- studio_back.png assetId / localPath:
- studio_desk.png assetId / localPath:
- studio_outtro.png assetId / localPath:
- stock provider / photoId / assetId / usagePolicy:
- presenter clip assetId / outputFormat / duration:

ffprobe:
- codec / pix_fmt / width / height / fps / duration / size:

frames:
- intro: /tmp/hermes_test_005_intro.png
- news: /tmp/hermes_test_005_news.png
- outro: /tmp/hermes_test_005_outro.png
- desk over avatar: yes/no
- stock inside 293,98 1346x761: yes/no
- real stills (not generated placeholders): yes/no

real vs mocked:
- studio stills:
- stock:
- presenter:
- narration:
- ffmpeg:

blockers (exact env/file/tool/code):
operator action remaining:
```

---

## 9. What Hermes can do vs what the operator must do

Operator (cannot be guessed):

- Point `STUDIO_IMPORT_SOURCE_DIR` at the directory that already holds the four
  real PNGs; restart the app.
- Supply HeyGen avatar id, avatar type, pricing JSON, and `maxCostUsd`.
- Confirm stock download credentials (Pixabay) and ElevenLabs.
- Start app + MCP with a shared `EXPLAINER_API_TOKEN`.

Hermes:

- All MCP calls in sections 5.1-5.6.
- ffprobe / frame extraction.
- The completion report.

Hermes must not:

- Hardcode `C:\Users\...` or any other operator path into the repo.
- Write placeholder PNGs into `STUDIO_IMPORT_SOURCE_DIR` or `assets/studio`.
- Call unpaid mock providers and call that a P101.4 pass.
