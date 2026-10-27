# P15 - Audio Completeness Recon

Status: RECON ONLY. No code, migrations, deps, provider integrations, or commits.
Purpose: map what exists for audio (narration/TTS, music, SFX, subtitles) and stand up a
phased proposal. This is the P7 remainder identified in `project-baseline-recon.md`
(P15 section).

---

## 1. Scope and hard constraints carried into this recon

- No code changes, migrations, or commits until approval.
- No new dependencies and no new provider integrations.
- No LLM-director / scene-intent changes.
- Preserve existing production flows and provider security (P12/P13/P14).
- Real paid providers only behind explicit opt-in + credentials; default fake/mock.
  Manual generation path resolves through `resolveManualGenerationProvider` in
  `lib/production/run-policy.ts` (single policy authority).
- Renders must stay reproducible; missing optional audio must not crash production.
- Tests use fake/mocked adapters only; never call paid APIs.

---

## 2. Current architecture (verified, with references)

### 2.1 Data model (present)

- `Scene.narration: NarrationSpec` in `lib/types/scene.ts`: `text`, `voiceId`, `model`,
  `format` (`mp3|wav|m4a`), `audioAssetId`, `status` (`planned|generating|generated|failed`),
  `lastAttemptId`, `error`, `duration`, `attempts[]`.
- `NarrationGenerationAttempt` in `lib/types/scene.ts`: `provider`, `providerRequestId`,
  `mimeType`, `audioAssetId`, timestamps.
- `AssetType` includes `audio | music | voice` (`lib/types/asset.ts`); `AssetProvenance`.
- `RenderSettings` in `lib/types/render.ts:8`:
  - `audio: { narrationVolume, musicVolume, effectsVolume }`
  - `subtitlesEnabled: boolean`
- `CompositionItem` (`lib/types/render.ts:126`) already carries
  `narrationAudioPath?` and `narrationAudioDuration?`.
- `CompositionArtifact.inputFingerprint.version = 'p10.1'` with per-scene
  `narrationSignature` (`lib/types/render.ts:149`).
- Defaults in `lib/constants.ts:46`: `narrationVolume: 1`, `musicVolume: 0.35`,
  `effectsVolume: 0.2`, `subtitlesEnabled: true`; normalized in
  `lib/projects/normalize-project.ts:334`.
- `OverlayType` includes `subtitle` (`lib/types/scene.ts:18`).

### 2.2 Narration / TTS (present, functional)

- Providers: `lib/ai/text-to-speech/{provider,registry,elevenlabs-provider,fake-provider}.ts`.
  Interface `TextToSpeechProvider.synthesize()` returns data/format/duration.
  Fake provider emits 0.25s silence WAV.
- Registry: `elevenlabs | fake`; `getTextToSpeechConfigurationStatus()` reports
  `{ elevenlabsConfigured, defaultProvider }`.
- Service: `lib/generation/narration-service.ts` -> `generateSceneNarration()`:
  - Provider resolution via `resolveManualGenerationProvider('narration', ...)`
    (`narration-service.ts:128`), so mock mode rejects ElevenLabs before any paid call.
  - Env: `TTS_DEFAULT_VOICE_ID`, `ELEVENLABS_TTS_MODEL`, `TTS_DEFAULT_FORMAT`.
  - Per-`project:scene` lock; attempt history; status transitions.
  - Persists via `mediaStore.saveGeneratedAudio()` (`lib/storage/media-store.ts:335`),
    storing asset `type: 'audio'`, `provenance: 'generated'`.
- Freshness: `lib/generation/narration-freshness.ts` -> `deriveNarrationFreshness()`
  (`no_narration|no_audio|generating|failed|current|stale`) with a signature over
  text/voice/model/format/asset.
- API: `app/api/projects/[id]/scenes/[sceneId]/generate-narration/route.ts`.
- UI: narration text/voice controls + generate/regenerate/retry in
  `components/project/project-workspace.tsx`.

### 2.3 Composition / mixing (present, narration-only)

- `lib/render/video-composition-service.ts`:
  - `resolveCompositionPlan()` builds `CompositionItem[]`, resolving
    `narrationAudioPath` from `scene.narration.audioAssetId` via `resolveNarrationAudioPath()`
    (`video-composition-service.ts:95`). Rejects narration audio whose asset type is not
    `audio|music|voice`, or whose duration exceeds scene duration
    (`:111`).
  - `ensureSceneRenders()` renders/stale-renders scenes before compose.
  - `composeProject()` locks per project, builds artifact, appends to
    `project.compositions`, writes metadata JSON.
