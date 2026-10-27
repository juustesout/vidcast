# P30 — Opt-in Real Narration Pilot: Implementation Report

Scope: implement the minimal missing pieces needed to run **one real ElevenLabs
narration** through the full manual narration chain (request → ElevenLabs API →
validated audio asset → scene/project storage → FFmpeg scene render → final
composition → MP4 verification), behind a default-off, fail-closed opt-in. The
existing narration architecture is reused; **no second audio pipeline** was
added.

The one authorized paid smoke run failed once on an ElevenLabs **quota** rejection
(no audio, no retry). After the account credit limit was raised, a **second
authorized run succeeded end-to-end**. See §7 for the PASS/FAIL matrix and §8 for
the raw evidence. No commit or push was made.

---

## 1. Files changed / added

| File | Kind | Purpose |
| --- | --- | --- |
| `lib/ai/text-to-speech/elevenlabs-provider.ts` | modified | Bounded configurable timeout, transport error classification, truthful MP3 normalization, no auto-retry |
| `lib/ai/audio/audio-integrity.ts` | **new** | Container sniffing + decodability/duration validation for generated audio (pure, testable) |
| `lib/ai/text-to-speech/real-narration-pilot.ts` | **new** | Default-off, fail-closed narration pilot gate (pure, testable) |
| `lib/production/run-policy.ts` | modified | Narrow `narrationPilot` option on `resolveManualGenerationProvider` (narration-only widening; policy rules otherwise untouched) |
| `lib/generation/narration-service.ts` | modified | Consults the pilot gate, validates generated audio before asset registration, uses validated format/duration |
| `scripts/real-narration-pilot.ts` | **new** | Fail-closed smoke runner (narration → render → compose → audio probe), not part of tests |
| `.env.example` | modified | Documents the narration pilot gate + optional overrides |
| `tests/elevenlabs-provider.test.ts` | modified | Timeout, abort, error classification, MP3 normalization, single-request tests |
| `tests/audio-integrity.test.ts` | **new** | Container/decodability/format-mismatch unit tests |
| `tests/real-narration-pilot.test.ts` | **new** | Gate unit tests + real-store/service integration (narration → audio asset → scene MP4, timeout, corrupt output) |
| `tests/narration-service.test.ts` | modified | Mock provider now returns real decodable WAV so it exercises the new integrity gate |
| `p30-real-narration-pilot-implementation.md` | **new** | This report |

No changes to `resolveRunPolicy`, `assertRunPolicyPreflight`,
`assertRealProviderCredentials`, the run executor, the compositor, or the audio
mixer. No env var is set or written by the code.

---

## 2. What each change does

### 2.1 Bounded timeout — `elevenlabs-provider.ts`

- New `DEFAULT_TIMEOUT_MS = 120_000` and `ELEVENLABS_TTS_TIMEOUT_MS` override
  (`elevenlabs-provider.ts:4`, `:110`). An explicit `timeoutMs` constructor
  option always wins.
- `createRequestSignal` (`:69`) combines the caller's `AbortSignal` with a hard
  deadline, `unref()`s the timer, and is always cleaned up in a `finally` — for
  both the request and the body read.
- **No automatic retry.** Exactly one `fetch` is issued per call.

### 2.2 Error classification — `elevenlabs-provider.ts`

`classifyHttpError` (`:46`) and `mapTransportError` (`:59`):

| Situation | status | code |
| --- | --- | --- |
| timeout / abort | 504 | `PROVIDER_FAILED` |
| network / unreachable | 502 | `PROVIDER_FAILED` |
| 401 / 403 | 502 | `PROVIDER_AUTH` |
| 429 | 429 | `PROVIDER_RATE_LIMIT` |
| other 4xx | 422 | `PROVIDER_REJECTED` |
| 5xx | 502 | `PROVIDER_FAILED` |

The API key is only ever sent in the `xi-api-key` header and is never logged or
embedded in an error. The narration service maps these to its own typed
`SceneNarrationGenerationError` codes (auth/unsupported/notConfigured/failed).

### 2.3 Truthful format normalization — `elevenlabs-provider.ts`

