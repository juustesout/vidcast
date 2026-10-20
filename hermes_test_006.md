# hermes_test_006.md - Place the studio presenter as a scalable bottom-left PiP

Status: authoring contract for P101.5. Use this when composing a news/studio
scene so the transparent HeyGen avatar sits in the lower-left corner instead
of covering the full canvas.
Owner: Hermes (MCP client agent)
Depends on: `hermes_test_005.md` for import, stock, HeyGen, and production.
This file does **not** replace 005. It only changes the presenter layer.
A fullscreen HeyGen WebM is valid PiP input; the compositor scales it.

> Hard rule: do not invent MCP tools. Presenter placement is authored on
> `scene.composition.layers` through `update_project`. There is no MCP
> "place avatar" tool. Do not generate studio stills. Do not switch to a
> mock presenter to prove placement.
>
> **Do not create a new HeyGen video for PiP.** The existing transparent WebM
> is scaled and moved by the compositor. `layout: "pip"` vs `"fullscreen"` is
> **not** part of presenter-clip currency. Changing composition geometry must
> not call ElevenLabs or HeyGen.

---

## 0. What changed in P101.5

The presenter is still one composition layer (`id: studio-presenter`,
`type: presenter`, `zIndex: 20`). Only that layer is scaled and moved.

| Item | P101.4 / test 005 | P101.5 / this test |
| --- | --- | --- |
| Presenter mode | `full_canvas` | `pip` |
| Presenter rect | `{x:0,y:0,width:1920,height:1080}` | `{x:100,y:540,width:960,height:540}` |
| Scale | 100% of canvas | `scale: 0.5` (50% of canvas) |
| Placement | full canvas | bottom-left, `offsetX: 100`, `offsetY: 0` |
| Bigscreen | `{x:293,y:98,width:1346,height:761}` | unchanged |
| Desk | full canvas, z=30 | unchanged, still above the avatar |

Canvas remains 1920x1080. The compositor scales the WebM into the presenter
rect with `fit: contain` and overlays it with `format=auto` so alpha survives
until the final H.264 flatten.

---

## 1. Geometry Hermes must author

Defaults in `lib/render/scene-composition.ts`:

- `scale` default `0.5`
- `offsetX` default `100` (pixels from the left edge)
- `offsetY` default `0` (pixels from the bottom edge)

Formula (`resolveStudioPresenterRect`):

```text
width  = round(canvas.width  * scale)     -> 960
height = round(canvas.height * scale)     -> 540
x      = offsetX                          -> 100
y      = canvas.height - height - offsetY -> 1080 - 540 - 0 = 540
```

Default rect Hermes should send (and expect back from `get_project`):

```json
{ "x": 100, "y": 540, "width": 960, "height": 540 }
```

`scale` is a fraction of the **whole canvas**, not of the bigscreen. Changing
`scale` later (for example `0.4`) is allowed; keep `0 < scale <= 1`.
`offsetX` / `offsetY` are non-negative pixel counts from the left and bottom.

Do **not** use `pipPreset: "intro"` or `pipPreset: "news"` for this placement.
Those named presets still resolve to the historical top-right PiPs
(intro `widthRatio 0.26`, news `widthRatio 0.2`). This test uses explicit
`scale` + `offsetX` + `offsetY` (and the matching `rect`).

Layer order (back to front, zIndex then id):

1. `studio-back` z=0 full canvas
2. `studio-screen` z=10 rect `293,98 1346x761`
3. `studio-presenter` z=20 PiP rect above
4. `studio-desk` z=30 full canvas

The desk must overlap the lower avatar. Transparent WebM regions must show
studio/stock, not a baked rectangle.

---

## 2. How Hermes places the avatar

Same MCP tools as 005. The only authoring difference is the news presenter
**composition** layer. Paid providers stay idle if the existing clip and
narration are still current.

### 2.1 If the project already has a news WebM (typical 006 case)

Do **not** start from the 005 JSON skeleton. That skeleton omits
`narration.audioAssetId`, `narration.attempts`, `visual.assetId`, and
`presenterClips`. `update_project` **replaces** `project.scenes` wholesale,
so a skeleton patch marks narration `no_audio` and then the planner wants
ElevenLabs + HeyGen again. That is a Hermes authoring bug, not a required
regeneration.

1. `get_project` `{ "projectId": "<PROJECT_ID>" }`.
2. Copy the returned `project.scenes` array as-is.
3. On `scene-news` only, change the `studio-presenter` layer to the PiP
   object below. Do not drop `narration` fields (`text`, `audioAssetId`,
   `voiceId`, `model`, `format`, `status`, `duration`, `attempts`).
