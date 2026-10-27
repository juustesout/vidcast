# hermes_test_010.md - P210.7 autonomous production end-to-end acceptance

Status: **not yet run**. Ready after operator preconditions in section 2.
Owner: Hermes (MCP client agent)
Depends on: P210.1-P210.6 (mandate, budget ledger, recovery/resume, post-run QC)
on `261021-feat-motion-canvas-animation-mcp`. This is **not** a HeyGen /
ElevenLabs / OpenAI / FAL proof. It does **not** replace `hermes_test_005.md`
or `hermes_test_009.md`.

Branch: `261021-feat-motion-canvas-animation-mcp`

> Hard rule: if a required file, env var, credential, MCP tool, or production
> step is missing or fails, **stop**, report the exact blocker, and mark **FAIL**.
> Never invent MCP tools (`create_mandate`, `revoke_mandate`, `download_mp4`,
> `generate_narration`, scene-render, compose). Never call HeyGen, ElevenLabs,
> OpenAI, or FAL. Never use `mode: "real"`. Never mint or revoke a mandate
> yourself. A green unit-test suite is not a pass.

---

## 0. Can this already work?

**Yes, in mock.** After P210.6:

1. The operator mints **one** production mandate in the project workspace
   (**Let the agent finish this video**). MCP cannot mint or revoke it.
2. Hermes reads that mandate with `get_mandate_status` and then authors,
   produces, polls, and QC-checks without further UI clicks.
3. `run_production` in `mode: "mock"` produces a real H.264 1920x1080 MP4
   via `final_compose`. No paid provider calls.
4. Terminal `get_run_status` always includes `run.report` (QC). A successful
   compose job is not QC pass. `run.status` and `run.report.qcStatus` are
   independent. QC never starts a new paid submit.
5. Resume / poll / reuse uses the existing P210.5 recovery path. Duplicate
   paid jobs are forbidden even if this mock run never hits a paid provider.

What this test **does not** prove:

- No HeyGen avatar, no ElevenLabs TTS, no OpenAI image/video, no FAL.
- No real-mode mandate bind (`boundRunId` on first accepted real run).
- No live budget enforcement against paid submits (`mandate.budget.exceeded`).
- Unsplash hotlinks remain unusable on studio bigscreen.

Mock-run pass is the P210.7 acceptance for autonomy + QC delivery. Real
provider paths stay **untested** and must be listed in the report.

---

## 1. What this proves

Acceptatie: **een akkoord volstaat**. Na die ene UI-autorisatie voltooit
Hermes de workflow zelfstandig en levert een technisch gevalideerde MP4
met een consistent QC-rapport.

1. Mandate is user-gemint, gebonden aan dit project, uitleesbaar via MCP.
2. Hermes voert de toegestane mock-workflow uit zonder per-scene, per-asset
   of per-step approval.
3. Geen betaalde submits. Geen dubbele jobs bij poll, resume of run-reuse.
4. Terminale `run.status` en `run.report` landen samen. QC `passed` /
   `failed` / `partial` is onafhankelijk van compose-success.
5. MP4 bestaat, is downloadbaar, en voldoet aan de QC-criteria hieronder.
6. Hermes levert downloadreferentie, QC-status, scene counts, warnings en
   recovery-notes. Geen verborgen menselijke gates tijdens de workflow.

Feature stack:

- UI: **Let the agent finish this video** (`POST /api/projects/{id}/mandates`)
- MCP read: `get_mandate_status`, `get_project`, `get_validation_report`,
  `get_production_plan`, `get_project_compositions`, `get_run_status`,
  `get_run_log`
- MCP authoring: `create_project`, `update_project`, `import_studio_assets`
- Optional: `import_asset`, `search_stock_photos` (mock/fake),
  `select_stock_photo`, `list_animation_templates` /
  `render_animation_template` / `attach_animation`