`resolveOutputFormat` (`:23`) now always requests `mp3_44100_128` /
`audio/mpeg`. ElevenLabs has **no WAV-container and no AAC/M4A output format**
(`pcm_*` is headerless PCM), so requesting `wav` or `m4a` previously produced
bytes that did not match the reported container. Mirroring the existing P23
`m4a → mp3` behavior, every request now emits a genuinely supported MP3 and the
result reports `format: 'mp3'` truthfully (`metadata.requestedFormat` still
records what the caller asked for). This is what the real pilot uses.

### 2.4 Audio integrity validation — `audio-integrity.ts`

`sniffAudioFormat` (`:39`) detects containers by **magic bytes**, independent of
the transport `Content-Type` (which a proxy can get wrong). `validateGeneratedAudio`
(`:68`) then:

1. rejects empty bodies (`empty`);
2. rejects unrecognized/corrupt containers (`unknown`);
3. restricts to the narration-supported formats (`wav`/`mp3`/`m4a`), rejecting
   anything else (`unknown`);
4. rejects a container that does not match the adapter's reported format
   (`formatMismatch`);
5. decodes with the existing `mediaMetadataReader` and requires a **positive
   finite duration** (`undecodable`).

It returns the detected `format`, canonical `mimeType`, `duration` and
`filesize`, which the service uses for the asset, `narration.format` and
`narration.duration`.

### 2.5 Integrity gate in the service — `narration-service.ts`

After the provider call, and **before** any asset is written
(`narration-service.ts:284`):

- `validateGeneratedAudio` runs on the raw provider bytes; a failure records a
  `failed` attempt (preserving the previous asset) and throws
  `narration.provider.failed` (502). No asset is ever persisted for invalid
  audio.
- `outputFormat` is taken from the validated `integrity.format` (`:317`), and the
  scene-fit check uses the validated `integrity.duration` (`:319-320`) so
  `narration.format`/`narration.duration`, the persisted asset metadata and the
  scene data all agree.
- The asset is written with `integrity.mimeType` (`:349+`), so the media store
  derives the correct extension (`.mp3`/`.wav`/`.m4a`) directly from the bytes.

### 2.6 Narration-only policy widening — `run-policy.ts` + service

`resolveManualGenerationProvider` gains a `narrationPilot?: boolean` option
(`run-policy.ts:421-424`). When true **and** the global
`PRODUCTION_RUN_ALLOW_REAL_PROVIDERS` is off **and** no explicit `mode` was
supplied **and** the caller did not explicitly request `fake`, a manual
*narration* call resolves to the real `elevenlabs` provider
(`:429-457`). It still calls `resolveRunPolicy` and
`assertRealProviderCredentials`, so a missing `ELEVENLABS_API_KEY` still fails
with the normal typed error. Image/video/music paths are unaffected. The
`imagePilot` option from P29 is preserved unchanged and the two are mutually
exclusive by modality.

The service wires the gate in at `narration-service.ts:132-133`.

### 2.7 Fail-closed gate — `real-narration-pilot.ts`

Pure function `resolveRealNarrationPilotGate(env)` returns
`{ enabled, confirmed, hasApiKey, allowed, reason }`. `allowed` is true only
when **all** hold (default: false):

- `RUN_REAL_NARRATION_PILOT` is truthy (`1`/`true`/`yes`/`on`);
- `CONFIRM_REAL_NARRATION_PILOT` equals **exactly** `YES`;
- `ELEVENLABS_API_KEY` is present (existence only; the value is never read).

### 2.8 Smoke runner — `scripts/real-narration-pilot.ts`

Fail-closed, single-request end-to-end runner. It:

1. refuses to run (exit 1, no provider contact) unless the gate is fully
   satisfied;
2. preflights `ffmpeg`/`ffprobe` availability, the project and the scene (which
   must already have narration text) — **no paid request**;
3. calls the existing `generateSceneNarration(..., { regenerate: true })` exactly
   once, wrapping `fetch` to count `/text-to-speech/` calls and failing unless the
   count is exactly 1 (no retry path exists);
4. renders the scene with `sceneRenderService.renderScene`;
5. composes the project with `videoCompositionService.composeProject`;
6. probes the composed MP4 audio with `ffprobe`
   (stream codec/duration) and `ffmpeg -af volumedetect`, failing if there is no
   audio stream, no positive duration, or `max_volume <= -60 dB` (i.e. digital
   silence).

