# P29 Text Overlays & Kinetic Typography Recon

Recon only. No code changes, no paid API calls. Every claim below is verified
against the current `main` working tree and against the locally installed
FFmpeg 5.1.9. Section 8 is a recommendation; nothing here is implemented yet.

Term glossary (Dutch terms used for the requested overlay concepts):
- titel = on-screen title / headline
- ondertitel / caption = subtitle / caption
- steekwoord = keyword / emphasis word
- callout = callout / annotation
- emoticon = emoticon / emblem / sticker
- kinetische typografie = kinetic typography (animated text)

## 1) Scope and Current State

The product already has a text-overlay concept in the data model, but it is
only partially rendered.

What exists today:
- `Scene.overlay: OverlaySpec` (`lib/types/scene.ts:89-94`, `:168`):
  ```
  type: 'none' | 'text' | 'title' | 'subtitle' | 'callout' | 'statistic' | 'quote'
  position?: 'top' | 'center' | 'bottom'
  text?: string
  data?: Record<string, unknown>
  ```
- The overlay survives the full authoring path:
  - materializer seeds `{ type: 'none' }` (`lib/explainer/scene-intent-materializer.ts:81`)
  - legacy `textOverlay` is migrated to `{ type: 'text', text, position: 'bottom' }` (`lib/projects/normalize-project.ts:293`)
  - validation checks `OVERLAY_TYPES` (`lib/validation/project-validation.ts:185`, `lib/constants.ts:22`)
  - patch shape guard requires it to be an object (`lib/projects/project-patch-shape.ts:55`)
  - resolver copies it into the render plan (`lib/render/scene-resolver.ts:171`)
  - the render fingerprint includes it (`lib/render/render-fingerprint.ts:29`)
- `RenderSettings.subtitlesEnabled` exists and defaults to `true`
  (`lib/types/render.ts:25`, `lib/constants.ts:50`) but is **never read by the
  render or composition pipeline**.
- Text is currently drawn only for `graphic` / `text` / `blank` scenes, by
  generating an SVG and rasterizing it with `sharp` in `render-source.ts`
  (`createStillSceneSvg`, `lib/render/render-source.ts:53-190`). It already has
  ready-made layouts: title_card, bullet_list, statistic, quote, comparison,
  callout, end_card.

What does NOT exist:
- No text is drawn on top of `image` or `video` scenes. In `render-source.ts`
  the scene overlay is only consulted as fallback copy for a `text` scene
  (`:135-136`); for image/video sources the overlay is ignored entirely.
- No subtitle/caption rendering. `subtitlesEnabled` is dead config.
- No kinetic (time-animated) text. Motion only exists as image `zoompan`
  (`lib/render/render-source.ts:192-221`).
- No word-level timing data (see section 5).

Conclusion: the model is overlay-ready; the renderer is not.

## 2) Render and Composition Pipeline Map

Scene render (one scene -> one MP4), `lib/render/scene-render-service.ts`:
1. `projectStore.getProject` -> `resolveRenderPlan(project)` (`lib/render/scene-resolver.ts:146`)
2. pick one scene, build a single-scene plan, `validateRenderPlan` (`lib/render/render-plan-validator.ts:9`)
3. `LocalFFmpegRenderer.render` (`lib/render/renderer.ts:311`)

`LocalFFmpegRenderer` (`lib/render/renderer.ts`):
- Still (image/graphic/text/blank): `buildStillArgs` (`:139-186`)
  `-loop 1 -i <png> -frames:v N -vf zoompan=...,fade=...,format=yuv420p`
- Video: `buildVideoArgs` (`:188-224`) uses `-filter_complex`
  `trim,setpts,tpad,scale,crop,fade,fps,format` (plus audio pad)
- Output contract enforced by `validateOutputFile` (`:252`): MP4/H.264,
  exact width/height/fps/duration. **Any overlay baked here must not change
  those properties**, or validation will reject the render.

Composition (many scene MP4s -> final MP4), `lib/render/video-compositor.ts`:
- `normalizeInput` / `buildNormalizeArgs` (`:65-126`) re-encodes each scene
  segment to a shared `scale,crop,fps,format` and one audio track.
- `composeConcat` / `buildComposeArgs` (`:128-163`) concatenates via the
  concat demuxer (`file '...'` list) — stream copy of video, AAC audio.