- `lib/render/video-compositor.ts` (`COMPOSER_VERSION = 'p7'`):
  - `buildNormalizeArgs()` policy (`:32`): exactly one audio track per scene segment.
    Narration if present -> else embedded scene audio -> else `anullsrc` silence.
    Trim/pad to scene duration, resample 48k.
  - `buildComposeArgs()` concat-demuxer joins normalized segments.
  - `validateOutput()` requires a video stream (correct WxH), an audio stream, an mp4
    container, and duration within tolerance of `plan.totalDuration`.
  - IMPORTANT: `renderSettings.audio.*` volumes are NOT applied anywhere in the
    compositor. There is no `volume=` filter. The mix is narration-or-silence at unity.
  - `transition` (`none|fade`) is stored on the plan/artifact but not implemented in
    FFmpeg args (concat only).

### 2.4 Freshness / readiness integration

- `lib/render/render-status.ts`:
  - `deriveCompositionReadiness()` counts scenes with narration audio and flags
    invalid narration assets (`invalidNarrationAudioSceneIds`).
  - `deriveCompositionArtifactStatus()` marks an artifact `stale` when scene renders
    are stale and when `narrationSignature` changed since composition.
- Producer/consumer are consistent, but the fingerprint covers only render id +
  narration signature. It does not cover audio volumes or any future music/SFX cue.

### 2.5 Production integration (present)

- Planner `lib/production/production-planner.ts` emits a `narration_generate` action per
  scene from freshness state (`:261`), plus `scene_render` and `final_compose`.
- Runner order `image -> video -> narration -> scene_render -> final_compose`
  (`production-runner.ts:413`); concurrency includes `narration_generate: 2`, `final_compose: 1`.
- Executor wiring in `lib/production/run-service.ts`:
  - deps `generateNarration: generateSceneNarration`, `composeProject: videoCompositionService.composeProject`
    (`:99`).
  - `narration_generate` handler (`:788`) passes provider from the locked policy.
  - `final_compose` handler (`:857`).
- Policy `lib/production/run-policy.ts`: `narration: 'elevenlabs' | 'fake'`; real mode
  requires `ELEVENLABS_API_KEY` (`:254`, `:360`).

### 2.6 UI / API surface

- API routes: `compose`, `compositions`, `compositions/[compositionId]`, `/file`,
  scene `generate-narration`, `render`, assets, `render`/`renders`.
- Compose POST body accepts only `transition` (`app/api/projects/[id]/compose/route.ts:24`).
- No route or UI updates `renderSettings.audio` or `subtitlesEnabled`; they are only
  defaulted/normalized. Confirmed dead settings from the user's perspective.
- `project-workspace.tsx` has narration + render + compose controls; asset browser groups
  `audio|music|voice` as "audio" (`:132`), but there is no music/SFX assignment UI.

---

## 3. Present vs missing matrix

| Capability | State | Evidence |
|---|---|---|
| Per-scene narration TTS (fake/ElevenLabs) | Present | `narration-service.ts`, `text-to-speech/*` |
| Narration freshness + attempt history | Present | `narration-freshness.ts`, `Scene.narration` |
| Composition mux narration-or-silence | Present | `video-compositor.ts:32` |
| Volume mix (`narrationVolume`/`musicVolume`/`effectsVolume`) | Missing | settings only defined/normalized |
| Background music bed | Missing | no music service/cue model/route |
| SFX cues | Missing | no SFX model/route |
| Timed subtitles (sidecar or burn-in) | Missing | `subtitlesEnabled` unused; no `.srt` output |
| Static subtitle overlay text in scene render | Present (different feature) | `render-source.ts:53` template `data.subtitle` |
| Narration duration as timing authority | Missing | scene duration manual; intent timing default 5s |
| Compose fade transitions | Missing | stored only, not applied |
| Composition fingerprint covers mix inputs | Missing | fingerprint = render id + narration signature |

Confirmed vs suspected:
- Confirmed: narration-only mix; volume flags dead; subtitle flag dead; no music/SFX.
- Confirmed: `subtitlesEnabled` has no consumer outside types/normalize/constants/scripts.
- Suspected (needs confirm during implementation): FFmpeg `subtitles`/`concat` filter
  availability in the target environment (FFmpeg is not on PATH here, so 2 pre-existing
  render tests fail). Any burn-in work must degrade gracefully when the filter/libass is
  unavailable.

---

## 4. Proposed phases (scope / files / tests / risk / mock-vs-real)

Each phase is independently shippable and reversible. Order chosen to land the smallest
reproducible value first. All phases: local FFmpeg + existing assets only; no new deps;
no new providers; default fake/mock; optional inputs must not break a render.