---

## 3. Configuration and exact smoke procedure

Environment variables (values shown are the required literals; never commit real
keys):

| Variable | Required for pilot | Default | Meaning |
| --- | --- | --- | --- |
| `RUN_REAL_NARRATION_PILOT` | yes | unset (off) | Master switch for the pilot |
| `CONFIRM_REAL_NARRATION_PILOT` | yes (must be `YES`) | unset | Second, exact confirmation |
| `ELEVENLABS_API_KEY` | yes | unset | ElevenLabs credential (existence only) |
| `ELEVENLABS_TTS_TIMEOUT_MS` | no | `120000` | Per-request deadline |
| `ELEVENLABS_TTS_MODEL` | no | `eleven_multilingual_v2` | Model id |
| `TTS_DEFAULT_FORMAT` | no | `mp3` | Requested format (normalized to MP3) |
| `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS` | **no** | unset | Not required; do not enable for the pilot |

Smoke procedure (run manually; **not executed in this task**). The scene must
already contain narration text (or supply one with `--text`). A valid ElevenLabs
voice id is required (`--voice`), because ElevenLabs has no usable default voice
id and the sample scenes store a placeholder `voiceId="default"`:

```bash
# Fail-closed gates. Do NOT set PRODUCTION_RUN_ALLOW_REAL_PROVIDERS
# and keep the image pilot off; the script also refuses if either is active.
export RUN_REAL_NARRATION_PILOT=true
export CONFIRM_REAL_NARRATION_PILOT=YES
export ELEVENLABS_API_KEY=<your throwaway key>

# Optional: lower the deadline for a quicker negative test.
# export ELEVENLABS_TTS_TIMEOUT_MS=120000

# One project with a renderable scene (use its real ids).
npx tsx scripts/real-narration-pilot.ts <projectId> <sceneId> \
  --voice <validElevenLabsVoiceId> \
  --text "<narration line>"
```

The script refuses to run (exit 1, no provider contact) unless the gate is fully
satisfied, and refuses if ffmpeg/ffprobe are missing, the scene has no narration
text, `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS` is on, or the image pilot is active.
It counts calls to `/text-to-speech/` and fails unless the count is exactly 1,
then renders, composes and verifies audible audio. Revoke the throwaway key
afterwards.

If the ambient platform already exposes `ELEVENLABS_API_KEY` and you want to be
certain only the throwaway key from `.env` is used, run with the variable unset
in the shell so `--env-file=.env` supplies it:

```bash
env -u ELEVENLABS_API_KEY npx tsx --env-file=.env scripts/real-narration-pilot.ts <projectId> <sceneId>
```

---

## 4. Tests and results

Added/updated tests (all with mocked/local HTTP; **no paid call**):

- `tests/elevenlabs-provider.test.ts`: normalizes response; `m4a`/`wav` both
  normalize to MP3 and report the emitted format; missing key; HTTP 400 → 422
  `PROVIDER_REJECTED`, 401/403 → `PROVIDER_AUTH`, 429 → `PROVIDER_RATE_LIMIT`,
  500 → `PROVIDER_FAILED` (each asserting exactly one `fetch`); transport
  failure; bounded timeout abort; caller abort propagation.
- `tests/audio-integrity.test.ts`: magic-byte sniffing for WAV/MP3/M4A/OGG/FLAC
  and unrecognized; accepts decodable WAV; rejects empty (`empty`),
  corrupt/unsupported (`unknown`), format mismatch (`formatMismatch`) and
  truncated/undecodable WAV (`undecodable`).
- `tests/real-narration-pilot.test.ts`: gate defaults off; `CONFIRM` must equal
  exactly `YES`; key required; falsey enable ignored; pilot-disabled uses the fake
  provider with zero network calls; pilot-enabled issues exactly one request and
  persists `audio/mpeg` `.mp3` audio linked to the scene; the persisted narration
  renders to a scene MP4 via the real renderer; a stalled paid call records a
  `failed` attempt and issues no second request; corrupt provider audio is
  rejected without persisting any audio asset.

