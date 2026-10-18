# P32 Recon: Audio-driven timing, timeline-first music, provider-neutral video

Status: recon only. No code changed, no paid provider calls, no dependencies added.
Scope owner: pending approval of the plan below.

## 1. Verdict

- Narration already measures real audio duration (music-metadata) and persists it, but it does
  **not** drive the timeline. Scene duration is a hand-authored value and is authoritative
  everywhere. Narration that overshoots it is a hard failure **after** the paid TTS call.
- There is no silence detection, no in/out trim of narration, and no audio-driven scene length.
  Shorter narration is padded with silence (`apad`); longer narration is rejected.
- Background music is generated immediately before composition, from an explicit run plan, with a
  default 60 s request. The compositor already loops/trims any track to the final timeline, so
  length is not a correctness problem, but the track is not derived from the actual timeline and
  there is no timeline-first placement.
- The video provider interface is already fairly neutral, but the registry is a hardcoded
  three-entry switch, capabilities are advisory (not enforced), and there is no generic
  provider/model config, price table, or budget accounting. FAL and OpenAI exist; OpenRouter and
  Veo/Gemini video do not. Stock quota accounting exists; video/music/TTS cost accounting does not.
- The production path is intentionally single-host: local filesystem assets, local FFmpeg/FFprobe,
  in-process locks and throttles. Any cloud worker would need a storage and locking story first.

## 2. Current end-to-end chain

1. Authoring: project (`durationTarget`, scenes, `scene.duration`) is validated and stored.
2. Narration (optional, paid): TTS is asked to fit `scene.duration`; returned bytes are integrity
   checked; measured duration is persisted with the audio asset. Overshoot fails the attempt.
3. Visuals: stock image/video selection, generated image, or generated video (paid). Generated
   video is downloaded during the terminal status poll and stored locally.
4. Scene render (local FFmpeg): `scene.duration` drives frame count, trim/atrim, and tpad/apad.
5. Composition (local FFmpeg): concat scene renders, optional music mix, limiter, final MP4.
6. Music (optional, paid): run plan is generated/selected immediately before `final_compose`.

## 3. Inventory and evidence

### 3.1 Narration and timing

- `lib/generation/narration-service.ts:248` sends `maxDurationSeconds: scene.duration` to TTS.
- `lib/ai/audio/audio-integrity.ts:88-107` sniffs the container, decodes metadata with
  `mediaMetadataReader`, and returns the **real** duration. No FFprobe is involved.
- `lib/generation/narration-service.ts:319-354` throws HTTP 422 (`narration.invalid`) when
  `integrity.duration > scene.duration + 0.01`. The paid call has already happened and is not
  refunded. The failed attempt records the measured duration.
- On success, duration and `audioAssetId` are persisted (`:374-390`).
- `lib/validation/project-validation.ts:294-295` and `components/project/project-workspace.tsx`
  only surface a warning if a persisted narration asset is longer than the scene.
- `lib/types/scene.ts` has no in/out points, no measured-narration field beyond
  `narration.duration`, and no timeline/segment model.
- `project.durationTarget` is stored and displayed, and reaches the explainer brief
  (`lib/projects/explainer-normalization.ts:98`), but does not constrain or derive scene
  durations. `scene.duration` is authored per scene.
- `lib/render/ffprobe.ts` exists and is used to validate rendered output, not to measure
  narration or detect silence.

### 3.2 Scene render and composition

- `lib/render/renderer.ts:184` computes `frameCount` from `scene.duration`.
- `lib/render/renderer.ts:238-266` builds `trim=duration=scene.duration`,
  `tpad=stop_mode=clone` for short video sources, `atrim=duration=scene.duration`, and
  `apad=pad_dur=extraDuration` for the source audio. This is a fixed fit-to-scene, not a
  content-aware edit.
- `lib/render/renderer.ts:302-350` probes the render and rejects an invalid output duration.
- `lib/render/video-compositor.ts` (`COMPOSER_VERSION = 'p8'`) concatenates scene renders and
  applies `alimiter=limit=0.95:level=false`; stereo layout is normalized per segment.
- `lib/render/video-composition-service.ts` derives readiness from the render plan and
  re-renders stale or missing scenes before composition.

### 3.3 Music

