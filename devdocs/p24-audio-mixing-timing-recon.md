# P24 — Audio mixing and timing recon

Recon only. No application code, tests, schema, dependencies, or configuration
were changed. No paid provider calls, no real provider generation, no commits.

Evidence labels used below:

- **Verified (local)** — reproduced with the real compositor and local FFmpeg on
  synthetic fixtures.
- **Code-inspected** — read directly from the current source.
- **Potential risk** — inferred, not reproduced.
- **Unverified** — not confirmed either way.

---

## 1. Executive summary

The composition audio pipeline is a three-stage FFmpeg chain: per-segment
normalize (one audio track each, narration replaces embedded audio), concat
demuxer over the normalized MP4s, then an optional music mix that adds a limiter.
The chain is deterministic and encodes AAC 48 kHz mono-or-stereo depending on
input. It works for the common case, but three verified issues matter:

1. **Clipping without music.** `alimiter` is applied **only** in the music mix
   (`video-compositor.ts:175`). With no background music there is no limiter and
   no peak ceiling, while `narrationVolume` is allowed up to `4.0`
   (`audio-mix.ts:4-5`). A near-full-scale narration at volume 4 measured a
   **0.0 dBFS peak (digital clipping)** on the real pipeline (s2). The same path
   also passes embedded scene audio through at unity with no limiter (s5).
2. **Channel layout is not normalized across scenes.** The normalize stage forces
   `aresample=48000` but never forces a channel layout (`video-compositor.ts:77-84`).
   Concatenating a **mono** narration scene with a **stereo** embedded-audio scene
   produced a **mono** final: the concat demuxer coerces every segment to the
   first segment's layout, and the stereo→mono downmix **clipped at 0.0 dBFS**
   (s6, manual concat tests). Reversing the order yields stereo. So which scenes
   are mono/stereo changes the result, and mixed layouts can clip.
3. **Duration authority conflict.** Narration length is validated against
   `scene.duration` (`narration-service.ts:278`, `video-composition-service.ts:121`)
   but segmentation/trimming uses `render.duration`
   (`video-composition-service.ts:185`, `video-compositor.ts:269`). When
   `render.duration < scene.duration` (renders are validated within ~0.25 s),
   an accepted narration is silently trimmed (s7). Reported by P22 §4.6 as
   theory; now **verified (local)**.

Additionally, the music mix's final `-t <total>` trims AAC to exactly
`totalDuration` while the copied video stream can keep an extra frame or two, so
music compositions can end with a small (~1 frame) A/V tail mismatch (minor,
verified).

Adjacent issues (SFX, stale assets, ElevenLabs PCM labeling) are recorded in
§7 but not expanded, as they do not change the audited mix/timing behavior.

---

## 2. Actual audio filter graph and execution flow

Entry point: `VideoCompositionService.composeProject`
(`video-composition-service.ts:280`).

### 2.1 Plan construction (`resolveCompositionPlan`, `video-composition-service.ts:160`)

- Scenes sorted by `order`; each contributes a `CompositionItem` with
  `duration: render.duration` (the **probed** rendered duration, `:185`) and an
  optional `narrationAudioPath` (`:178-191`).
- Narration is accepted only if the linked asset exists, is audio, and
  `asset.duration <= scene.duration + 0.01` (`:105-130`, guard at `:121`).
- `totalDuration = Σ item.duration` (`:202`).
- Music is resolved defensively; a missing/invalid track degrades to no music
  (`:135-158`).
- `audio` is normalized via `normalizeAudioMix` (`audio-mix.ts:25-31`,
  clamp `[0,4]`, defaults `1 / 0.35 / 0.2` from `constants.ts:45-49`).

### 2.2 Per-segment normalize (`buildNormalizeArgs`, `video-compositor.ts:52-112`)

One audio track per segment, selected in this order (`:66-75`):

- narration present → `-i <narration>`, track `1:a`, and a narration volume filter;
- else input render has audio → track `0:a` (embedded, **no** volume filter);
- else → `-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000`, track `1:a`.

Audio filter chain (`:77-84`): `atrim=0:<D>,apad=pad_dur=<D>,aresample=48000`
plus `volume=<narrationVolume>` only in the narration branch. Video is
re-encoded (`scale,crop,fps,format=yuv420p`) and `-t <D>` caps the output. Output
is `aac 192k`.

Exact graph, narration case:

```
ffmpeg -y -i <render> -i <narration> \
  -vf scale=W:H:force_original_aspect_ratio=increase,crop=W:H,fps=F,format=yuv420p \
  -filter_complex "[1:a]atrim=0:D,apad=pad_dur=D,aresample=48000,volume=NV[aout]" \
  -map 0:v:0 -map "[aout]" -t D -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart <norm>
```