4. Do **not** send `presenterClips` unless you copy the existing array
   unchanged. Omitting the key keeps the stored clips. Sending `[]` or a
   stripped clip list deletes currency.
5. Do **not** send `assets`.
6. `presenter.sceneSettings[].layout` may stay `fullscreen`. Composition
   `mode: "pip"` is what places the avatar. Layout is overlay metadata; it
   is **not** checked by `isPresenterClipCurrent`.
7. `get_production_plan` **without** `force`. Expected:
   - `narration_generate` status `current` (not `ready` / regenerate)
   - `presenter_submit` status `current` (not `ready`)
   - `scene_render` `ready` or `waiting_dependency` only on render inputs,
     not on a new presenter job
8. `run_production` **without** `"force": true`. Do not pass
   `providers.narration` / `providers.presenter` unless those actions are
   actually `ready`.

If `get_production_plan` shows `narration_generate` or `presenter_submit` as
`ready` after the patch, **STOP**. The patch dropped `audioAssetId` or the
clip link. Fix the patch; do not pay to paper over it.

### 2.2 If this is a brand-new project (no clip yet)

Follow `hermes_test_005.md` once to obtain stills, stock, narration, and one
WebM. Then come back to 2.1. The first paid HeyGen call is 005, not 006.

News presenter layer (copy this onto the existing news scene; fill studio
asset ids from the current project, not from guesses):

```json
{
  "id": "studio-presenter",
  "type": "presenter",
  "enabled": true,
  "zIndex": 20,
  "mode": "pip",
  "scale": 0.5,
  "offsetX": 100,
  "offsetY": 0,
  "rect": { "x": 100, "y": 540, "width": 960, "height": 540 },
  "fit": "contain"
}
```

`update_project` still **replaces** `project.scenes` wholesale. Send complete
scene objects. Do not send only the presenter layer.

If `rect` is omitted but `mode` is `pip` and `scale` is set, the server fills
the rect from scale/offsets. Sending both (as above) is the safest check:
`get_project` must echo the same numbers.

Invalid values fail validation:

| Field | Rule | Error code |
| --- | --- | --- |
| `mode: "pip"` without `rect`, `scale`, or `pipPreset` | required | `scene.composition.presenter.pip.missing` |
| `scale` | finite, `> 0` and `<= 1` | `scene.composition.presenter.scale.invalid` |
| `offsetX` / `offsetY` | finite, `>= 0` | `scene.composition.presenter.offset.invalid` |
| `rect` | inside 1920x1080, width/height `> 0` | `scene.composition.rect.invalid` / `scene.composition.rect.bounds` |

Do not set `mode: "full_canvas"` for this test. That is the old centered
full-frame avatar.

---

## 3. News scene fragment (new project only)

Use this **only** when `get_project` has no news narration audio and no
presenter clip yet. If those already exist, ignore this skeleton and follow
2.1: copy the live scene object and change only the presenter layer.

A live news `narration` object that must be preserved looks like this (ids
are examples; use the values from `get_project`):

```json
{
  "text": "Welcome to the studio. This is the live news desk.",
  "audioAssetId": "<EXISTING_NARRATION_ASSET_ID>",
  "voiceId": "<EXISTING_VOICE_ID>",
  "model": "<EXISTING_MODEL>",
  "format": "mp3",
  "status": "generated",
  "duration": 4
}
```

Do not replace that with `{ "text": "..." }` only. Text-only narration is
why the planner schedules ElevenLabs.

Keep the rest of the news scene (stock visual with its existing `assetId` /
`selection`, back/screen/desk layers). Only the presenter **layer** changes:

```json
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
        "mode": "pip",
        "scale": 0.5,
        "offsetX": 100,
        "offsetY": 0,
        "rect": { "x": 100, "y": 540, "width": 960, "height": 540 },
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
  "notes": "studio news PiP presenter"
}
```

Project presenter block: copy the existing object from `get_project`. You may
leave `sceneSettings[].layout` as `fullscreen`. Optional, not required:

```json
{
  "enabled": true,
  "provider": "heygen",
  "avatarId": "<existing avatarId from get_project>",
  "outputFormat": "webm",
  "sceneSettings": [
    { "sceneId": "scene-news", "layout": "fullscreen" }
  ],
  "maxGeneratedSeconds": 12,
  "maxPaidRequests": 1,
  "maxCostUsd": 1
}
```