- MCP production: `run_production` (`mode: "mock"`), poll, reuse
- REST-only download: authenticated `GET` of `downloadPath`

Tools that **do not exist** and must not be invented:

- `create_mandate`, `revoke_mandate`
- MCP MP4 download
- Standalone scene-render or compose MCP tool
- `generate_narration`

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

Do **not** set `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true`.
Do **not** set HeyGen / ElevenLabs / OpenAI / FAL for this test.
Do **not** change production credentials.

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

Optional audio reuse: if a previous-test MP3/WAV already exists in this
project as an audio asset, Hermes may set `scene.narration.audioAssetId`
to that id. Do not upload remote URLs. Do not call ElevenLabs.
`import_asset` is images only.

---

## 3. Tools (exact names)

| Step | Tool | Mutating | Who |
| --- | --- | --- | --- |
| 1 | `create_project` | yes | Hermes |
| 2 | `get_mandate_status` | no | Hermes |
| 3 | UI **Let the agent finish this video** | yes, browser session | Operator, once |
| 4 | `get_mandate_status` | no | Hermes |
| 5 | `import_studio_assets` | yes | Hermes |
| 6 | `update_project` | yes | Hermes |
| 7 | optional animation attach | yes | Hermes |
| 8 | `get_validation_report` / `get_production_plan` | no | Hermes |
| 9 | `run_production` | yes | Hermes |
| 10 | `get_run_status` / `get_run_log` | no | Hermes |
| 11 | `get_project_compositions` | no | Hermes |
| 12 | HTTP GET `downloadPath` | no | Hermes |

Envelope is `{ ok: true, data }` or `{ ok: false, error: { code, message, details? } }`.

`update_project` **replaces** `project.scenes` wholesale. Always send complete
scene objects. After any UI save, `get_project` before the next patch.

Mint/revoke remain `POST` / `DELETE /api/projects/{id}/mandates` and are
**browser user only**. If `get_mandate_status` is `NOT_FOUND` or `live=false`
after the operator click, STOP and report. Do not invent mint tools. Mock
production still runs without a mandate; this test still **requires** the
mandate so autonomy-after-one-ack is proven.

---

## 4. Expected picture

Canvas: 1920x1080, 16:9, 30 fps. No avatar.

Concrete opdracht (brief):

`Finish a no-cost studio news clip: intro still, news desk with a stock
bigscreen photo, outro still. No avatar. Deliver a checked H.264 MP4.`

| Scene | Layers (back to front) | Geometry |
| --- | --- | --- |
| Intro | `studio_intro.png` background only | full canvas cover |
| News | back -> photo -> desk | back/desk full canvas; photo at 293,98 1346x761 contain |
| Outro | `studio_outtro.png` background only | full canvas cover |

News zIndex:

- background `studio-back` z=0
- image `studio-screen` z=10, rect `{x:293,y:98,width:1346,height:761}`, fit `contain`
- presenter `studio-presenter` **enabled: false**
- foreground `studio-desk` z=30

`project.presenter.enabled` is **false**. `sceneSettings` is empty. The
production plan must **not** contain `presenter_submit` or `presenter_poll`.

QC criteria for the final MP4 (from `run.report` and ffprobe):

- file exists, size > 0
- container/codec: h264 / mp4
- resolution 1920x1080
- fps ~30
- duration ~12s (intro 3 + news 6 + outro 3), within compositor tolerance
- audio: optional in this recipe (no required narration/music/presenter).
  Missing audio is a warning, not a QC fail. If narration text is left on
  the news scene without an audio asset, mock `narration_generate` (fake)
  may add audio; then QC may require an audio stream.

`qcStatus` must be `passed` for a full pass. `failed` or missing `run.report`
on a terminal snapshot is FAIL. `partial` is FAIL for this acceptance unless
the report shows an intentional skipped scene that the brief allowed.

---

## 5. Step-by-step (Hermes)

