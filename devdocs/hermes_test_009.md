# hermes_test_009.md - No-cost studio MP4 without avatar, then UI roundtrip

Status: **not yet run**. Ready after operator preconditions in section 2.
Owner: Hermes (MCP client agent)
Depends on: P200a.1 server-run Produce ready and P200a.2 scene-inspector
controls on `261021-feat-motion-canvas-animation-mcp`. This is **not** a
HeyGen / ElevenLabs proof. It does **not** replace `hermes_test_005.md`.

Branch: `261021-feat-motion-canvas-animation-mcp`

> Hard rule: if a required file, env var, credential, MCP tool, or production
> step is missing or fails, **stop**, report the exact blocker, and mark **FAIL**.
> Never generate `studio_back.png`, `studio_desk.png`, `studio_intro.png`, or
> `studio_outtro.png`. Never invent MCP tools. Never call HeyGen, ElevenLabs,
> OpenAI, or FAL. Never use `mode: "real"` unless the operator explicitly
> opts into free Pixabay quota (still no paid providers). A green unit-test
> suite is not a pass.

---

## 0. Can this already work?

**Yes.** After this branch:

1. Hermes can author a studio project with **no presenter / no avatar**.
2. `run_production` in `mode: "mock"` produces a real H.264 1920x1080 MP4
   with studio stills, a stock/fake bigscreen photo, optional fake
   narration or reused local audio, and `final_compose`. No paid calls.
3. The operator can **claim** the project, open it in the Web UI, watch the
   composition, change a scene in the inspector (overlay text, logo, presenter
   layout, Motion Canvas attach), Save, then **Produce ready** or Render Scene.
4. Produce ready now starts the **same server-run** as MCP (`startServerRunFlow`
   -> POST `/api/projects/{id}/production-runs`). It does not run a second
   client planner.
5. Hermes can keep working after the claim: the MCP service token bypasses
   owner checks. `get_project` sees UI saves. A later `run_production` reuses
   or starts a server run on that same document.

What is **not** in this test:

- No HeyGen avatar, no presenter_submit / presenter_poll.
- No ElevenLabs, no OpenAI image/video, no FAL.
- Unsplash is **not** usable on the studio bigscreen: hotlinked CDN URLs are
  not copied into `assets/`, and composition image layers need a local file.
  Use mock/fake stock, or optional real **Pixabay** (download provider).

---

## 1. What this proves

1. Studio composition without an avatar: intro / news / outro stills, news
   bigscreen photo, desk overlay, no presenter clip.
2. No-cost production: `mode: "mock"` (default). Optional Pixabay is free
   quota, still not a paid provider.
3. Final deliverable is one H.264 `yuv420p` 1920x1080 MP4 from
   `final_compose`, visible in the UI composition preview.
4. UI roundtrip: operator edits the saved project, re-renders, Hermes reads
   the updated document and can run production again.

Feature stack:

- MCP authoring: `create_project`, `update_project`, `import_studio_assets`
- Optional stock: `search_stock_photos`, `select_stock_photo` (Pixabay only)
- MCP read: `get_project`, `get_scene`, `get_validation_report`,
  `get_production_plan`, `get_project_compositions`
- MCP production: `run_production`, `get_run_status`, `get_run_log`
- UI: claim form, scene inspector, Save project, Produce ready / ServerRunPanel

Tools that **do not exist** and must not be invented:

- No MCP MP4 download. Use authenticated HTTP GET of `downloadPath`.
- No standalone scene-render or compose MCP tool.
- No `generate_narration` tool.

---

## 2. Operator checkout and env

```bash
git fetch origin
git checkout 261021-feat-motion-canvas-animation-mcp
git pull --ff-only origin 261021-feat-motion-canvas-animation-mcp

npm install

ffmpeg -version
ffprobe -version
```

Need FFmpeg on PATH (or `FFMPEG_PATH` / `FFPROBE_PATH`). Do not print secrets.

```bash
export EXPLAINER_API_TOKEN="<same-strong-token>"
export EXPLAINER_API_BASE_URL="http://127.0.0.1:3000"
export STUDIO_IMPORT_SOURCE_DIR="/path/to/operator/tmp_images"
```

Required bare names in `STUDIO_IMPORT_SOURCE_DIR`:

- `studio_back.png`
- `studio_desk.png`
- `studio_intro.png`
- `studio_outtro.png` (spelling is `outtro`, not `outro`)

Restart the app after setting env. Unset dir -> `PROVIDER_NOT_CONFIGURED`.
Missing file -> `NOT_FOUND`.

Do **not** set `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true` for the default
recipe. Do **not** set HeyGen / ElevenLabs / OpenAI / FAL for this test.

Optional free Pixabay (only if the operator wants a real photo instead of
fake stock):

```bash
export PIXABAY_API_KEY="<key>"
```

Unsplash (`UNSPLASH_ACCESS_KEY`) must not be used here. Hotlink photos cannot
fill `studio-screen`.

Start:

```bash
npm run dev
```

Hermes stdio (`explainer-local-mcp`):