Embedded-audio case uses `[0:a]...`; silence case uses the `anullsrc` input
`[1:a]`. Note `apad=pad_dur=D` pads **D seconds** (not "pad to D"); the trailing
`-t D` masks it, so the result is D, but the intent is fragile (**Code-inspected**).

### 2.3 Concatenation (`buildComposeArgs`, `video-compositor.ts:114-135`)

`-f concat -safe 0 -i list -c:v libx264 -c:a aac -pix_fmt yuv420p -r <fps>`.
Both streams are **re-encoded** (not stream-copied).

### 2.4 Optional music mix (`buildMusicMixArgs`, `video-compositor.ts:155-204`)

Only when a music asset is selected. Input 1 is looped (`-stream_loop -1`):

```
[1:a]volume=MV,atrim=0:T,afade=t=in:st=0:d=<fi>,afade=t=out:st=<fo>:d=<fo>D[music];
[0:a][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]
-map 0:v:0 -map "[aout]" -t T -c:v copy -c:a aac -b:a 192k -movflags +faststart
```

Fades are fixed 1 s in / 2 s out (`music-mix.ts:13-14,59-64`). `-c:v copy` keeps
the concatenated video.

### 2.5 Validation (`validateOutput`, `video-compositor.ts:221-252`)

Requires an audio stream, dimensions match, MP4 container, and
`|duration - totalDuration| <= max(0.35, 1/fps)`. It does **not** inspect audio
level, channel layout, sample rate, codec, or stream count beyond `>0`.

### 2.6 Where audio is attached

- Scene render (stills/graphics/text/blank): video only, **no audio** — audio is
  attached at composition. Video scenes keep embedded audio
  (`renderer.ts:188-224`, `:210-217`).
- Composition attaches exactly one audio track per segment, then mixes music.

---

## 3. Volume and clipping findings

Fixtures: near-full-scale 0.9-peak tones (narration 660 Hz, embedded/music
220-440 Hz), 48 kHz. Measured with `ffmpeg ... -af volumedetect -f null -`
(`max_volume` dBFS; `0.0` = full scale / clipping).

| Scenario (real compositor) | narration volume | music | final peak | channels | note |
| --- | --- | --- | --- | --- | --- |
| s1 narration only | 1 | no | -0.4 dBFS | 2 | source 0.9, no limiter, safe |
| s2 narration only | 4 | no | **0.0 dBFS** | 2 | **clips** (0.9×4 = 3.6) |
| s3 narration+music | 1 | 0.35 | -0.3 dBFS | 2 | limiter present |
| s3b narration+music | 4 | 0.35 | **0.0 dBFS** | 2 | limiter does not prevent a fast-transient overshoot |
| s5 embedded only | n/a | no | -0.5 dBFS | 2 | no volume, no limiter |
| s6 mono narration + stereo embedded | 1 | no | **0.0 dBFS** | **1** | layout coercion + downmix clip |

Findings:

- **Narration can clip at permitted settings without music.** `narrationVolume`
  is clamped to `4.0` (`audio-mix.ts:20-23`) and applied as a raw gain
  (`video-compositor.ts:83`); the limiter lives only in the music path
  (`:175`). **Verified (local).**
- **Embedded scene audio bypasses all volume/limiting** (no volume filter,
  embedded branch `video-compositor.ts:73-75`; no limiter without music). A
  near-full-scale embedded source can clip. **Verified (local: 0.9 source →
  -0.5; would reach 0.0 at ~1.0) / Potential risk.**
- **The `alimiter` is not a hard safety net.** With `limit=0.95` (-0.45 dB) the
  measured peak still reached 0.0 dBFS for a loud 660 Hz tone at volume 4
  (attack defaults ≈ 5 ms vs a 1.5 ms period, plus AAC overshoot). **Verified
  (local).**
- `amix ... normalize=0` deliberately preserves gain (no auto-attenuation), so
  the mix level is the raw sum of narration + music; only the limiter bounds it.
  **Code-inspected.**
- Peak measurements are structural, not perceptual; no loudness (LUFS) or
  listening test was done. **Limitation.**

---

## 4. Duration and synchronization findings

Authority chain (**Code-inspected**):

| Stage | Field | Source |
| --- | --- | --- |
| Narration acceptance | `scene.duration` | `narration-service.ts:278`, `video-composition-service.ts:121` |
| Segment length / trim | `render.duration` (→ `item.duration`) | `video-composition-service.ts:185`, `video-compositor.ts:269` |
| Composition length | `Σ render.duration` (`plan.totalDuration`) | `video-composition-service.ts:202` |
| Final output check | `plan.totalDuration` ± 0.35 s | `video-compositor.ts:239` |