- `lib/render/music-mix.ts:5-13`: length bounds 3 s..600 s, default 60 s; fixed 1 s fade-in and
  2 s fade-out; signature covers asset id, duration, generation metadata.
- `lib/render/video-compositor.ts:186-230` mixes with `-stream_loop -1`, `atrim=0:<timeline>`,
  deterministic fades, and `amix ... duration=first`. Any music length therefore already fits the
  final timeline; it is looped or cut, not time-stretched.
- `lib/production/run-service.ts:1005-1046` (`prepareRunMusic`) is opt-in, fail-soft, reuses a
  usable track, refuses to start a second generation while one is in flight, and never throws.
- `lib/production/run-service.ts:1277` calls it **inside** the `final_compose` action, i.e. after
  scene renders are complete but before composition. The actual timeline (`totalDuration`) is not
  used to choose `musicLengthMs`; it comes from `policy.music.musicLengthMs` or the 60 s default.
- `lib/generation/music-service.ts:167` clamps explicit lengths; generated tracks are persisted as
  assets. Generation is a paid action and is never retried automatically.

### 3.4 Video providers and job lifecycle

- `lib/ai/video-generation/provider.ts:19-80` defines a clean adapter contract: submit, status,
  download, optional cancel; request supports model, prompt, references with roles
  `reference|start_frame|end_frame`, aspect ratio, width/height, duration, metadata; capabilities
  declare text/image-to-video, references, max references, supported ratios/durations, cancel.
- `lib/ai/video-generation/registry.ts:5-32` is a hardcoded switch: `openai`, `fal`,
  `fake`/`local`. There is no generic adapter registration or config-driven selection.
- `lib/ai/video-generation/fal-provider.ts:44-56` defaults to
  `minimax/h3-max-turbo/text-to-video`, accepts endpoint override via env, and enforces whole
  seconds in 1..15 (model schema). Queue path is learned from the submit response and validated to
  stay on the configured host.
- `lib/generation/video-generation-service.ts` persists the provider job id before submission is
  considered settled, busy-guards duplicate paid submits, classifies poll errors
  (transient vs terminal; `INVALID_REQUEST` terminal), supports cancellation, and downloads the
  result during the `generated` poll (`:836-869`) into the local media store.
- No OpenRouter adapter and no Veo/Gemini video adapter. Gemini is image-only in this codebase.
- Capabilities are not consulted before submit; the service passes the requested duration/model
  and relies on the adapter to reject invalid input.
- There is no provider-side idempotency key. Duplicate-submit protection is local (persisted
  attempt state plus in-process locks); a crash between provider accept and local persist can
  still orphan a paid job.

### 3.5 Orchestration, concurrency, and cost controls

- `lib/production/run-service.ts:149-171` defaults:
  `image=2`, `stock=2`, `video_submit=2`, `video_poll=4`, `narration=2`, `render=1`, `compose=1`;
  render/compose are additionally clamped by the local FFmpeg limiter.
  Run caps: 2 active runs, 24 iterations, 500 actions, 120 video polls, 4000 events, 6 h retention.
- `lib/security/access-control.ts:142-191` per-identity HTTP throttles, notably
  `generate_video=12/min`, `video_poll=180/min`, `generate_music=6/min`,
  `generate_narration=20/min`, `run_start=6/min`, `compose=8/min`, `render=10/min`.
- `lib/production/run-policy.ts` gates mock vs real: mock permits only fake image, local/fake
  video, fake narration; real mode requires credentials. Credential checks are presence-only.
- Cost accounting exists only for stock search/download quota
  (`lib/ai/stock/stock-state-store.ts`). There is no spend ledger, per-model price table, or
  budget ceiling for TTS, music, images, or video.
- Failed narration attempts already consumed TTS; a fresh attempt consumes again. Music has no
  automatic retry. Video polls never re-submit; terminal errors surface without re-billing.

### 3.6 Local vs cloud boundary

- Assets are written to the local project filesystem by `lib/storage/media-store.ts:76-94`.
- FFmpeg/FFprobe are resolved from `FFMPEG_PATH`/`FFPROBE_PATH` or `PATH`
  (`lib/render/ffmpeg-runtime.ts:8-9`) and spawned locally
  (`lib/render/ffmpeg-executor.ts:67`).
- Job locks, throttle state, the FFmpeg limiter, and run worker state are in-process
  (`globalThis`/module state). They do not coordinate across processes or hosts.