Verification performed on the working tree:

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | clean |
| Lint | `npm run lint` (`next lint`) | no warnings/errors |
| Targeted narration tests | `npx vitest run` (7 files) | 43 tests passed |
| Full test suite | `npx vitest run` | **70 files / 433 tests passed** |
| Production build | `npm run build` | succeeded |

(The suite grew from 68 files / 406 tests to 70 files / 433 tests: +2 files and
+27 tests. The two new test files plus the extended ElevenLabs and updated
narration-service suites account for the increase.)

---

## 5. Fail-closed, single-request and no-auto-retry proof

- Gate default is off: `resolveRealNarrationPilotGate({})` → `allowed: false`
  (unit-tested). Missing key, wrong confirm value, or falsey enable keep it off.
- The expensive path cannot run without the gate: `resolveNarrationProvider` only
  passes `narrationPilot: gate.allowed`; when off, the existing mock default
  (`fake`) is used and no HTTP is attempted (unit-tested).
- No automatic retry exists in the adapter; every code path issues a single
  `fetch`. The timeout path was unit-tested to issue exactly one request, and the
  smoke script additionally asserts the observed `/text-to-speech/` count is
  exactly 1.
- After an uncertain timeout there is **no** second paid request: the attempt is
  recorded `failed`, the previous asset is preserved, and the gate is not
  re-entered automatically (unit-tested).
- Failed/invalid provider output (empty, corrupt, wrong container) throws a typed
  error and the attempt is marked `failed`; no asset is written.
- No policy is bypassed: `resolveRunPolicy` and credential assertions are still
  invoked; only the blanket flag is narrowed, and only for the narration
  modality.
- No client input can enable the pilot: the generate-narration route forwards only
  `text/voiceId/model/format/provider/settings`; the pilot is driven purely by
  server env.

---

## 6. Blockers / caveats

- The authorized paid narration run succeeded end-to-end on the second attempt
  (after the account credit limit was raised); the first attempt failed on a
  quota rejection (no retry). Live evidence is in §8. Everything else remains
  proven by the local/integration tests.
- Format normalization: `wav` and `m4a` requests are served as MP3 (there is no
  ElevenLabs WAV/M4A container output). The pilot therefore produces an `.mp3`
  asset. This is truthful and validated, but a caller who specifically needs a
  WAV would need a PCM→WAV wrapper (out of scope, would require a paid run to
  verify channel/sample assumptions).
- The pilot is **env-scoped, not request-scoped**: while
  `RUN_REAL_NARRATION_PILOT=true` + `CONFIRM_REAL_NARRATION_PILOT=YES` +
  `ELEVENLABS_API_KEY` are present (e.g. via a local `next dev` `.env`), every
  manual narration generation for any project resolves to real ElevenLabs (bounded
  per-request by the existing `generate_narration` throttle). Remove/disable the
  env vars immediately after the pilot.
- Only the manual narration path is piloted. Full production runs in real mode
  (global flag + all four providers) remain out of scope and still include the
  unverified OpenAI video adapter; image/video/music stay in mock mode for P30.
- The scene-fit rule ("narration must not exceed scene duration") is unchanged;
  no timing rule was modified because no provable bug was found.

---

## 7. Implementation proof vs. real-run proof

| Acceptance item | Status now |
| --- | --- |
| Single real ElevenLabs request, no retries/batch | **PASS** — exactly one `/text-to-speech/` request; zero retries (§8) |
| Validated audio asset (real container, positive duration) persisted | **PASS (live)** — `audio/mpeg` `.mp3`, mp3/44100/mono, `2.586122 s`, 41 839 B (§8.3) |
| `narration.format` / `narration.duration` / asset metadata / scene data agree | **PASS (live)** — all report `mp3` / `2.586122 s`; asset links to the scene (§8.3) |
| Scene asset consumed by `sceneRenderService` → MP4 | **PASS (live)** — scene render `completed` (h264 5.000 s) (§8.3) |
| `videoCompositionService.composeProject` → MP4 with video+audio | **PASS (live)** — h264 1920×1080 + aac, 5.035 s, 1 305 544 B (§8.3) |
| Narration actually audible (non-silent audio in final MP4) | **PASS (live, measured)** — decode exit 0; 0–2.5 s max −5.9 dB / mean −20 dB; 3–5 s −91 dB (§8.3) |
| Typed provider error, no secret leakage, no double paid call | **PASS** — quota rejection surfaced as a typed error; key never logged; no retry |
| Actual live ElevenLabs success | **PASS** — second run completed the full chain (§8) |

