# P22 Audio Pipeline Recon

Status: RECON ONLY. No application code, schemas, tests, dependencies, or
configuration were changed. No commits, no pushes, no paid TTS/music calls, and
no real external-provider audio was generated. Every claim below is based on the
current source in this repository plus safe local checks (ffprobe / music-metadata
against locally synthesized fixtures).

Evidence tags used throughout:

- **Verified by test** — an existing test in this repo asserts the behavior, and
  the suite was executed in this pass.
- **Code-inspected** — established by reading the implementation; deterministic
  but not executed end-to-end here.
- **Verified (local)** — observed by running a safe local command (ffprobe /
  music-metadata) on locally generated fixtures, no network.
- **Unverified** — plausible but not proven by evidence gathered here.
- **Potential risk** — a concrete failure mode that follows from the code; may
  need a controlled reproduction to fully confirm.

---

## 1. Executive summary

The audio pipeline is real and functional for narration and background music,
but it is narration-or-music only; there is no sound-effects path at all, and the
`effectsVolume` setting is dead. Audio is assembled at final composition time, not
at scene-render time.

Concretely:

- **Narration**: per-scene TTS with a `fake` mock and a real `elevenlabs` adapter,
  attempt history, freshness tracking, and a hard "narration must not exceed scene
  duration" guard. Persisted as project assets (`type: 'audio'`).
- **Music**: project-level background track with a `fake` mock and a real
  `elevenlabs` adapter, selection/clearing, loop + volume + fades, mixed with
  `amix` + `alimiter` over the concatenated video.
- **Effects**: **not implemented end-to-end.** There is no effects data model, no
  asset/cue model, no API, and no UI. `effectsVolume` is normalized and compared
  but never applied to any FFmpeg filter.
- **Timing/mixing**: each scene segment is normalized to exactly one audio track
  (narration → embedded scene audio → silence), trimmed/padded to the scene
  duration and resampled to 48 kHz; the concat demuxer joins segments and the
  final output is validated to contain an audio stream and match the total
  duration.

Confirmed defects/risks found (detail in §4):

