# P23 — TTS format and duration consistency fix

## 1. Summary

P23 fixes the highest-value, verified audio defects called out in
`p22-audio-pipeline-recon.md` §4.1 and §4.2:

1. The mock (default) text-to-speech provider now emits a **real, decodable PCM
   WAV** with nonzero samples and a truthful duration, instead of a 44-byte
   zero-frame WAV header that probed to `duration: undefined`.
2. The fake provider now reports the format it **actually** emits (`wav`,
   `audio/wav`) instead of echoing the requested format, so declared
   format/MIME/extension and the bytes always agree.
3. The ElevenLabs provider no longer labels MP3 bytes as M4A. Since ElevenLabs
   exposes no AAC/M4A output format, `m4a` requests are **normalized to MP3**
   (`mp3_44100_128`) and the emitted format is reported truthfully; the
   misleading `Accept: audio/mp4` header is gone.
4. The narration generation service now persists the **actual** provider output
   format (and records it on the attempt) so the stored narration metadata,
   linked asset extension, and asset MIME all agree.

No sound-effect work, no mixing/limiter change, no new dependency, no paid
provider call, and no commit/push were performed.

## 2. Changed files

| File | Change |
| --- | --- |
| `lib/ai/audio/silent-wav.ts` (new) | Shared deterministic `buildSilentWav(durationMs)` + `silentWavDurationSeconds(buffer)` (moved out of the music mock for reuse). |
| `lib/ai/music/fake-provider.ts` | Imports the shared helper, re-exports `buildSilentWav` for backward compatibility, and computes duration via `silentWavDurationSeconds`. Behavior unchanged. |
| `lib/ai/text-to-speech/provider.ts` | Added optional `maxDurationSeconds?: number` hint to `TextToSpeechRequest`. |
| `lib/ai/text-to-speech/fake-provider.ts` | Emits a real silent WAV (text-derived duration capped by `maxDurationSeconds`); reports `format: 'wav'`, `mimeType: 'audio/wav'`, positive probed duration. |
| `lib/ai/text-to-speech/elevenlabs-provider.ts` | New `resolveOutputFormat()`; `m4a` → MP3 with `Accept: audio/mpeg`; returns the actual emitted `format`; records `outputFormat` and `requestedFormat` in metadata. |
| `lib/generation/narration-service.ts` | Passes `maxDurationSeconds: scene.duration`; persists `synthesized.format` (actual) as `narration.format`, the attempt `format`, and the result `format`. |
| `tests/fake-text-to-speech-provider.test.ts` (new) | Fake TTS decodability/format/duration/validation tests. |
| `tests/narration-fake-provider.integration.test.ts` (new) | End-to-end narration with the real store + media store + fake provider. |
| `tests/elevenlabs-provider.test.ts` | Added the `m4a` normalization contract test. |

The P21.1 changes (`lib/render/render-artifacts.ts`,
`lib/render/scene-render-service.ts`, `lib/storage/project-store.ts`,
`tests/scene-render-concurrency.test.ts`) remain in the working tree from the
prior phase and were not touched here.

## 3. Behavior change detail

### 3.1 Fake TTS (default/mock path) — Verified by test + Verified (local)

Before: 44-byte base64 WAV, 0 frames, `duration: 0.25` hardcoded, MIME echoed
from the request. ffprobe reported `wav/pcm_u8/8000/duration=N/A` and
music-metadata reported `duration: undefined`.

After: `buildSilentWav()` output. Example, requesting `format: 'mp3'` with a
13-word text and `maxDurationSeconds: 8`:

```
{"providerFormat":"wav","providerMime":"audio/wav","providerDuration":5.2,"probedDuration":5.2,"bytes":83244}
```

```
ffprobe: codec_name=pcm_s16le sample_rate=8000 channels=1 format_name=wav duration=5.200000
```

