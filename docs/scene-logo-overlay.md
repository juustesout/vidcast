# Per-scene logo overlays and graphic palette

This document describes the optional logo/sponsor layer and the per-template
palette added on top of the existing renderer. Both features are opt-in. A
project without the new fields renders through the original FFmpeg paths.

## Scene logo schema

```json
{
  "logo": {
    "assetId": "asset-logo",
    "position": "bottom_right",
    "scale": 0.15,
    "maxWidth": 320,
    "margin": 48,
    "opacity": 1
  }
}
```

| Field | Required | Meaning | Bounds / default |
| --- | --- | --- | --- |
| `assetId` | yes | Project asset id of a PNG, JPEG, WebP, SVG or other image file | Must exist and be `image` or `graphic` |
| `position` | no | `top_left`, `top_right`, `bottom_left`, `bottom_right` | `bottom_right` |
| `scale` | no | Target width as a fraction of the canvas width | 0.02-0.5, default 0.15 |
| `maxWidth` | no | Pixel cap applied after `scale` | 8-4096 |
| `margin` | no | Inset from the selected corner, in canvas pixels | 0-400; default 4.5% of the shorter canvas side |
| `opacity` | no | Logo alpha multiplier | 0-1, default 1 |

`scene.logo: null` explicitly disables a project-level default. Omitting the
field inherits `renderSettings.logo`. An explicit scene logo always wins.

## Project default and reuse

`renderSettings.logo` accepts the same object. It is only used by scenes that do
not contain a `logo` field.

The same `assetId` may be used by any number of scenes. Different scenes may
reference different assets. No logo is added unless the project or scene
explicitly references one.

## Render behavior

- The logo is a separate image input composited with FFmpeg `overlay` after the
  scene source has been normalized and after the existing text overlay.
- It therefore appears above stock images, generated images/video and
  rasterized graphic templates.
- PNG/WebP alpha is preserved. `opacity` is applied with
  `colorchannelmixer=aa=...`.
- The logo stream is looped and the overlay uses `shortest=1`, so the logo is
  visible for the whole scene without extending it.
- The scene audio path is untouched. Narration/music composition is unchanged.
- `text` scenes and blank scenes use the same logo path; references are never
  treated as overlays.
- A missing or unreadable logo file is skipped at render time. Project
  validation reports a warning so the scene still renders without the logo.
- The logo asset id and geometry are part of the scene render fingerprint, so a
  changed logo makes the scene stale and requires a re-render.

## Graphic palette schema

`visual.style` on a `graphic` visual, or `renderSettings.graphicStyle` as a
project default, accepts:

```json
{
  "background": "#0056a7",
  "textColor": "#ffffff",
  "accentColor": "#ff5a5f",
  "statisticLabelColor": "#ffd9da"
}
```

| Field | Historical fallback |
| --- | --- |
| `background` | project `renderSettings.background.value` |
| `textColor` | `#f8fafc` (secondary list/comparison text stays `#e2e8f0`) |
| `accentColor` | `#f2d17b`; end cards use `#dbeafe` |
| `statisticLabelColor` | `#93c5fd` |

Only `#rgb` and `#rrggbb` values are accepted. Omitted fields keep the old
colors. The AI Dev Forum preset lives in
`lib/render/graphic-style.ts` as `AI_DEV_FORUM_GRAPHIC_STYLE`, using brand blue
`#0056a7`, white primary text and coral `#ff5a5f` for accents. The statistic
label uses a light coral tint for contrast on brand blue.

## Validation

- Out-of-range explicit logo fields are validation errors.
- Missing, not-ready or non-image logo assets are warnings; the scene renders
  without the logo.
- Invalid graphic palette colors are validation errors.
- Existing projects without `logo`, `renderSettings.logo`, `visual.style` or
  `renderSettings.graphicStyle` normalize to the same render plan as before.

## Local verification for Hermes

Hermes must only run local commands and inspect the output. No code changes and
no paid providers are involved.

Run the focused automated checks:

```bash
npx vitest run tests/scene-logo-overlay.test.ts
npx vitest run tests/logo-overlay-render.integration.test.ts
```

Render the visual smoke fixture:

```bash
npm run smoke:logo
```

Inspect these files:

```text
.tmp/logo-overlay-smoke/scene-1.png
.tmp/logo-overlay-smoke/scene-2.png
.tmp/logo-overlay-smoke/scene-3.png
.tmp/logo-overlay-smoke/scene-1.mp4
.tmp/logo-overlay-smoke/scene-2.mp4
.tmp/logo-overlay-smoke/scene-3.mp4
```

Expected result:

- `scene-1` and `scene-2` show the same green logo at the top-left. One is a
  graphic card, the other a stock-style image.
- `scene-3` shows a different blue logo at the bottom-right with 0.85 opacity.
- All three videos keep the 640x360 canvas and 1.2 s scene duration.

To verify the audio boundary, play `scene-3`; the smoke fixture has no narration,
but the integration test renders a source video with audio and asserts that the
audio stream survives the logo pipeline.