- optional `mixMusic` (`:183-237`).

Best integration points for overlays (in priority order):
1. **Per-scene, inside `LocalFFmpegRenderer`** — the existing architecture
   already bakes per-scene motion and fades into scene MP4s. Overlays are
   scene-scoped in the model, the fingerprint already tracks them, and
   per-scene work is isolated/idempotent. This is the natural home for
   `title` / `callout` / `statistic` / `quote` / `steekwoord` and simple
   fade-in text.
2. **Per-scene text via the existing SVG path** — extend `createStillSceneSvg`
   to also emit an overlay layer for image scenes (rasterized PNG composited
   with `overlay`), or generate a standalone transparent PNG overlay. Reuses
   `sharp`, fonts, wrapping, and the shadow filter already in `render-source.ts`.
3. **At composition, for continuous captions** — a project-level SRT/ASS track
   spanning all scenes can only be burned once the global timeline is known.
   `buildComposeArgs` currently stream-copies video, so captions would require
   adding a `-vf subtitles=...` at concat time (a re-encode of the whole video).
   This is the right place for a future burn-in subtitle feature, but it is a
   heavier change and breaks the current copy-through.

No new dependency is required for options 1-2. Option 3 needs no new dependency
either (libass is present) but does change the compose encode path.

## 3) FFmpeg Text Techniques (validated locally)

FFmpeg 5.1.9 is built with `--enable-libass --enable-libfontconfig
--enable-libfreetype --enable-libfribidi`. Available filters: `drawtext`,
`subtitles`, `ass`, `overlay`, `drawbox`.

Fonts installed system-wide: only the DejaVu family
(`/usr/share/fonts/truetype/dejavu/`): Sans, Serif, Mono (Book and Bold).
The repo bundles **no** fonts (`**/*.{ttf,otf,woff,woff2}` -> none). Any
custom brand font would have to be added as a project/repo asset.

Three techniques, with tradeoffs:

### A. `drawtext` (burn single strings)
Validated:
```
ffmpeg -y -f lavfi -i color=c=0x020617:s=640x360:r=25 -t 2 \
  -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:\
text='Hello World':fontcolor=white:fontsize=48:x=(w-text_w)/2:\
y=h-th-40:box=1:boxcolor=black@0.5:boxborderw=16" \
  -c:v libx264 -pix_fmt yuv420p out.mp4
```
- Pros: no extra file, direct control of position/box/shadow, easy
  `alpha=`/`enable='between(t,..)'` for fades and timed show/hide. Good fit for
  the per-scene renderer since it is already building a `-vf`/`-filter_complex`.
- Cons: manual escaping is the classic footgun (colons, quotes, commas,
  backslashes, `%`, `'`); must be sanitized. Long wrapped paragraphs are clumsy.
  Recommend `textfile=`/`text=` with strict escaping, or a small escaper util.
- Performance: negligible.

### B. ASS / `subtitles` (styled, timed, animated)
Validated:
```
ffmpeg -y -f lavfi -i color=c=0x020617:s=640x360:r=25 -t 2 \
  -vf "subtitles=cap.ass" -c:v libx264 -pix_fmt yuv420p out.mp4
```
with a minimal ASS containing per-event `Start/End` and inline overrides
(`{\fad(200,200)\t(0,300,\fscx120\fscy120)}`) for fade and scale animation.
- Pros: the strongest option for captions and kinetic typography — per-line
  and per-word timing, precise `\pos`/`\an` anchoring, fade (`\fad`), scale/
  move/rotate (`\t`, `\move`, `\frz`) for real kinetic text, karaoke
  (`\k`) for word-by-word highlight, outline/shadow, no shell-escaping of the
  visible text (it lives in the .ass file). This is the industry-standard
  subtitle path.
- Cons: needs an ASS generator + a temp file written under the render tempDir;
  requires scene-relative or global timecodes; font must be named resolvable by
  libass (`DejaVu Sans`). For per-scene rendering, timecodes are scene-local
  (same as the MP4 being produced).
- Performance: negligible.