`avatarId` and `maxCostUsd` remain operator inputs. Hermes does not invent a
HeyGen id. Composition `scale`/`offsetX`/`offsetY` control **where the already
downloaded WebM is drawn**. HeyGen does not re-render a PiP clip.

---

## 4. Pass gates before and after production

Before `run_production` (`get_project` / `get_validation_report` /
`get_production_plan`):

- validation `errors` empty
- news presenter `mode` is `pip`
- news presenter `scale` is `0.5`, `offsetX` is `100`, `offsetY` is `0`
- news presenter `rect` is `{x:100,y:540,width:960,height:540}`
- news image layer rect is still `{x:293,y:98,width:1346,height:761}`
- desk `zIndex` is 30, presenter `zIndex` is 20
- intro/outro have **no** enabled presenter layer
- news `narration.audioAssetId` still points at the existing audio asset
- `presenterClips` for news still `status: generated` with the same `assetId`
- `get_production_plan` (no force): `narration_generate` **current**,
  `presenter_submit` **current**
- `scene_render` is the action that actually runs (reuse WebM, bake PiP)
- if `presenter_submit` is `ready`, the patch dropped clip currency; STOP
- if `narration_generate` is `ready` / regenerate, the patch dropped
  `audioAssetId` or changed text/voice; STOP
- do not set `"force": true` on `run_production`

After `final_compose` (same fetch/ffprobe flow as 005 section 5.6 / 6):

| Check | Expected |
| --- | --- |
| codec / pix_fmt / size | `h264` / `yuv420p` / 1920x1080 |
| avatar | visible in the lower-left PiP, not centered full-frame |
| left of PiP (`x < 100`) | studio back, not avatar |
| bigscreen | stock photo in `293,98 1346x761`; avatar must not cover the whole screen |
| desk | covers the lower avatar |
| alpha | studio/stock visible through transparent WebM regions |

A unit-test green suite or the synthetic P101.5 proof MP4
(`projects/project_p1013_studio_e2e/renders/p101.5-studio-pip.mp4`) is **not**
a pass for this Hermes test. Pass requires a production MP4 from
`run_production` that **reuses** the existing operator stills, stock, narration
audio, and HeyGen WebM. A new ElevenLabs or HeyGen charge during 006 is a
**FAIL** unless `get_project` had no clip/audio before the patch.

---

## 5. Later size/position tweaks

To move or resize without new MCP tools, `get_project` again, copy the live
`scenes` array, change only the presenter layer, and `update_project`. Same
preserve rules as 2.1. Do not go back to the section 3 skeleton. This still
must not call ElevenLabs or HeyGen:

| Goal | Fields |
| --- | --- |
| Smaller avatar | `"scale": 0.4` then recompute rect, or set `rect` explicitly |
| Further from the left | raise `offsetX` (example `160`) |
| Up from the bottom | raise `offsetY` (example `40`) |
| Restore old full-frame avatar | `"mode": "full_canvas"` and rect `{x:0,y:0,width:1920,height:1080}` |

If you set `rect` yourself it must stay inside the canvas. Prefer setting
`scale` / `offsetX` / `offsetY` **and** the matching `rect` so `get_project`
can be compared byte-for-byte.

---

## 6. Completion report

```text
hermes_test_006 completion report
status: PASS | FAIL | BLOCKED
projectId:
runId:
compositionId:
outputPath:

presenter layer (from get_project):
- mode:
- scale:
- offsetX:
- offsetY:
- rect:

reuse:
- narration_generate status:
- presenter_submit status:
- same narration audioAssetId as before patch: yes/no
- same presenter clip assetId as before patch: yes/no
- force used: yes/no (must be no)

ffprobe:
- codec / pix_fmt / width / height:

frames:
- avatar bottom-left PiP (not full canvas): yes/no
- left of x=100 is studio back: yes/no
- stock still in 293,98 1346x761: yes/no
- desk over avatar: yes/no

blockers:
```

Hermes must not:

- Invent a stock-select or presenter-place MCP tool
- Use `pipPreset: "news"` / `"intro"` when the goal is 50% bottom-left
- Generate `studio_*.png`
- Claim pass from mock presenter or from the P101.5 synthetic MP4
- Call HeyGen again because layout changed to `pip`
- Call ElevenLabs again because `update_project` replaced scenes without
  `narration.audioAssetId`
- Run `run_production` with `"force": true` for this placement change