- Provider traffic is outbound HTTPS only; remote media is downloaded to local disk. There is no
  object storage or signed-URL handoff.
- Consequence: the current design is single-host. A cloud worker would need shared storage,
  shared job/lock state, and a decision about where FFmpeg runs before scaling out.

## 4. What already works and is covered

Tests exist for the pieces this work would touch, including:
`tests/music-mix.test.ts`, `tests/run-music-opt-in.test.ts`, `tests/music-service.test.ts`,
`tests/audio-mix.test.ts`, `tests/video-compositor-args.test.ts`,
`tests/video-compositor-audio.integration.test.ts`, `tests/video-composition-plan.test.ts`,
`tests/video-composition-service.integration.test.ts`, `tests/generate-video-route.test.ts`,
`tests/cancel-video-route.test.ts`, `tests/production-runner.test.ts`,
`tests/production-run-service.test.ts`, `tests/run-policy.test.ts`,
`tests/render-ffmpeg-limiter.test.ts`, `tests/project-update.test.ts`.

No test currently asserts audio-driven scene duration, silence trimming, timeline-derived music
length, capability validation, or provider-neutral adapter selection.

## 5. Gaps and risks

### Timing

- A too-long narration is rejected after payment instead of being trimmed, slowed within bounds,
  or expanding the scene. There is no retry budget or user-facing recovery path beyond "make the
  scene longer and generate again".
- Shorter narration leaves padded silence; no leading/trailing silence trim, so pacing depends on
  the TTS provider's padding.
- `durationTarget` does not allocate time across scenes. There is no explicit timeline object with
  segment in/out points.
- Stock/generated video clips are fitted by trim/pad to `scene.duration`; no smart selection of
  clip in-points or crossfades.

### Music

- Music is generated before the final timeline is known; `musicLengthMs` is explicit/default, not
  derived. The loop/trim in the compositor hides length mismatch but not musical phrasing: a
  loop point can land mid-phrase, and fades are fixed, not aligned to the timeline's final beat or
  last narration word.
- `prepareRunMusic` runs inside the compose action, so a slow paid music call delays composition.
- No ducking automation; music volume is a single static mix value.

### Providers

- Registry additions require code changes and redeploy. Model selection is env-driven per adapter,
  not part of a provider-neutral request/config with capabilities and pricing.
- Capabilities are not enforced, so unsupported durations/ratios/reference counts reach adapters.
- No cost estimate or ceiling before a paid submit; no spend ledger; no per-run budget.
- No idempotency key; crash-after-accept can orphan a paid job. Cancellation exists but is not
  guaranteed by all providers.
- FAL durations are 1..15 s, which forces multi-clip scenes or padding for longer beats.

### Operations

- Single-host assumptions (local disk, in-memory locks, local FFmpeg) block horizontal scaling.
- Throttles are per process and reset on restart.
- No cross-process coordination means two instances could double-submit paid work.

## 6. Proposed implementation order (three small phases)

Each phase is independently shippable and keeps existing API/MCP contracts additive.

### Phase A: explicit timeline + audio fitting (local only, no paid calls)

Scope:
- Introduce a pure timeline builder that takes scenes (text, measured narration duration, visual
  source duration) and produces per-scene `duration`, narration in/out points, and total duration.
- Policy: narration drives duration within operator bounds (min/max scene length, total
  `durationTarget` tolerance); leading/trailing silence is trimmed with a threshold and minimum
  gap; if narration still exceeds the bound, return an actionable validation issue **before**
  invoking TTS or reject without charging on the next attempt.
- Persist additive fields (timeline version, narration trim, source in-point) so renders are
  reproducible; keep old projects readable.
- Use existing `music-metadata` duration; optional FFmpeg `silencedetect` only for trimming, with
  a pure fallback when FFmpeg is unavailable.

Out of scope: crossfades, beat detection, TTS retries, provider changes, cloud storage.

Acceptance:
- Deterministic unit tests for allocation, clamping, and trim math (short, exact, long narration).
- Integration test with a fixture WAV containing leading/trailing silence.
- Rendered output duration equals the timeline; narration is not truncated mid-speech.
- Existing suite, typecheck, lint, build pass; no provider calls.

### Phase B: timeline-first music placement