Record a timeline. Every row needs timestamp, actor (operator/Hermes),
tool, ids, and result. This is the E2E-rapportage.

### 5.1 Create project

```json
{
  "name": "create_project",
  "arguments": {
    "title": "hermes_test_010 autonomous mock",
    "description": "P210.7 one-ack autonomous mock production with QC",
    "durationTarget": 12,
    "aspectRatio": "16:9",
    "fps": 30
  }
}
```

Record `data.projectId`. If `claimToken` is present, hand it to the operator
**out-of-band**; never log it or put it in a URL.

### 5.2 Mandate: prove MCP cannot mint, then operator acks once

```json
{
  "name": "get_mandate_status",
  "arguments": { "projectId": "<PROJECT_ID>" }
}
```

Expect `NOT_FOUND` (or `live: false` with no mandate). Do not invent a mint
tool. Do not call `POST /api/projects/{id}/mandates` with the service token.

Operator (browser, claimed project workspace):

1. Open the project.
2. Confirm **Agent authorization** shows no live mandate.
3. Optionally edit the production brief to the opdracht in section 4.
4. Click **Let the agent finish this video** once.
5. Confirm status becomes Active / live.

Hermes does not click the browser. After the operator says the mandate is
issued:

```json
{
  "name": "get_mandate_status",
  "arguments": { "projectId": "<PROJECT_ID>" }
}
```

Pass only if:

- `live === true`
- `mandate.projectId` equals this project
- `mandate.status` is `active` (or `consumed` with `boundRunId` only after
  a real run; mock should stay `active` until/unless bind rules apply)
- `mandate.mandateId`, `issuedBy`, `issuedAt`, `expiresAt`, `brief` present
- `allowedActions` includes `run_production` and `update_project`

Record `mandateId`. If still `NOT_FOUND` or `live=false`, STOP: operator ack
did not land. That is FAIL for autonomy-after-one-ack.

After this point the operator must not approve scenes, click Produce ready,
or call APIs. Further operator action is a **manual intervention** and must
be listed in the report. Revoke during the run is also an intervention.

### 5.3 Import studio stills

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

### 5.4 Author scenes (no presenter)

Use stable ids `scene-intro`, `scene-news`, `scene-outro`. If the server
rewrites ids, use whatever `get_project` returns.

News visual is `stock_image`. Leave the image-layer `assetId`/`localPath`
empty so mock `stock_select` can bind a downloaded file. Do not pre-fill a
fake screen PNG. Do not enable presenter.

Prefer no required audio: omit news narration text, or reuse an existing
local audio asset. Do not call ElevenLabs.

```json
{
  "name": "update_project",
  "arguments": {
    "projectId": "<PROJECT_ID>",
    "project": {
      "title": "hermes_test_010 autonomous mock",
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
          "overlay": { "type": "title", "text": "Autonomous mock", "position": "top" },
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

### 5.5 Optional Motion Canvas (local, no paid)

Only if Chromium is available on the app host. If listing or render fails,
skip animation, note it as **not proven**, and continue. Do not invent
template ids. Catalog ids are `northwind_arr_chart` (bigscreen) and
`nix_overlay` (overlay).

1. `list_animation_templates`
2. `render_animation_template` for `northwind_arr_chart`
3. `attach_animation` destination `bigscreen` on `scene-news`
4. `get_scene` must show `studio-screen` pointing at the returned asset

Skip `nix_overlay` unless the operator asked for it. Animation failure is
not an automatic full FAIL if the rest of the mock pipeline still delivers
a QC-passed MP4; report it under untested/skipped local paths.

### 5.6 Validate and inspect the plan

`get_validation_report` must have no errors that block render. Warnings
about a missing stock file before `stock_select` are expected.

`get_production_plan` must include `stock_select` (news), `scene_render` for
each scene, and `final_compose`.

It must **not** include `presenter_submit` or `presenter_poll`.
It must **not** include `image_generate` or `video_submit` unless a scene
was authored that way (this recipe must not).

If presenter actions appear, STOP: `presenter.enabled` was not false.

### 5.7 Run production (mock, no paid providers)

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
      "scene_render": 3,
      "final_compose": 1
    }
  }
}
```