```json
{
  "mcpServers": {
    "explainer-local": {
      "command": "npm",
      "args": ["run", "mcp:local"],
      "cwd": "/absolute/path/to/vidcast",
      "env": {
        "EXPLAINER_API_BASE_URL": "http://127.0.0.1:3000",
        "EXPLAINER_API_TOKEN": "<same token the app was started with>"
      }
    }
  }
}
```

Optional audio reuse: if the operator has a previous test MP3/WAV already
inside this project as an audio asset, Hermes may set
`scene.narration.audioAssetId` to that id. Do not upload remote URLs. Do not
call ElevenLabs. `import_asset` is images only; audio reuse is UI import or an
existing project asset.

---

## 3. Tools (exact names)

| Step | Tool | Mutating |
| --- | --- | --- |
| 1 | `create_project` | yes |
| 2 | `import_studio_assets` | yes |
| 3 | `update_project` | yes |
| 4 | `get_validation_report` | no |
| 5 | `get_production_plan` | no |
| 6 | `run_production` | yes |
| 7 | `get_run_status` | no |
| 8 | `get_run_log` | no |
| 9 | `get_project_compositions` | no |
| 10 | `get_project` | no |

Optional Pixabay path only: `search_stock_photos`, `select_stock_photo`.

Envelope is `{ ok: true, data }` or `{ ok: false, error: { code, message, details? } }`.

`update_project` **replaces** `project.scenes` wholesale. Always send complete
scene objects.

---

## 4. Expected picture

Canvas: 1920x1080, 16:9, 30 fps. No avatar.

| Scene | Layers (back to front) | Geometry |
| --- | --- | --- |
| Intro | `studio_intro.png` background only | full canvas cover |
| News | back -> photo -> desk | back/desk full canvas; photo at 293,98 1346x761 contain |
| Outro | `studio_outtro.png` background only | full canvas cover |

News zIndex:

- background `studio-back` z=0
- image `studio-screen` z=10, rect `{x:293,y:98,width:1346,height:761}`, fit `contain`
- presenter `studio-presenter` **enabled: false** (no clip, no HeyGen)
- foreground `studio-desk` z=30

`project.presenter.enabled` is **false**. `sceneSettings` is empty. The
production plan must **not** contain `presenter_submit` or `presenter_poll`.

---

## 5. Step-by-step (Hermes)

### 5.1 Create project

```json
{
  "name": "create_project",
  "arguments": {
    "title": "hermes_test_009 no-cost studio",
    "description": "Studio stills + stock bigscreen, no avatar, mock production",
    "durationTarget": 12,
    "aspectRatio": "16:9",
    "fps": 30
  }
}
```

Record `data.projectId`. If `claimToken` is present, hand it to the operator
**out-of-band**; never log it or put it in a URL.

### 5.2 Import studio stills

```json
{
  "name": "import_studio_assets",
  "arguments": {
    "projectId": "<PROJECT_ID>",
    "fileNames": [
      "studio_back.png",
      "studio_desk.png",
      "studio_intro.png",
      "studio_outtro.png"
    ]
  }
}
```

Pass only if four assets have `localPath` `assets/studio/<filename>`. Then
`get_project` and record asset ids.

### 5.3 Author scenes (no presenter)

Use stable ids `scene-intro`, `scene-news`, `scene-outro`. If the server
rewrites ids, use whatever `get_project` returns.

News visual is `stock_image`. Leave the image-layer `assetId`/`localPath`
empty so `stock_select` (mock/fake or later Pixabay) can bind a downloaded
file. Do not pre-fill a fake screen PNG. Do not enable presenter.

```json
{
  "name": "update_project",
  "arguments": {
    "projectId": "<PROJECT_ID>",
    "project": {
      "title": "hermes_test_009 no-cost studio",
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
        "enabled": false,
        "sceneSettings": []
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
          "referenceIds": [],
          "notes": "intro still",
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
                "localPath": "assets/studio/studio_intro.png",
                "rect": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
                "fit": "cover"
              }
            ]
          }
        },
        {
          "id": "scene-news",
          "order": 2,
          "duration": 6,
          "type": "image",
          "visual": {
            "kind": "stock_image",
            "query": "news studio desk landscape",
            "orientation": "landscape"
          },
          "render": { "motion": { "preset": "none" }, "transition": { "type": "none" } },
          "overlay": { "type": "title", "text": "No-cost studio", "position": "top" },
          "narration": {
            "text": "This is a local studio test without an avatar.",
            "status": "planned"
          },
          "referenceIds": [],
          "notes": "news without presenter",
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
                "enabled": false,
                "zIndex": 20,
                "mode": "pip",
                "pipPreset": "news"
              },
              {
                "id": "studio-desk",
                "type": "foreground",
                "enabled": true,
                "zIndex": 30,
                "localPath": "assets/studio/studio_desk.png",
                "rect": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
                "fit": "cover"
              }
            ]
          }
        },
        {
          "id": "scene-outro",
          "order": 3,
          "duration": 3,
          "type": "blank",
          "visual": { "kind": "blank" },
          "render": { "motion": { "preset": "none" }, "transition": { "type": "none" } },
          "overlay": { "type": "none" },
          "referenceIds": [],
          "notes": "outro still",
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
                "localPath": "assets/studio/studio_outtro.png",
                "rect": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
                "fit": "cover"
              }
            ]
          }
        }
      ]
    }
  }
}
```