Scope:
- Move music preparation to after timeline finalization and before compose, still opt-in and
  fail-soft.
- Derive `musicLengthMs` from the final timeline (clamped to provider bounds), or explicitly
  document loop mode when the timeline exceeds provider limits.
- Keep the existing loop/trim/fade path; optionally align fade-out to the timeline end and expose
  a "loop vs regenerate" choice.
- Record the timeline signature in the composition fingerprint so music changes invalidate stale
  compositions.

Out of scope: beat detection, automatic ducking curves, new music providers.

Acceptance:
- Tests assert music length derives from timeline, loop mode is used above provider max, and the
  composition fingerprint changes when the timeline changes.
- A music failure still produces a completed video with a diagnostic note.
- No new paid calls in tests.

### Phase C: provider-neutral video adapter layer, capabilities, and cost guard

Scope:
- Replace the hardcoded switch with an explicit adapter registry plus a provider-neutral
  config (provider id, model, capabilities, optional price metadata) validated at startup.
- Enforce capabilities before submit (duration, ratio, reference roles/count) and return a clear
  `INVALID_REQUEST` without calling the provider.
- Add a pre-submit cost/budget hook: operator-supplied price table, per-run ceiling, and a persist
  ledger entry keyed by attempt id. No hardcoded prices.
- Persist an idempotency key before submit and reuse it on retry where the provider supports it;
  otherwise document the residual risk.
- Add adapters only for providers whose contracts are verified (for example Veo or an
  OpenRouter-routed video model). Do not add placeholder adapters.

Out of scope: automatic provider fallback after submit, webhooks, multi-region deployment,
storage refactor.

Acceptance:
- Contract tests per adapter with mocked HTTP (submit, poll, download, cancel, terminal error).
- Capability rejection tests prove no provider call occurs.
- Budget tests prove a blocked submit does not spend and is auditable.
- Duplicate concurrent submit yields exactly one provider call.
- No paid tests in CI; an opt-in manual test is documented.

## 7. Minimal end-to-end test

Default (free, mock/local):
1. Build a project with two scenes: a still image with a 4.2 s narration fixture (0.4 s leading and
   0.6 s trailing silence) and a 6 s local stock-style video.
2. Run narration through the fake provider or inject the fixture asset, then timeline build, scene
   render, and compose with music disabled.
3. Assert: timeline equals expected bounds, trim removes the silence, output duration equals the
   timeline, audio stream present, H.264/AAC, and a second compose is a no-op/cache hit.

Opt-in paid test (explicit env gate, never in CI):
- One short TTS call and one 5 s FAL clip; assert the clip is downloaded once, persisted, polled
  again without a second provider submit, and cancel after completion is a no-op.
- Gate with something like `P32_PAID_TEST=1` plus credentials; print the provider job ids (never
  the keys) and a cost estimate from the operator price table.

## 8. Decisions needed before implementation

1. What exactly should "montage" mean here: trim each clip to its narration, vary scene duration,
   add crossfades, or all three? Phase A assumes per-scene duration allocation plus narration
   trim; crossfades are out of scope.
2. May automatic timing change `scene.duration`, or should it only suggest a timeline and require
   confirmation? The former is simpler but changes authored projects.
3. Silence trimming defaults: threshold, minimum silence, and whether to preserve a natural
   lead-in. These are user-visible creative choices.
4. Music policy: always loop to the timeline, regenerate when the timeline exceeds the provider
   max, or ask per run? And is fade alignment enough, or is beat alignment required later?
5. Which paid video provider/model is the first target, and who owns the price table and budget
   ceiling?
6. Is single-host deployment intentional for now? If not, storage and cross-process locking must be
   addressed before provider scale-out.

## 9. Residual risks / open questions

- Paid TTS is still spent before a duration mismatch is detected in the current flow; Phase A
  should move the check earlier, but only if it can estimate duration reliably before synthesis.
- Provider capabilities and pricing change; config must be operator-editable without a code
  change.
- FAL's 1..15 s limit may force multi-clip scenes; the timeline model should support multiple
  source segments per scene eventually.
- Local FFmpeg remains the throughput and memory bottleneck; Phase A/B stay within the existing
  single-FFmpeg limit.
- The legacy Pixabay key found in a temporary artifact still needs rotation; do not reuse it.