---

## 8. Live pilot runs (1st: quota reject · 2nd: PASS)

Two paid runs were performed, each explicitly authorized. No retry was made after
the first failure; the second run was a separate, newly authorized attempt after
the account credit limit was raised. The ElevenLabs key value is never printed.
Only the narration pilot was active in both runs.

Command used (shell env overrides `--env-file`, so image pilot and global
real-provider mode are forced off; the script also refuses if either is on):

```bash
RUN_REAL_NARRATION_PILOT=true \
CONFIRM_REAL_NARRATION_PILOT=YES \
RUN_REAL_IMAGE_PILOT=false \
CONFIRM_REAL_IMAGE_PILOT=false \
PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=false \
npx tsx --env-file=.env scripts/real-narration-pilot.ts \
  project_afca8256-f75c-4f75-9779-26ae34f7b209 \
  scene_3e154ea3-cda3-4beb-a8de-a9f3c02fea9a \
  --voice EXAVITQu4vr4xnSDxMaL \
  --text "P30 real ElevenLabs narration pilot."
```

A free, read-only preflight (`GET /v1/voices`, HTTP 200, 21 premade voices) was
used to select a valid voice id — no audio generation and no billing. A
fail-closed negative test (gate off) exited 1 before any network call.

### 8.1 First attempt — FAIL (quota)

`exit=1`:

```
[real-narration-pilot] Synthesizing one real narration for <project>/<scene> ...
[real-narration-pilot] Unexpected failure: This request exceeds your API key
(MonkeyTestVideo) quota of 10. You have 10 credits remaining, while 14 credits are
required for this request.
```

The provider rejected the request **before** generating audio (definitive 4xx, not
a timeout/uncertain response). One request attempted, zero retries. No asset
written (`assets` unchanged at 1); scene narration `failed`; previous asset
preserved.

### 8.2 Second attempt (after credit limit raised) — PASS

`exit=0`:

```
[real-narration-pilot] Synthesizing one real narration for <project>/<scene> ...
[real-narration-pilot] Audio asset written: asset_ad882cf4-0a0f-45fb-9aa6-add3790e7850 (provider=elevenlabs, format=mp3, duration=2.5861224489795918s).
[real-narration-pilot] Rendering scene ...
[real-narration-pilot] Scene render: renders/scene_3e154ea3-cda3-4beb-a8de-a9f3c02fea9a-render-render_17334348-2c0a-4f66-a5ff-718736698551.mp4 (completed).
[real-narration-pilot] Composing final video ...
[real-narration-pilot] Final composition: renders/compositions/final-composition_4792b26f-1e5c-4bdf-a1ae-6ece227811fa.mp4.
[real-narration-pilot] Composed audio: codec=aac, duration=5.035s, max_volume=-5.9 dB, mean_volume=-23 dB.
[real-narration-pilot] PASS
```

Recorded facts:

| Fact | Value |
| --- | --- |
| Paid requests | **1** (`/text-to-speech/`), asserted == 1; zero retries |
| Active provider | `elevenlabs` (image/video/music untouched; image pilot off) |
| Model / voice | `eleven_multilingual_v2` / `EXAVITQu4vr4xnSDxMaL` (Sarah, premade) |
| Audio asset | `asset_ad882cf4-0a0f-45fb-9aa6-add3790e7850` |
| Asset path | `projects/project_afca8256-…/assets/scene-01-narration-generation_attempt_ce1e63a2-367a-4981-a7dc-4ff9b953a7cc.mp3` |
| Asset container / MIME | MP3 (`mp3`, 44100 Hz, mono), `audio/mpeg`, `.mp3` |
| Asset duration / size | `2.586122 s` / `41 839 B` |
| Provider request id | recorded in asset metadata (`UdqnslplZsBHgex2eMLJ`) |
| Scene duration | `5.0 s` (narration `2.586 s` fits) |
| Scene render | `completed` → `renders/scene_3e154ea3-…-render_17334348-….mp4` |
| Final composition | `renders/compositions/final-composition_4792b26f-….mp4`, `5.035 s`, `1 305 544 B` |