### C. Transparent PNG `overlay` (pre-designed), composited
Rasterize an overlay PNG (SVG via `sharp` -> PNG with alpha) and composite:
```
ffmpeg -y -i scene.mp4 -i overlay.png \
  -filter_complex "[0:v][1:v]overlay=x=0:y=0" \
  -c:v libx264 -pix_fmt yuv420p out.mp4
```
(Overlay is a standard, always-available filter; a valid test must bound both
inputs, e.g. `-t`, otherwise the generator does not terminate.)
- Pros: reuses the existing `render-source.ts` SVG/`sharp` text pipeline
  (fonts, wrapping, shadow, card layouts) with pixel-perfect fidelity; good for
  static lower-thirds, title cards, callouts, emoticons/emblems; can be applied
  as a second `overlay` stage inside the current filter graph.
- Cons: not time-animated by itself (animation would need multiple PNGs or
  `overlay` `enable=`/`x=`/`y=` expressions); more files in tempDir; no
  per-word timing.

Recommendation: use (C) for static/designed elements and (A)/(B) for timed and
kinetic text. In practice (B) covers everything (A) can, plus animation, at the
cost of generating an ASS file; a pragmatic first phase can start with (A) for
a single fade-in line and evolve to (B).

## 4) Feasible Effect Catalog

Simple (low risk, small scope):
- Single title/caption line, bottom or top, with box/shadow, fade in/out.
- Static callout / "steekwoord" highlight word over an image.
- Burn `Scene.narration.text` as a caption for the scene.

Medium:
- Word/segment reveal for a short phrase (staggered fade or slide), using ASS
  or multiple `drawtext` with `enable=between(t,...)`.
- "Steekwoord" pop: scale-up pulse on a keyword at a scene-local time.
- Position-aware lower-thirds / top title bars with a consistent style.
- Emoticon/emblem PNG composited via `overlay` at an anchor.

Complex (scope risk; defer):
- Caption track continuous across scene boundaries (needs global timeline; must
  move to the composition stage, section 2 option 3).
- Word-accurate karaoke/highlight synced to narration (needs word timings,
  section 5).
- Rich entrance/exit choreography, motion tracking, per-character animation.
- A general animation editor / timeline UI.

## 5) Timing and Narration Sync

Available today (reliable):
- `Scene.duration` — scene length in seconds (`lib/types/scene.ts:162`).
- `Scene.narration.text` — narration copy per scene (`lib/types/scene.ts:43`),
  the production source of truth.
- `Scene.narration.duration` / attempt `duration` — narration audio length
  (`lib/types/scene.ts:51`, `:64`).
- Composition stage knows each scene's exact duration and audio
  (`CompositionItem`, `lib/types/render.ts:168-179`), so a global timeline can
  be derived at compose time.

Not available today:
- Word- or phoneme-level timings. The ElevenLabs client only reads
  `metadata.duration` (`lib/ai/text-to-speech/elevenlabs-provider.ts:172`); the
  fake provider estimates by words-per-second. No alignment, no SRT/ASS output,
  no `with-timestamps` request is configured (grep: none).

Implications:
- Scene-local sync is immediately achievable: animate within `[0, scene.duration]`
  using scene-local time. This covers fade-ins, position changes, and
  scene-duration-timed reveals without any new data.
- Word-accurate captions require new data. Options: (a) enable an ElevenLabs
  timestamp/alignment response (provider change), (b) run forced alignment
  locally, or (c) estimate from `narration.text` + `narration.duration`
  (words/sec) — approximate, drifts, acceptable only for coarse captions.
- Whichever is chosen, timing must participate in the render fingerprint
  (`lib/render/render-fingerprint.ts`) so changing text/timing invalidates the
  cached scene render.

## 6) Proposed Data Model (provider-agnostic)

Evolve the existing `OverlaySpec` rather than introducing a parallel concept.
Proposed additive shape (all optional so current projects keep working):

```
OverlaySpec := {
  type: 'none'|'text'|'title'|'subtitle'|'callout'|'statistic'|'quote'
  text?: string
  position?: 'top'|'center'|'bottom'
  data?: Record<string, unknown>
  // proposed additions:
  style?: {
    font?: string            // resolvable family, default 'DejaVu Sans'
    fontSize?: number        // px, default derived from width
    color?: string           // '#rrggbb'
    background?: string      // e.g. 'black@0.5' or null
    align?: 'left'|'center'|'right'
    maxCharsPerLine?: number
  }
  timing?: {                 // scene-local seconds
    start?: number
    end?: number
    fadeIn?: number
    fadeOut?: number
  }
  animation?: {
    kind: 'none'|'fade'|'pop'|'slide'|'typewriter'|'karaoke'
    // reserved for word-level once timings exist
    segments?: Array<{ text: string; start: number; end: number }>
  }
  // optional second line / supporting copy (e.g. statistic value+label)
  // can be carried in `data` to avoid over-modeling now.
}
```

