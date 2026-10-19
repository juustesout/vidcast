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
      "screen": { "x": 0.05, "y": 0.09, "width": 0.64, "height": 0.64 }
    }
  }
}
```

All screen fields are normalized `0..1`, except `radius`, which is pixels.
Omitted fields use the defaults in `lib/render/studio-overlay.ts`; the default
screen is 16:9 so stock images and graphic cards fill it without cropping. The
overlay is resolved to canvas pixels in `resolveRenderPlan`, so the client/preview
and the FFmpeg renderer share one geometry source.

Still scene content is authored at the screen size and then positioned inside the
cutout. This keeps graphic titles centered in the studio screen instead of behind
the frame, and makes the existing `title_card` template wrap long titles naturally
at the narrower screen width.

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

## Three compositions

The same studio supports the three scenes of a news broadcast. Content is
swappable because only the scene source, overlay copy and presenter setting
change:

| Scene | Screen content | Lower third | Presenter |
| --- | --- | --- | --- |
| Intro | `title_card` with the broadcast name | short kicker, e.g. `Daily AI update` | larger PiP |
| News item | stock image or graphic | headline | smaller PiP |
| Outro | `title_card` with the closing line | short CTA | none |

Presenter framing presets live in `lib/render/studio-compositions.ts`:

| Kind | Position | Width ratio | Margin ratio |
| --- | --- | --- | --- |
| `intro` | `top_right` | `0.26` | `0.04` |
| `news` | `top_right` | `0.20` | `0.06` |
| `outro` | none | - | - |

Presenter clips from the mock/current providers are opaque, so every preset stays
a clean rectangular PiP in the right-hand studio panel. The intro PiP is larger
than the news PiP and never overlaps the title card, logo or lower third.

## Prototype

```bash
npm run smoke:studio
```

This renders an intro / news / outro slice into `.tmp/studio-smoke/` without any
network or paid provider calls:

- `studio-prototype.mp4` — 9 second concatenated prototype
- `intro.png`, `news.png`, `outro.png` — inspection frames
- `intro-with-presenter.mp4`, `news-with-presenter.mp4` — scenes with the mock presenter PiP

Inspect the frames for screen scale, text legibility, PiP placement and brand
consistency before changing the defaults.

## Current limits

- The studio is project-level; per-scene studio variants are not implemented.
- The right panel assumes a 16:9 landscape canvas. Verify 9:16 renders before
  enabling the studio on vertical projects.
- No transparent avatar or desk foreground is used: current providers return
  opaque video, so the presenter remains a rectangular PiP.
- Source attribution is not a dedicated field yet; keep it in the headline copy
  or omit it. Adding a separate source line needs a second text overlay stage.