Duration is deterministic: `words / 2.5`, capped at the scene duration passed by
the narration service. In mock mode a requested `mp3`/`m4a` still yields a WAV,
but now reported honestly as `wav` / `audio/wav` end to end.

### 3.2 ElevenLabs `m4a` — Code-inspected + Verified by test

`resolveOutputFormat('m4a')` → `{ outputFormat: 'mp3_44100_128', mimeType:
'audio/mpeg', format: 'mp3' }`. The request body carries
`output_format: 'mp3_44100_128'`, `Accept: audio/mpeg`, and the result reports
`format: 'mp3'` / `mimeType: 'audio/mpeg'`. A test asserts the request body,
the `Accept` header, and the result metadata. MP3 behavior is unchanged; `wav`
still maps to `pcm_44100`.

### 3.3 Narration service reconciliation

`narration.format`, the attempt `format`, and the returned `format` now use
`synthesized.format` (the actual emitted format). This keeps
`narration.format` consistent with the asset extension (derived from
`mimeType` in `media-store.ts`) and with `narration-freshness` comparisons.
Validation and the stored duration already both derive from the same bytes
(provider probe and media-store probe), so they agree.

## 4. Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — no warnings or errors.
- `npm run build` — exit 0.
- Targeted: `fake-text-to-speech-provider`, `elevenlabs-provider`,
  `music-provider-registry`, `music-elevenlabs-provider`, `narration-service`,
  `text-to-speech-provider-registry`, `narration-fake-provider.integration` —
  **7 files / 28 tests pass**.
- Audio + composition: `audio-mix`, `music-mix`, `music-normalization`,
  `video-compositor-args`, `video-composition-plan`, `music-service`,
  `background-music-panel`, `music-client`, `music-form`,
  `narration-freshness`, `video-composition-service.integration` —
  **11 files / 82 tests pass**.
- Full suite: **65 files / 382 tests pass** (was 63/375 before this phase).
- Local FFmpeg/ffprobe: fake TTS bytes probe as a valid PCM WAV with a real,
  positive duration (see §3.1).

## 5. Decisions

- **Reuse, not duplicate:** `buildSilentWav` was extracted to
  `lib/ai/audio/silent-wav.ts` and re-exported from the music mock, avoiding a
  text-to-speech → music module dependency while keeping existing imports and
  tests working.
- **Fake emits WAV truthfully** rather than faking MP3/M4A bytes (no encoder
  dependency is allowed). The default mock path is WAV.
- **ElevenLabs `m4a` normalized to MP3** rather than rejected: it preserves the
  user-facing `m4a` option (returns valid, playable audio) while making the
  recorded format/MIME/extension truthful. Rejecting would regress the option.
- **Duration hint:** added optional `maxDurationSeconds` so the mock can produce
  scene-fitting, plausible durations without exceeding the narration length
  guard. Real providers ignore it.

## 6. Residual risks and deferred items

- **ElevenLabs `wav` (`pcm_44100`) not verified.** ElevenLabs `pcm_*` output is
  documented as headerless PCM; if so, `wav` requests are also mislabeled
  (headerless PCM reported as `audio/wav` / `.wav`). P22 did not confirm this and
  no paid call was made, so it was left unchanged. Follow-up: verify against the
  real API and either wrap PCM in a WAV header or report the true container.
- **`narration-service` validation uses the provider-reported duration.** For
  providers that return no duration, the guard is skipped; the stored
  `asset.duration` still comes from the media-store probe. Unchanged from P22.
- **Regeneration still accumulates assets on disk** (P22 §4.4). Not in P23 scope;
  the integration test creates and cleans up its own project directory.
- **No listening/perceptual audio test** was performed, and none is claimed.

## 7. Scope confirmation

Changes are limited to the TTS providers, the shared WAV fixture helper, and the
narration service persistence of the actual format. No sound effects, no mixing
redesign, no limiter, no scene-timing policy change, no new dependency, no paid
provider call, and no commits/pushes.
