# P304 · Findings (pre-implementatie)

Recon only tot hier. Geen productiecode gewijzigd in deze notitie.

Inspectiedatum: 2026-10-27. Branch: `261021-feat-motion-canvas-animation-mcp`.

## Bevestigd

- `buildSceneFadeFilters(durationSeconds)` negeert `TransitionSpec`. Heuristiek `min(0.35, max(0.12, duration/10))`; skip als `duration <= 2 * fade`.
- Still, studio-still (niet-zwart), video, studio-video: altijd die filters. `color=black` still/studio-still: geen fade.
- Composition-layer pad (`scene-composition-compositor.ts`): geen scene-fade.
- Default normalisatie: ontbrekende transition → `{ type: 'fade' }`. Bestaande projecten zonder veld blijven fade. Niet herschrijven.
- Fingerprint bevat al `scene.transition` (type + duration). Composition-fingerprint niet; concat-output verandert niet.
- `crossfade` is een legaal documenttype (sample project, UI-select). Geen FFmpeg-pad. Geen overlap-tijdas.

## Geen blokkade

P303 blijft gelden: geen xfade, geen duration-authority-wijziging. P304 is scene-lokale fade-to-black plus eerlijke `none`/`crossfade`.

## Voorgenomen semantiek

- `none`: geen scene-fadefilters.
- `fade`: in/out naar zwart binnen scèneduur; `transition.duration` indien geldig, anders heuristiek; clamp tot huidige max 0.35 en tot `duration/2` zodat fades niet overlappen.
- `crossfade`: blijft in het document (geen data-migratie); validatiewarning unsupported; renderer geen scene-fade (niet stiekem `fade`).
- Zelfde helper op still/video/studio én composition-lagen. Overlay-tekst en music-afade ongemoeid.
- Composition fingerprint ongewijzigd.

## Implementatie (afgerond)

- `buildSceneFadeFilters(duration, transition)` in `lib/render/render-source.ts`: alleen `fade` produceert filters; `none`, `crossfade` en ontbrekend geven `[]`. Nieuwe `resolveSceneFadeSeconds` klemt authored duur op 0.12-0.35 en op `duration/2`; ongeldige/niet-positieve duur valt terug op de heuristic. Fade wordt overgeslagen als `duration <= 2 * fade`.
- Alle vier rendererpaden geven `scene.transition` door (still, studio-still, video, studio-video). `color=black` still/studio-still krijgen nu ook fade (vóór overlay/logo). Studio-black-pad gebruikt `[...fadeFilters, 'null']`.
- Composition-layer pad: `buildCompositionLayerFilters` heeft optionele `fadeFilters`; `buildCompositionSceneArgs` vult die met `buildSceneFadeFilters(scene.duration, scene.transition)`. Fade staat na de laagstack en vóór tekstoverlay en logo.
- Validatie: `crossfade` blijft geldig met warning `scene.transition.crossfade.unsupported`; expliciete `transition.duration` moet positief en eindig zijn (`scene.transition.duration.invalid`).
- UI: `TRANSITION_PRESET_LABELS` / `formatTransitionLabel`; dropdown labelt `crossfade (unsupported)`, preview-chip en SummaryRow tonen hetzelfde label.
- Geen data-migratie, geen duration-authority-wijziging, geen composition-fingerprint-wijziging.

### Verificatie

- Nieuw: `tests/scene-fade-filters.test.ts` (unit + validatie + source-guard).
- Nieuw: `tests/scene-transition-render.integration.test.ts` (echte FFmpeg: fade donker kop/staart, none en crossfade helder).
- Uitgebreid: `tests/scene-composition-compositor.test.ts` (filtervolgorde en echte composition-fade), `tests/scene-preview.test.tsx` (crossfade-label).
- Regressie groen: renderer, studio/composition, fingerprint/freshness, UI, validatie (gerichte runs).
- Volledige suite: 1565/1571 groen. De 6 failures (page-authorization, run-music-opt-in, run-policy, generate-video-route x2, mcp-credential-failclosed-stdio) zijn identiek op een schone baseline-worktree zonder P304-wijzigingen; dus pre-existent en niet transition-gerelateerd.
- `npx tsc --noEmit` schoon; `npm run lint` alleen de bestaande `paid-submit-cap.ts` warning.
