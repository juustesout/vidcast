# Reusable news studio

The studio layer gives every scene in a project the same professional set: a
navy frame, a large content screen, a brand bar, a lower-third plate and a desk
band. Scene content (stock image, generated image or graphic card) stays
replaceable because the renderer cuts the screen area out of the studio frame
and composites the scene source underneath it.

## Enable it

Set `renderSettings.studio` on a project:

```json
{
  "renderSettings": {
    "studio": {
      "brand": "AI DEV FORUM",
      "program": "NEWS",
      "accentColor": "#ff5a5f",
      "screen": { "x": 0.05, "y": 0.09, "width": 0.64, "height": 0.7 }
    }
  }
}
```

All screen fields are normalized `0..1`, except `radius`, which is pixels.
Omitted fields use the defaults in `lib/render/studio-overlay.ts`. The overlay is
resolved to canvas pixels in `resolveRenderPlan`, so the client/preview and the
FFmpeg renderer share one geometry source.

The layer is optional and backward compatible: projects without
`renderSettings.studio` render exactly as before.

## Composition order

```
scene source -> fit/motion/fades -> studio overlay -> text overlay -> logo overlay
```

Text overlays are centered inside the studio screen when the studio is enabled,
so lower-third copy lines up with the set instead of the full canvas.

## Brand defaults

| Token | Value |
| --- | --- |
| Background | `#07121f` to `#0a1b2d` |
| Brand blue | `#0056a7` |
| Text | `#ffffff` |
| Muted text | `#9fb4d4` |
| Accent | `#ff5a5f` |

Projects can keep using `AI_DEV_FORUM_GRAPHIC_STYLE` for graphic-card colors and
the existing per-scene/project logo overlay.

## Presenter

Presenter clips from the mock provider are opaque, so the studio treats the
presenter as a clean rectangular PiP. Place it in the right-hand studio panel
(for example `top_right`, `widthRatio: 0.21`, `marginRatio: 0.06`) to keep it
clear of the screen and lower third.

## Prototype

```bash
npm run smoke:studio
```

This renders an intro / news / outro slice into `.tmp/studio-smoke/` without any
network or paid provider calls:

- `studio-prototype.mp4` — 9 second concatenated prototype
- `intro.png`, `news.png`, `outro.png` — inspection frames
- `news-with-presenter.mp4` — news scene with the mock presenter PiP

Inspect the frames for screen scale, text legibility, PiP placement and brand
consistency before changing the defaults.

## Current limits

- The studio is project-level; per-scene studio variants are not implemented.
- The right panel assumes a 16:9 landscape canvas. Verify 9:16 renders before
  enabling the studio on vertical projects.
- Graphic `title_card` templates do not wrap long titles; keep intro/outro copy
  short or use a text scene.