### P15.1 - Audio mix foundation (volumes)
- Scope: apply `renderSettings.audio.narrationVolume` in `buildNormalizeArgs`; carry an
  `audio` mix block onto `CompositionPlan`/`CompositionItem`; add `volume=` filter.
  Keep silence fallback. No behavior change at default volume 1.
- Files: `lib/render/video-compositor.ts`, `video-composition-service.ts`,
  `lib/types/render.ts` (plan types), `render-status.ts` (fingerprint note).
- Tests: extend `tests/video-compositor-args.test.ts` (assert `volume` filter, still one
  audio track, silence fallback); `tests/video-composition-plan.test.ts`.
- Risk: low. Reproducible, deterministic.
- Mock/real: fully local; works in mock.

### P15.2 - Background music bed
- Scope: optional project-level music asset + `musicVolume`; loop/trim to total duration;
  mix under narration (sidechain not required) with `amix`; persist selection on project.
- Files: `lib/types/render.ts` (music selection field), `video-compositor.ts`
  (extra input + `amix`), `video-composition-service.ts` (resolve asset),
  `app/api/projects/[id]/route.ts` (update selection), a small UI selector,
  `render-status.ts` fingerprint includes music asset id/volume.
- Tests: args tests for amix/loop/trim; plan test with/without music; missing music asset
  -> clean error or ignored (fail-safe: prefer ignore + warning, never crash).
- Risk: medium (FFmpeg filter graph growth; duration/loop edge cases). No external
  provider: music comes from user-imported assets only.
- Mock/real: fully local; works in mock.

### P15.3 - SFX cues
- Scope: per-scene cue list `{ assetId, startSeconds, volume }` merged into the scene's
  normalization stage with `adelay`+`amix`.
- Files: `lib/types/scene.ts` or render types (cue model), `video-compositor.ts`,
  `video-composition-service.ts`, UI.
- Tests: args tests for delay/mix; cue beyond scene duration trimmed; missing asset ignored.
- Risk: medium-high (more moving parts, timing). Defer unless music lands cleanly.
- Mock/real: fully local.

### P15.4 - Subtitles
- Scope (preferred): generate a sidecar `.srt` from scene narration text with per-scene
  timing from the composition plan; expose via compositions file route when
  `subtitlesEnabled`. Optional later: burn-in via FFmpeg `subtitles=` filter, gated and
  feature-detected.
- Files: new `lib/render/subtitle-builder.ts`, `video-composition-service.ts`
  (write sidecar, record path), `lib/types/render.ts` (artifact field),
  compositions file route, UI toggle that actually writes `subtitlesEnabled`.
- Tests: `subtitle-builder` unit tests (cue timing, escaping, empty narration),
  plan/service integration with toggle on/off.
- Risk: low for sidecar; medium for burn-in (libass availability). Do sidecar first.
- Mock/real: fully local; no provider. Timing authority remains scene duration.

### P15.5 - Narration-duration timing authority (optional, higher risk)
- Scope: allow scene duration to follow narration audio duration (when present) instead
  of manual duration. Interacts with render timing and freshness fingerprints.
- Risk: high (changes render duration/reproducibility; invalidates caches/artifacts).
- Recommendation: treat as separate opt-in phase; only after P15.1-P15.4.
- Mock/real: local.

### P15.6 - Planner/runner + UI wiring (per phase as needed)
- Only add planner actions if a capability must run inside a production run. Music/SFX
  selection are inputs, not generation steps, so they likely need only project-update +
  compose, not new run actions. Subtitles can be produced as part of `final_compose`
  (no new action) to avoid policy/planner churn.
- Risk: low if we avoid new action types.

---

## 5. Locally-runnable vs needs real production identity/provider

- Locally runnable in mock/fake (no secrets): P15.1, P15.2, P15.3, P15.4, P15.5.
  All mixing/subtitles are FFmpeg + existing assets; narration already has a fake provider.
- Needs a real paid provider: only real ElevenLabs narration (already gated by
  `ELEVENLABS_API_KEY`; unchanged by P15). No new provider work proposed.
- Needs real production identity: nothing in P15 itself. Note that per P14, production
  browser sessions require an external IdP; local mock/session work is unaffected.

---

## 6. Open questions (need a decision before implementation)

1. Subtitles: sidecar `.srt` only, or also optional burn-in? (Proposing sidecar first.)
2. Music/SFX source: confirm user-imported assets only (no generated music provider).
3. Volume semantics: linear `volume=` filter (proposed) vs loudness normalization.
4. P15.5 timing authority: in scope for P15 or a separate phase?
5. Compose `fade` transition: should it be implemented here or stay out of P15 scope?

---

## 7. STOP

No implementation started. Awaiting approval of phase scope and answers to Section 6.