Record `data.run.runId` and `data.reused`. First call should not be reused.

Do **not** pass `mode: "real"`. Do **not** pass HeyGen / ElevenLabs / OpenAI /
FAL providers. Do **not** pass `presenter_submit` limits as a way to generate
an avatar.

### 5.8 Poll until terminal; prove reuse and QC attach

Poll `get_run_status` with that `runId` until `run.status` is `completed`,
`failed`, `partial`, or `unresolved`.

While `queued` or `running`, `run.report` may be absent. That is allowed.

The first snapshot whose `run.status` is terminal **must** include
`run.report`. Missing report on a terminal snapshot is FAIL (P210.6).

Immediately call `run_production` again with the same mock payload **without**
`force` while the first run is still `queued`/`running` (if you can catch it)
or after it is terminal:

- Active run: expect `reused: true` and the **same** `runId`. No second job.
- Terminal run: a new start is allowed only if the operator wants a second
  production; default is **do not** start a second run. If you do, record it
  as extra work, not as recovery.

If status is `unresolved` or `report.recovery.resumeSafe === true`, call
`run_production` again (no `force`) and expect reuse of the same run. Do
not start a new paid submit. `report.recovery.paidSubmitRequired` must be
`false`.

Read `get_run_log` on failure or for the timeline. Paginate with
`log.nextCursor` / `log.hasMore`.

Pass only if:

- `run.status` is `completed`
- `run.report` is present on that same snapshot
- `run.report.runStatus` equals `run.status`
- `run.report.qcStatus` is `passed`
- `run.report.recovery.paidSubmitRequired` is `false`
- `run.report.output.downloadPath` is
  `/api/projects/<PROJECT_ID>/compositions/<COMPOSITION_ID>/file`
- `run.report.output` codec h264, 1920x1080, fps ~30, duration ~12
- `run.report.scenes.total === 3` and `failed === 0`
- log has `stock_select` for news (provider `fake` in mock)
- log has **no** `presenter_submit`
- log has `final_compose`
- `get_mandate_status` still `live=true` (or report why not; mock should
  not require bind)
- no operator click after section 5.2

FAIL if compose completed but `qcStatus` is `failed` (invalid MP4). That is
the P210.6 distinction.

### 5.9 Fetch MP4 and independently probe

```json
{
  "name": "get_project_compositions",
  "arguments": { "projectId": "<PROJECT_ID>" }
}
```

Expect a composition 1920x1080, three scenes, matching
`run.report.output.compositionId`.

Download with the shared token (no MCP download tool):

```bash
curl -H "Authorization: Bearer $EXPLAINER_API_TOKEN" \
  -o hermes_test_010.mp4 \
  "http://127.0.0.1:3000/api/projects/PROJECT_ID/compositions/COMPOSITION_ID/file"
```

```bash
ffprobe -v error -show_streams -show_format hermes_test_010.mp4
```

Independent probe must agree with `run.report.output` on codec, resolution,
and duration band. File size > 0.

### 5.10 Deliver to the operator

Hermes final message must include:

- `projectId`, `runId`, `mandateId`, mandate `live` / `status`
- executed actions (from the log): stock_select, scene_render x3,
  final_compose, plus animation if used
- retries / recoveryAttempts / reused flags
- `run.status`, `run.report.qcStatus`
- `downloadPath`
- warnings from `run.report.warnings`
- failures if any
- manual interventions (must be none after the one UI ack)
- which real-provider paths remain untested

Do not claim QC pass from unit tests or from compose-job success alone.

---

## 6. E2E timeline template (fill during the run)