- **Narration shorter than scene:** `atrim` keeps it, `apad=pad_dur=D` adds
  silence, `-t D` results in exactly D. Padding silence follows the narration;
  there is **no offset/delay**, so narration always starts at segment t=0
  (**Code-inspected**). s1/s7 confirm the segment length equals `item.duration`.
- **Narration equal to scene:** unaffected.
- **Narration longer than the render** (but ≤ scene): **silently trimmed** by
  `atrim=0:item.duration`. **Verified (local):** render 1.8 s + narration 2.0 s
  → output 1.835 s (narration cut at 1.8 s), peak -0.4 dBFS. This is the P22
  §4.6 theory, now reproduced through the real compositor.
- **Scene with no audio:** `anullsrc` silence (s4: -91 dBFS). Fine.
- **Music shorter than composition:** looped via `-stream_loop -1` + `atrim=0:T`
  (s8: 1 s music in a 2.4 s composition → 2.4 s output). Fine.
- **Music longer than composition:** trimmed to `T`. Fine.
- **Music absent:** no music pass; no limiter.
- **Minor A/V tail mismatch (music path):** the concat re-encode yields a video
  stream ~1 frame longer than audio (s1: video 2.0333 vs audio 2.0267). In the
  music path `-t T` trims audio to exactly `T` while `-c:v copy` keeps the extra
  video frame (s3/s3b: audio 2.000, video 2.0333). Bounded to roughly one frame
  per re-encode; within the 0.35 s validation tolerance. **Verified (local),
  minor / Potential risk.**

---

## 5. Stream mapping and encoding findings

- **Per-segment selection is correct/exclusive:** exactly one audio track per
  normal segment; narration **replaces** embedded scene audio (`video-compositor.ts:66-75`).
  With both present, embedded audio is dropped and never mixed. **Code-inspected.**
- **Sample rate** forced to 48000 at normalize and anullsrc (`:72,80`); final
  `-c:a aac -b:a 192k`. **Verified (local: all outputs 48000/aac).**
- **Channel layout not forced** → the concat demuxer takes the layout of the
  first segment and coerces the rest. Manual concat of mono+stereo (both
  exit 0): output **mono**; stereo-first: output **stereo**. No failure, silent
  coercion. **Verified (local).**
- **Music does not duplicate audio:** `amix` consumes the concat track + music;
  `-map 0:v:0 -map [aout]` yields exactly one audio stream. **Verified (local:
  audioCount = 1 in every scenario).**
- **Malformed narration input** → `ffmpeg` fails at normalize → mapped to
  `VideoCompositionError('FFMPEG_FAILED')` (s9: controlled error, not a crash).
  **Verified (local).**
- **Stream copy + `-t` in the music path** cannot trim video precisely
  (packet/keyframe boundary), contributing to the §4 tail mismatch.
  **Code-inspected + Verified (local).**
- Every scene render is a separate `-t`-capped re-encode; there is no
  cross-scene loudness or layout normalization step. **Code-inspected.**

---

## 6. Local test commands, measurements, and limitations

Isolated workspace: `/tmp/opencode/p24` (outside the repo). Nothing in the repo
was modified.

Fixtures (deterministic `lavfi`):

```
ffmpeg -y -f lavfi -i color=c=0x223344:s=1280x720:r=30 -t 2 -c:v libx264 -pix_fmt yuv420p render-nosnd.mp4
ffmpeg -y -f lavfi -i color=c=0x223344:s=1280x720:r=30 -f lavfi -i "aevalsrc=0.9*sin(2*PI*440*t)|0.9*sin(2*PI*440*t):s=48000" -t 2 -map 0:v -map 1:a -c:v libx264 -pix_fmt yuv420p -c:a aac render-withsnd.mp4
ffmpeg -y -f lavfi -i "aevalsrc=0.9*sin(2*PI*660*t):s=48000:d=1.5" -ac 1 -c:a pcm_s16le narration-mono.wav
ffmpeg -y -f lavfi -i "aevalsrc=0.9*sin(2*PI*660*t)|0.9*sin(2*PI*660*t):s=48000:d=1.5" -c:a pcm_s16le narration-stereo.wav
ffmpeg -y -f lavfi -i "aevalsrc=0.9*sin(2*PI*220*t)|0.9*sin(2*PI*220*t):s=48000:d=1.0" -c:a pcm_s16le music-1s.wav
```

Harness (`npx tsx /tmp/opencode/p24-probe.ts` from `/workspace`) imports the real
`LocalFFmpegVideoCompositor`, `buildNormalizeArgs`, and `buildComposeArgs`, and
for each `CompositionPlan` runs `compose()` then measures with:

```
ffprobe -v error -print_format json -show_streams -show_format <out>
ffmpeg -hide_banner -i <out> -map 0:a:0 -af volumedetect -f null -
```