Rules:
- Keep `type`/`text`/`position` as the stable core; everything else additive.
- `timing`/`animation` default to "static for the whole scene" when absent, so
  existing `{type:'none'}` and legacy `{type:'text',text}` behave as before.
- Normalization (`normalize-project.ts`) should default missing fields; the
  fingerprint must include `style`/`timing`/`animation`.
- Provider-agnostic: nothing here depends on the image/video/tts vendor. Text
  comes from the model (story/beat/intent) or the operator; the *renderer*
  decides how to draw it. Keep the "text element" separate from "how it is
  animated".

## 7) Implementation Options Compared

Option 1 — `drawtext` per scene, inside `LocalFFmpegRenderer` (still path first).
- Effort: small. Reuses the existing `-vf`/`-filter_complex` builders.
- Covers: title, caption, callout, simple fade-in; scene-duration timed.
- Risk: low. Main work is text escaping + fingerprint + tests.
- Limit: no per-word timing; paragraph layout is manual.

Option 2 — ASS/subtitles generator per scene.
- Effort: medium. New ASS serializer + temp file + timecodes; wire into both
  still and video pipelines.
- Covers: everything option 1 does plus real kinetic typography (pop, slide,
  karaoke once timings exist).
- Risk: medium (timecode math, font naming, escaping inside ASS is easier).
- Limit: needs data for word-level effects to shine.

Option 3 — Transparent PNG overlay via existing SVG/`sharp` path.
- Effort: small-medium. Extend `render-source.ts` to emit an overlay layer for
  image scenes and add an `overlay` stage.
- Covers: pixel-perfect static lower-thirds, title cards, callouts, emblems;
  reuses the design system already in `render-source.ts`.
- Risk: low. No escaping (SVG escapes via `escapeXml`).
- Limit: static only; animation is awkward.

Option 4 — Burn-in at composition (project-level subtitle track).
- Effort: medium-high. Requires global timecode assembly, a project-level
  SRT/ASS, and a re-encode in `buildComposeArgs` (currently video is copied).
- Covers: continuous captions/subtitles across scene cuts; the "subtitle" story.
- Risk: medium-high (changes the compose encode path and its validation).
- Limit: not needed for scene-scoped titles/keywords; heavier validation surface.

## 8) Recommended First Phase (smallest useful PoC)

Recommendation: ship per-scene static + fade overlays first, via Option 1
(`drawtext`) for a single line and Option 3 (PNG overlay) where the existing
SVG design is wanted; defer ASS/kinetic typography to phase 2.

Concrete minimal phase:
1. Honor `Scene.overlay` for image/video scenes in `LocalFFmpegRenderer`:
   append a `drawtext` (or `overlay` of a rasterized PNG) stage to the existing
   filter chain. Text = `overlay.text`; position = `overlay.position`
   (top/center/bottom); default style from width.
2. Add a strict text escaper (colons, quotes, commas, backslashes, `%`, `'`)
   and a small unit-test matrix.
3. Add `timing.fadeIn/fadeOut` (scene-local, default e.g. 0.3s) -> `alpha=`
   expression, so text fades cleanly with the scene fade (`buildSceneFadeFilters`).
4. Include the new fields in `createSceneRenderFingerprint` so changed text/
   style/timing invalidates cached renders.
5. Wire the dead `renderSettings.subtitlesEnabled` minimally: when true and a
   scene has no overlay, optionally show `narration.text` as a bottom caption
   (same `drawtext` path). This makes the existing config meaningful.
6. Tests: still path, video path, escaping, fingerprint invalidation, and one
   ffprobe assertion that width/height/fps/duration are unchanged.

Explicitly out of scope for phase 1: word-level timing, ASS/karaoke, global
caption track at composition, animation timeline UI. Phase 2 (ASS generator)
can reuse the same `OverlaySpec` additions without a model migration.

Validation note: all three FFmpeg techniques were exercised locally with
FFmpeg 5.1.9 in this environment (`drawtext` and ASS both produced valid 2s
MP4s); no paid services were used.