1. **Fake TTS produces an undeccodable, mislabeled narration asset** on the
   default (mock) path: it emits a 44-byte, zero-sample WAV but reports the
   requested format. For an `mp3` request the bytes are WAV, the file is saved as
   `.mp3` with `mimeType: audio/mpeg`, and the probed duration is `undefined`
   (the provider's hardcoded `0.25` is discarded). **Verified (local) + Code-inspected.**
2. **ElevenLabs `m4a` request maps to MP3 output** (`output_format=mp3_44100_128`)
   while `Accept: audio/mp4` and the recorded `format` is `m4a`.
   **Code-inspected.**
3. **`effectsVolume` is dead**; no SFX mix exists. **Verified by test + Code-inspected.**
4. **Narration/music regeneration leaves previous assets on disk** (append-only
   asset list). **Verified by test + Code-inspected.**
5. **No loudness limiting when music is absent**, so narration volume above unity
   can clip. **Potential risk.**

Highest-value verified issue for the next phase: **fix fake TTS so mock narration
is a real, decodable, correctly-labeled audio file** (mirror the music mock's
`buildSilentWav`), and align the ElevenLabs `m4a` mapping in the same format-
consistency pass.

---

## 2. Audio architecture and end-to-end flow

### 2.1 Data model (present)

- `Scene.narration: NarrationSpec` — `text`, `voiceId`, `model`, `format`
  (`mp3|wav|m4a`), `audioAssetId`, `status`, `lastAttemptId`, `error`,
  `duration`, `attempts[]` (`lib/types/scene.ts:40-69`).
- `Project.music?: ProjectMusicSpec` — `assetId`, `prompt`, `provider`, `model`,
  `status`, `instrumental`, `musicLengthMs`, `format`, `seed`, `duration`,
  `attempts[]` (`lib/types/render.ts:67-85`).
- `RenderSettings.audio: AudioMixSettings` — `narrationVolume`, `musicVolume`,
  `effectsVolume` (`lib/types/render.ts:8-12, 23`). Defaults `1 / 0.35 / 0.2`
  (`lib/constants.ts:45-49`).
- `CompositionItem` carries `narrationAudioPath?`, `narrationAudioDuration?`
  (`lib/types/render.ts`, used at `video-composition-service.ts:180-191`).
- `AssetType` includes `audio | music | voice` (`lib/constants.ts:30`).
- **No effects/SFX model exists** on `Scene`, `Project`, or `Asset` (only
  `effectsVolume` in `AudioMixSettings`).

### 2.2 Narration / TTS flow

1. API `POST app/api/projects/[id]/scenes/[sceneId]/generate-narration/route.ts`
   → `generateSceneNarration()` (`lib/generation/narration-service.ts:139`).
2. Provider resolved through policy `resolveManualGenerationProvider('narration',
   ...)` (`narration-service.ts:128`), registry `elevenlabs | fake`
   (`lib/ai/text-to-speech/registry.ts:13-25`).
3. Providers: `FakeTextToSpeechProvider` (`fake-provider.ts`),
   `ElevenLabsTextToSpeechProvider` (`elevenlabs-provider.ts`).
4. Synthesized bytes → `mediaStore.saveGeneratedAudio()` (`media-store.ts:353`)
   → asset `type: 'audio'`, `provenance: 'generated'`, extension chosen from the
   declared mime type (`media-store.ts:356`).
5. Persisted into `Scene.narration` (asset id, duration, status, attempts)
   (`narration-service.ts:324-352`).
6. Freshness/signature: `deriveNarrationFreshness()` over
   text/voice/model/format/asset id (`lib/generation/narration-freshness.ts`).

### 2.3 Background music flow

1. API `POST app/api/projects/[id]/music/route.ts` actions `generate | regenerate
   | select | clear` → `lib/generation/music-service.ts`.
2. Registry `fake | elevenlabs` (`lib/ai/music/registry.ts`).
3. Providers: `FakeMusicProvider` (real silent WAV with correct duration,
   `fake-provider.ts:14-65`), `ElevenLabsMusicProvider` (MP3-only,
   `elevenlabs-provider.ts`).
4. Bytes → `mediaStore.saveGeneratedMusic()` (`media-store.ts:392`), asset
   `type: 'music'`.
5. Selection stored on `project.music.assetId`; clearing only drops the reference
   (`music-service.ts:405-422`).
6. UI: `components/project/background-music-panel.tsx` (preview `<audio>` at
   :198), client `lib/client/music-client.ts`, validation `lib/music/music-form.ts`.

### 2.4 Sound effects flow

**Absent.** The only artifacts are the `effectsVolume` field and its
normalization/equality helpers. No cue model, no assignment, no mixing.

### 2.5 Scene rendering (audio)

`LocalFFmpegRenderer` (`lib/render/renderer.ts`) renders one scene per call:
- Still/blank scenes: video only, `-an` (no audio) (`renderer.ts:150-185, 221-222`).
- Video scenes with a source audio stream: embedded audio is preserved, trimmed
  with `atrim=duration=<scene.duration>`, `asetpts`, `apad` (`renderer.ts:210-218`).
- **Narration is never embedded at scene-render time**; it is added at composition.

### 2.6 Final composition (mixing)

`VideoCompositionService.composeProject()` (`video-composition-service.ts:280`):
- `resolveCompositionPlan()` builds ordered items, resolving `narrationAudioPath`
  and the selected music asset (`:105-207`); `totalDuration` = sum of render
  durations (`:202`).
- `LocalFFmpegVideoCompositor.compose()` (`video-compositor.ts:261`) runs, per item,
  `buildNormalizeArgs()` producing exactly one audio track:
  narration if present → else embedded `0:a` → else `anullsrc` silence; then
  `atrim=0:<dur>,apad=pad_dur=<dur>,aresample=48000` and, only for narration,
  `volume=<narrationVolume>` (`video-compositor.ts:52-112`).
- `buildComposeArgs()` concat-demuxes the normalized segments, re-encoding audio
  to AAC (`:114-135`).
- If music is selected, `buildMusicMixArgs()` adds a looped music input
  (`-stream_loop -1`), `volume=<musicVolume>`, `atrim=0:<total>`, `afade` in/out,
  and `amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95`
  with video stream-copied (`:155-204`).
- `validateOutput()` requires an audio stream and an MP4 container and checks
  duration within tolerance (`:221-252`).

Handoff summary: scene renders (video [+embedded audio]) → per-scene normalization
(narration or silence) → concat → optional music mix → validated MP4.

---

## 3. Capability matrix

| Capability | Status | Evidence |
| --- | --- | --- |
| Per-scene narration TTS (real provider) | Implemented | Code-inspected (`elevenlabs-provider.ts`) |
| Per-scene narration TTS (mock) | Implemented but degenerate | Verified (local): 44-byte zero-sample WAV |
| Narration format/extension/mime consistency | **Inconsistent** | Code-inspected + Verified (local) |
| Narration duration measurement | Works only when bytes are decodable | Verified (local) |
| Narration > scene duration guard | Implemented (rejects) | Verified by test (`narration-service.test.ts`) |
| Narration attempt history + recovery | Implemented; keeps previous asset on failure | Verified by test |
| Background music (real + mock) | Implemented | Code-inspected; music tests pass |
| Music loop + volume + fades + `amix`/`alimiter` | Implemented | Verified by test (`video-compositor-args.test.ts`) |
| Music selection / clear / regenerate | Implemented | Code-inspected; `music-service.test.ts` |
| Music duration vs total composition | Trim/loop to total | Verified by test (args) |
| Sound effects model | **Missing** | Code-inspected (no field anywhere) |
| SFX asset import / scene assignment / UI / API | **Missing** | Code-inspected |
| `effectsVolume` applied to samples/filters | **No** | Verified by test + Code-inspected |
| `narrationVolume` applied | Yes (narration track only) | Verified by test |
| `musicVolume` applied | Yes (music track only) | Verified by test |
| One audio track per scene segment | Yes | Verified by test |
| Audio stream required in final output | Yes (validated) | Code-inspected |
| Loudness normalization / limiting | Only when music present (`alimiter`) | Code-inspected |
| Composition fingerprint covers mix inputs | narrationSignature + music (volume/signature); **not effects** | Code-inspected |

---

## 4. Confirmed defects and risks

### 4.1 Fake TTS is undeccodable and mislabeled (default path) — Verified (local)

`lib/ai/text-to-speech/fake-provider.ts:3-4` defines a 44-byte base64 WAV header
with **zero audio frames**. `synthesize()` returns those bytes, an empty-data WAV,
with `duration: 0.25` hardcoded and `mimeType` derived from the *requested*
format (`:18-27`).

Local verification:
- `ffprobe` on the decoded bytes reports `format_name=wav, codec=pcm_u8,
  sample_rate=8000, channels=1, duration=N/A` (no samples).
- `music-metadata` via the same path used by `mediaMetadataReader`:
  - with `mimeType: 'audio/mpeg'` (an mp3 request) → parse yields `duration:
    undefined`;
  - with `mimeType: 'audio/wav'` → `WAVE/PCM`, `duration: undefined`.

Downstream effect (`narration-service.ts:308-352`, `media-store.ts:353-390`):
- Extension is chosen from the declared mime type (`media-store.ts:356`), so an
  `mp3` request writes `scene-XX-narration-<id>.mp3` containing WAV bytes.
- `asset.duration` is taken from the probe (`media-store.ts:370`), so the stored
  `narration.duration` is `undefined`, **not** the provider's `0.25`.
- `narration-service` validates length using `synthesized.duration` (0.25) but
  stores `generatedAsset.duration` (undefined) — the two disagree
  (`narration-service.ts:278-306` vs `:334`).

Impact: on the default (mock) path, narration is effectively silent and has no
measurable duration. Composition still succeeds because the compositor pads the
narration track to the scene duration and generates silence otherwise, but the
mock cannot exercise real timing behavior and the artifact is mislabeled.

Note: the **music** mock does this correctly — `buildSilentWav()` produces a real,
decodable PCM WAV whose duration matches the request
(`lib/ai/music/fake-provider.ts:14-35`); `music-metadata` reported `duration: 3`
for a 3000 ms fixture. So the TTS mock is inconsistent with its sibling.

### 4.2 ElevenLabs `m4a` maps to MP3 bytes — Code-inspected

`outputFormatForRequest()` maps `wav → pcm_44100`, `m4a → mp3_44100_128`,
`mp3 → mp3_44100_128` (`elevenlabs-provider.ts:10-18`), while `Accept` is set to
`audio/mp4` for `m4a` (`:20-28, 78`). The recorded `format` is the request format
(`:115`), and `mimeType` uses the response content-type when present (`:106`).

Impact: a user requesting `m4a` gets MP3 data. Depending on the provider's
response content-type, the stored extension may be `.mp3` (if `audio/mpeg`) or
`.m4a` (if `audio/mp4`) with MP3 bytes; either way `narration.format` says `m4a`
while the bytes are MP3. This is a real-provider format-compatibility issue, not a
mock artifact.

### 4.3 `effectsVolume` is dead / no SFX — Verified by test + Code-inspected

`effectsVolume` is present in the model (`lib/types/render.ts:11`), defaulted
(`lib/constants.ts:48`), normalized (`audio-mix.ts:29`), and compared for
equality (`audio-mix.ts:45`), but `formatVolumeFilter` is only invoked for
narration and music (`video-compositor.ts:83, 163`). No `effects`/`sfx` field,
asset cue, route, or UI exists anywhere (repo-wide search). The args tests
confirm only `volume=<narration>`, `volume=<music>` and no effects filter
(`tests/video-compositor-args.test.ts`).

### 4.4 Regeneration accumulates assets on disk — Verified by test + Code-inspected

`narration-service.ts:349` and `music-service.ts:311` append the new asset to
`project.assets` and do not remove the previous one. `narration-service.test.ts`
asserts `assets.length === 2` after a successful regeneration. `clearProjectMusic`
deliberately keeps the file (`music-service.ts:414-419`). There is no GC/cleanup
path.

### 4.5 No limiter without music — Potential risk

`alimiter=limit=0.95` is applied only inside `buildMusicMixArgs`
(`video-compositor.ts:175`). With no music, the narration volume filter allows up
to `4.0` (`audio-mix.ts:5`, `video-compositor.ts:83`), so a narration volume above
unity can clip. Not observed as audible in this pass (no listening tests were
performed).

### 4.6 Minor: audio duration authority mismatch — Code-inspected

The composition uses `render.duration` (actual rendered duration) as the segment
duration (`video-composition-service.ts:185`), while the narration length guard
compares against `scene.duration` (`:121`). Because renders are validated within
`max(0.25, 1/fps)` of `scene.duration`, a narration tail could in principle be
trimmed by up to ~0.28 s by `atrim` in `buildNormalizeArgs`.

---

## 5. Provider and file-format compatibility findings

| Provider | Declared format | Actual bytes | MIME stored | Extension | Duration |
| --- | --- | --- | --- | --- | --- |
| TTS `fake`, request `wav` | `wav` | WAV (0 frames) | `audio/wav` | `.wav` | undefined |
| TTS `fake`, request `mp3` | `mp3` | **WAV (0 frames)** | `audio/mpeg` | `.mp3` | undefined |
| TTS `fake`, request `m4a` | `m4a` | **WAV (0 frames)** | `audio/mp4` | `.m4a` | undefined |
| TTS `elevenlabs`, request `wav` | `wav` | `pcm_44100` | response CT / `audio/wav` | `.wav` | probed |
| TTS `elevenlabs`, request `m4a` | `m4a` | **MP3** (`mp3_44100_128`) | response CT | `.mp3` or `.m4a` | probed |
| Music `fake` | `wav` | WAV (correct length) | `audio/wav` | `.wav` | correct |
| Music `elevenlabs` | `mp3` | MP3 | `audio/*` or `audio/mpeg` | `.mp3` | probed |

Key compatibility notes:
- `mediaMetadataReader` returns the **input** mime type unchanged
  (`metadata-reader.ts:77-80`); it never sniffs the true container. So a mislabeled
  asset stays mislabeled in `asset.mimeType`.
- File-extension selection is driven entirely by the declared mime type
  (`media-store.ts:356, 395`), not by content.
- Playback/composition does not fail because FFmpeg sniffs by content; the
  mismatch is metadata-level, not decoding-level.

---

## 6. Existing test coverage and limitations

Executed in this pass (all pass): `audio-mix`, `music-mix`, `music-normalization`,
`video-compositor-args`, `video-composition-plan`, `narration-service`,
`music-service`, `background-music-panel`, `music-elevenlabs-provider`,
`music-provider-registry`, `music-client`, `music-form`, `narration-freshness`
— **96 tests / 13 files green**.

What is covered:
- Volume clamping and normalization (`audio-mix.test.ts`).
- Normalize/compose/music-mix FFmpeg **arguments** (narration volume, silence
  fallback, embedded-audio passthrough, loop, fades, `amix`, `-c:v copy`)
  (`video-compositor-args.test.ts`).
- Composition plan construction incl. narration asset resolution and clamping
  (`video-composition-plan.test.ts`).
- Narration service lifecycle: regenerate keeps previous asset, failure preserves
  previous asset, length guard (`narration-service.test.ts`).
- Music service lifecycle and provider error mapping.
- Real FFmpeg composition integration (`video-composition-service.integration.test.ts`)
  with synthesized tone narration.

Limitations / gaps:
- The integration test asserts the final file exists, is non-empty, and the
  artifact fields — it does **not** probe the composed audio stream, its duration,
  volume, or the presence of music in the mix. Music-mix integration (real
  `amix`) has no end-to-end test; only its argument string is asserted.
- No test covers the fake TTS byte/format mismatch, the ElevenLabs `m4a` mapping,
  or the empty-WAV duration loss.
- No sound-effects tests exist (nothing to test).
- No listening/perceptual audio-quality test was performed (and none is claimed).

Prior evidence reused (not regenerated): P18 smoke produced a real decodable MP4
(h264 + aac) via FFmpeg; P15 recon already flagged volumes/SFX as missing before
P15.1/P15.2 landed narration/music mixing.

---

## 7. Prioritized next-phase recommendation

**P23 — Make mock narration a real, correctly-labeled audio asset (and align the
ElevenLabs `m4a` mapping).** Focused on the highest-value verified issue (§4.1).

Scope:
1. Replace the fixed 44-byte TTS fake payload with a real PCM WAV whose duration
   matches a sensible, declared length (mirror `lib/ai/music/fake-provider.ts`'s
   `buildSilentWav`), so the asset is decodable and its probed duration is real.
2. Stop echoing the requested format unless the emitted bytes match it: either
   emit format-correct bytes per request, or emit WAV and report `wav` truthfully
   (including MIME and extension). Keep the mock deterministic and offline.
3. Align `ElevenLabsTextToSpeechProvider`: either request a genuine `m4a`/`mp4`
   output format for `m4a`, or map `m4a → mp3_44100_128`, drop the misleading
   `Accept: audio/mp4`, and record/derive the stored extension/format from the
   actual bytes. Reconcile `narration-service` so the validated duration and the
   stored `generatedAsset.duration` come from the same source.

Why this first: it is on the default (mock) path, it is verified by both code
inspection and local ffprobe/music-metadata runs, the fix is localized and
low-risk, and it makes mock-mode narration usable for realistic timing and
composition testing without any paid calls.

Regression tests to add:
- Fake TTS: emitted bytes probe to a WAV with `duration > 0` matching the declared
  length; MIME/extension/format agree with the bytes for `wav`/`mp3`/`m4a` requests.
- ElevenLabs TTS: assert the request `output_format`/`Accept` and the resulting
  `format`/`mimeType` are consistent for `m4a`.
- Narration service: assert `narration.duration` equals the probed asset duration
  (not the provider's transient value).
- Optional: extend the composition integration test to probe the final MP4 audio
  stream (codec/duration) and add one music-mix integration case.

Secondary (bundle if scoped): lock in the SFX gap explicitly (§4.3) by either
removing `effectsVolume` or documenting it as reserved, so a declared config field
is not mistaken for working functionality.

Boundaries respected in this recon: no TTS/music/SFX/UI providers were modified,
no paid calls were made, no schemas/dependencies/config changed, and nothing was
committed or pushed.