| t | Actor | Action | Ids | Result |
| --- | --- | --- | --- | --- |
| | Hermes | `create_project` | projectId= | ok / FAIL |
| | Hermes | `get_mandate_status` before ack | | NOT_FOUND expected |
| | Operator | **Let the agent finish this video** | mandateId= | live=true |
| | Hermes | `get_mandate_status` | mandateId= | live / status / projectId |
| | Hermes | `import_studio_assets` | | four studio files |
| | Hermes | `update_project` | scene ids | authored |
| | Hermes | animation (optional) | template= | attached / skipped |
| | Hermes | `get_validation_report` | | blockers=0 |
| | Hermes | `get_production_plan` | | no presenter actions |
| | Hermes | `run_production` mock | runId= reused= | started |
| | Hermes | `get_run_status` polls | | queued/running then terminal |
| | Hermes | reuse / resume check | runId= | same run, no duplicate |
| | Hermes | terminal snapshot | | status + report together |
| | Hermes | `get_run_log` | | actions / retries |
| | Hermes | `get_project_compositions` + GET | compositionId= | MP4 bytes |
| | Hermes | ffprobe | | h264 1920x1080 ~12s |
| | Hermes | deliver | | downloadPath, qcStatus, warnings |

Manual interventions after the one ack: **none** / list them.

---

## 7. Pass / fail

| Check | Pass |
| --- | --- |
| One operator ack | UI mandate mint only; no later approvals or API clicks |
| Mandate | user-minted, `live=true`, `projectId` matches |
| Hermes reads mandate | `get_mandate_status`; never mints/revokes |
| No paid submits | `mode: "mock"`; no HeyGen / ElevenLabs / OpenAI / FAL |
| No duplicate jobs | reuse/resume keeps the same `runId`; `paidSubmitRequired=false` |
| Transient recovery | resumeSafe uses existing run; no new paid submit |
| Terminal + QC | first terminal snapshot has `run.report`; `runStatus` matches |
| QC vs compose | compose success is not enough; `qcStatus` is the quality result |
| MP4 | exists, h264/mp4, 1920x1080, ~12s, downloadPath works |
| Delivery | Hermes reports downloadPath, qcStatus, warnings, timeline |
| Hidden gates | no `approve_scene_intents`, no extra humanApproval, no Produce ready |

FAIL if Hermes invents tools, generates studio PNGs, enables HeyGen, uses
`mode: "real"`, treats unit tests as evidence, or reports pass when
`run.report` is missing on a terminal run.

---

## 8. What mock proves vs what remains untested

If the mock run passes, P210.7 autonomy is proven for:

- one user-minted mandate, MCP status read
- authoring + import + mock stock + local render/compose without extra acks
- run start, poll, reuse, QC attach, MP4 download, operator delivery
- QC independent of compose-job success (if the MP4 is valid, `passed`)

Still **untested** after a mock pass (do not run these in this file):

- `mode: "real"` with `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true`
- first real `run_production` binding `mandate.boundRunId`
- HeyGen `presenter_submit` / poll / cost cap (`maxCostUsd`)
- ElevenLabs narration + timestamps
- OpenAI image / FAL video paid submits
- mandate budget `max*Submits` / `mandate.budget.exceeded`
- revoked / expired / failed mandate blocking new paid work
- real-mode recovery that re-polls an existing provider job without
  resubmit (P210.5 real path)
- Pixabay real stock (optional free quota; still not this test)

Do not start those paths to "complete" this test.

---

## 9. Forbidden

- HeyGen, ElevenLabs, OpenAI, FAL, or `mode: "real"`
- Inventing MCP tool names (`create_mandate`, `revoke_mandate`, download_mp4)
- Generating studio stills
- Minting or revoking the mandate with the service token
- Waiting for `approve_scene_intents` or snapshot humanApproval after the
  mandate exists
- Starting a second paid or mock submit to make QC pass
- Claiming pass from unit tests or from compose without `run.report`
- Changing production credentials