Key measurements are in §3-§5 (s1-s9, plus mono-first/stereo-first manual
concat). Additional recorded values: `resolveMusicFade(2.4) = {in:1, out:1.4,
outStart:1}`; empty/omitted scenes rendered `-91 dBFS` silence; malformed
narration raised `FFMPEG_FAILED`.

Existing test coverage reviewed (all currently green per prior runs):
`video-compositor-args` (args strings only), `video-composition-plan` (plan
resolution), `audio-mix`, `music-mix`, `music-normalization`,
`video-composition-service.integration` (asserts file exists + artifact fields
only). **No existing test measures output peak, loudness, channel layout, or
codec of the composed file** (repo-wide search for
`volumedetect|max_volume|astats|ebur128|loudness` returns none).

Limitations: synthetic tones, not speech/music; `volumedetect` over a decoded
stream reflects encoded peaks (subject to AAC overshoot); all composed MP4s
decoded fully; **no listening/perceptual evaluation was performed and none is
claimed**. Successful decode does not prove correct synchronization or quality.

---

## 7. Prioritized confirmed defects and risks

Confirmed defects:

1. **No limiter / peak ceiling without music; narration volume up to 4 clips.**
   `audio-mix.ts:4-5`, `video-compositor.ts:83` (no ceiling) vs `:175` (limiter
   only with music). Evidence s2 (0.0 dBFS). Severity: high (default-path audio
   quality/delivery).
2. **Channel layout not normalized; concat coerces to the first segment and can
   clip on downmix.** `video-compositor.ts:77-84` (only `aresample=48000`), and
   concat at `:114-135`. Evidence s6 + manual concat order tests. Severity:
   medium-high (produces mono output / clipping depending on scene order).
3. **Narration validation vs render trimming use different duration
   authorities**, so accepted narration can be trimmed.
   `narration-service.ts:278`, `video-composition-service.ts:121` vs `:185`,
   `video-compositor.ts:269`. Evidence s7. Severity: medium.

Risks:

4. Music-path A/V tail mismatch from stream-copy + `-t` (§4). Low.
5. `alimiter` does not guarantee ≤ 0 dBFS for fast transients/AAC overshoot
   (s3b). Low-medium.
6. Embedded scene audio is ungoverned by any volume/limiter (§3). Low-medium.
7. `apad=pad_dur=D` intent is brittle though currently masked by `-t`. Low.

Adjacent items (recorded only, not part of this audit's mix behavior):
`effectsVolume` is dead / no SFX; regeneration leaves stale audio assets;
ElevenLabs WAV / headerless-PCM labeling remains unverified (P22/P23).

---

## 8. Recommended next phase

**P25 — Add a single, uniform final-audio safety/consistency pass at composition
time.** One narrowly scoped change that fixes defects 1-2 and de-risks 4-5:

1. Force a consistent channel layout for every segment (e.g. add
   `aformat=channel_layouts=stereo` or `-ac 2` in `buildNormalizeArgs`) so
   concat never coerces layout or downmix-clips.
2. Guarantee a peak ceiling on the **final** mix for all paths, not just when
   music is present — e.g. apply `alimiter`/`loudnorm` to the concat audio in
   the non-music path too (or always run a final audio pass), so permitted
   narration volumes and unlucky embedded audio cannot clip.

This is the smallest high-value step: it addresses the two verified quality
defects with a localized change in `video-compositor.ts`, is independently
testable with the synthetic fixtures here (assert peak ≤ ~-0.1 dBFS and a
consistent channel count), and does not touch timing policy. Defect 3 (duration
authority) can follow as a separate, behavior-visible change (make composition
use the same authority as validation, or surface a warning instead of trimming).

---

## 9. Working-tree confirmation

P24 added only this report. Pre-existing working-tree state was not touched:

- Pre-existing modifications: `lib/ai/music/fake-provider.ts`,
  `lib/ai/text-to-speech/{fake-provider,provider,elevenlabs-provider}.ts`,
  `lib/generation/narration-service.ts`, `lib/render/render-artifacts.ts`,
  `lib/render/scene-render-service.ts`, `lib/storage/project-store.ts`,
  `tests/elevenlabs-provider.test.ts` (P23 + P21.1).
- Pre-existing untracked: `lib/ai/audio/`, `p15/17/18/20/22/23*.md`,
  `project-baseline-recon.md`, `tests/{fake-text-to-speech-provider,
  narration-fake-provider.integration,scene-render-concurrency}.test.ts`.
- New in P24: `p24-audio-mixing-timing-recon.md` (this file).

All temporary fixtures/harness lived under `/tmp/opencode/p24` and were removed;
the repo tree is unchanged apart from this report (no commits).