If the operator already imported a previous-test audio asset, set
`scene-news.narration.audioAssetId` to that id and `status: "generated"`
instead of planned text-to-speech. Do not call a paid TTS provider.

### 5.4 Validate and inspect the plan

`get_validation_report` must have no errors that block render. Warnings about
a missing stock file before `stock_select` are expected.

`get_production_plan` must include `stock_select` (news), optional
`narration_generate` (only if news has narration text and no audio asset),
`scene_render` for each scene, and `final_compose`.

It must **not** include `presenter_submit` or `presenter_poll`.
It must **not** include `image_generate` or `video_submit`.

If presenter actions appear, STOP: `presenter.enabled` was not false or a
sceneSetting was left on.

### 5.5 Run production (mock, no paid providers)

```json
{
  "name": "run_production",
  "arguments": {
    "projectId": "<PROJECT_ID>",
    "mode": "mock",
    "providers": {
      "image": "fake",
      "video": "local",
      "narration": "fake",
      "music": "fake",
      "presenter": "mock"
    },
    "force": true,
    "limits": {
      "stock_select": 1,
      "narration_generate": 1,
      "scene_render": 3,
      "final_compose": 1
    }
  }
}
```

Do **not** pass `presenter_submit` / `presenter_poll` limits as a way to
generate an avatar. Presenter must stay off via authoring.

Poll `get_run_status` until `completed` / `failed` / `partial`. Read
`get_run_log` if it fails.

Pass only if:

- run status is `completed`
- log has `stock_select` for news (provider `fake` in mock)
- log has **no** `presenter_submit`
- `get_project_compositions` returns a composition with 1920x1080 and three
  scenes
- ffprobe on the downloaded MP4 is H.264 `yuv420p`, 1920x1080, ~12s

### 5.6 Optional Pixabay instead of fake stock

Only if the operator set `PIXABAY_API_KEY` and asked for a real photo.
Still no paid providers. Unsplash is forbidden here.

1. `search_stock_photos` with `providers: ["pixabay"]`, `mode: "real"` only
   after a current human approval of this project snapshot. If approval is
   missing, STOP and report that; do not fall back to Unsplash; mock/fake
   remains a valid pass for this test.
2. `select_stock_photo` with the returned `searchId` and a Pixabay `photoId`.
   Expect a downloaded local asset (`usagePolicy: "download"`) and
   `scene.visual.assetId`.
3. Then `run_production` as in 5.5. If `stock_select` would overwrite a
   pinned manual selection, keep the selected asset.

### 5.7 UI roundtrip (operator + Hermes)

This is the second half of the test. Hermes cannot click the browser.

1. Operator claims the project with `projectId` + `claimToken` in the claim
   form on `/` or `/projects`. Never put the token in a query string.
2. Open the project in the Web UI. Confirm:
   - composition preview plays the MP4
   - scene inspector shows **Presenter layout** (`full_canvas` / `pip`)
   - **Logo** inherit/custom/off
   - **Motion Canvas** template list / attach
   - **Produce ready** and `ServerRunPanel` (no client `runProductionBatch`)
3. Operator changes one cheap thing, for example news overlay text, Save
   project, then Produce ready or Render Scene.
4. Hermes `get_project` must show the saved overlay/logo/composition change.
5. Hermes `run_production` again with the same mock payload (or `force: true`
   if a run is still active and the operator wants a new one). Expect a new
   or updated composition; scene renders should go stale after the edit.

If the UI cannot open the project after claim, STOP and report the access
error. MCP should still be able to `get_project` with the service token.

---

## 6. Pass / fail

| Check | Pass |
| --- | --- |
| Studio stills imported, not generated | four `assets/studio/*.png` |
| No avatar | `presenter.enabled === false`, no presenter actions in the plan or log |
| No paid providers | mock run; no HeyGen / ElevenLabs / OpenAI / FAL |
| Stock | fake download in mock, or Pixabay download; never Unsplash hotlink |
| MP4 | H.264 yuv420p 1920x1080 from `get_project_compositions` |
| UI | operator can open, edit, save, re-render via Produce ready |
| Hermes after UI | `get_project` sees the edit; a second mock run works |

FAIL if Hermes invents tools, generates studio PNGs, enables HeyGen, uses
Unsplash on the bigscreen, or treats unit tests as evidence.

---

## 7. Forbidden

- HeyGen, ElevenLabs, OpenAI, FAL, or `mode: "real"` with those providers
- Inventing MCP tool names or template ids
- Generating studio stills
- Attaching Unsplash hotlinks to `studio-screen`
- Replacing whole scene arrays from a stale `get_project` after the operator
  edited in the UI without re-fetching first
- Claiming the roundtrip works without an actual MP4 in the UI