### 8.3 Independent verification (ffprobe + full FFmpeg decode)

`ffprobe` (source asset):

```
audio: mp3, 44100 Hz, mono, duration 2.586122; format mp3; size 41839
```

`ffprobe` (final composition):

```
video: h264, 1920x1080, duration 5.033333
audio: aac, 48000 Hz, stereo, duration 5.034667
format: mov,mp4,m4a,3gp,3g2,mj2, duration 5.035000, size 1305544
```

Full decode (`ffmpeg -v error -i final.mp4 -f null -`): **exit 0** (video and
audio decode with no errors).

Audibility — measured with `volumedetect` (a human listening check was not
possible; see §8.5):

| Source | mean_volume | max_volume |
| --- | --- | --- |
| Narration asset (mp3) | −17.0 dB | −2.9 dB |
| Final composition (whole) | −23.0 dB | −5.9 dB |
| Final composition `[0.0–2.5 s]` (narration region) | −20.0 dB | −5.9 dB |
| Final composition `[3.0–5.0 s]` (after narration ends) | −91.0 dB | −91.0 dB |

The composition's first ~2.586 s carry real speech-level audio and then drop to
digital silence, exactly matching the narration length — the narration is
genuinely present and audible, not merely an empty audio stream.

Consistency: `narration.format = "mp3"` = asset `mimeType "audio/mpeg"`; the
asset duration `2.586122 s` equals `narration.duration` and the attempt duration;
the scene `narration.audioAssetId` points at the new asset; `providerRequestId`
is persisted in the asset metadata.

### 8.4 Acceptance criteria (PASS/FAIL)

| # | Criterion | Result |
| --- | --- | --- |
| 1 | Preflight read, gates clear, cost bounded to one request | **PASS** |
| 2 | Only the narration pilot active (image/video/music mock) | **PASS** |
| 3 | Smoke executed with the temporary key, key never shown | **PASS** |
| 4 | One real ElevenLabs request | **PASS** (asserted == 1) |
| 5 | Valid audio (real codec/container/duration) | **PASS** (mp3/44100/mono, 2.586 s) |
| 6 | Saved narration asset | **PASS** (41 839 B `.mp3`, linked to scene) |
| 7 | Successful scene render | **PASS** (`completed`, h264 5.000 s) |
| 8 | Successful final composition | **PASS** (h264 + aac, 5.035 s) |
| 9 | MP4 verified with `ffprobe` + full FFmpeg decode | **PASS** (decode exit 0) |
| 10 | Narration track audibly non-silent | **PASS** (measured; subjective listen unavailable, §8.5) |
| 11 | On failure: stop, no retry, no second payment | **PASS** (first run stopped after 1 attempt) |
| 12 | Evidence recorded, no secrets in report/logs | **PASS** |

Overall: **PASS** — one real ElevenLabs request flows through narration service →
validated MP3 asset → scene storage → FFmpeg scene render → final MP4, and the
composed MP4 contains audible narration.

### 8.5 Listening check

The test environment has no audio output/playback, so a human listening check was
**not performed**. Substitute evidence: ffprobe stream properties + FFmpeg
`volumedetect` loudness (non-silent at the narration region, silent afterward) +
a successful full decode. The remaining unverified item is purely subjective audio
fidelity.

### 8.6 Cleanup performed

- Narration pilot flags were passed inline on the command line only and were never
  persisted; the active shell environment is clean.
- `.env` still carried the earlier **P29 image-pilot** flags
  (`RUN_REAL_IMAGE_PILOT=true`, `CONFIRM_REAL_IMAGE_PILOT=YES`); these were
  neutralized in place to `RUN_REAL_IMAGE_PILOT=false` /
  `CONFIRM_REAL_IMAGE_PILOT=NO` without reading or printing any key value.
  `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS` is unset (off).
- `ELEVENLABS_API_KEY` remains platform-provisioned and was **not** revoked (I
  cannot revoke it): revoke/rotate the `MonkeyTestVideo` key when done.
- Scratch files under `/tmp/opencode` (`p30-smoke.log`, `p30-smoke-2.log`, a
  throwaway env-file test) contain no secrets and were left in place (deletion
  requires your explicit confirmation).

