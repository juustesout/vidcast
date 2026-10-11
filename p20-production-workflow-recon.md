# P20 Production Workflow Recon

Status: RECON ONLY. No application code, tests, schema, config, or dependencies
were changed. No commits, no pushes, no paid API calls, and no real
image/video/TTS/music generation was performed. All findings below are derived
by reading this repository (source of truth) plus the P18/P19 evidence already
on disk (`p18-hermes-e2e-smoke-report.md`, `p19-production-reliability-recon.md`,
`p19-production-reliability-implementation.md`).

Evidence tags used throughout:

- **Verified** — observed by running an existing test or a safe local command
  (no credentials, no paid calls).
- **Code-inspected** — established by reading the implementation; logic is
  deterministic but not executed end-to-end here.
- **Unverified** — plausible but not proven by evidence gathered in this pass.
- **Potential risk** — a concrete defect or failure mode that follows from the
  code; may need a controlled local reproduction to fully confirm.

---

## 1. Executive summary

The production workflow is a single-machine, in-process pipeline that turns a
project (scenes + assets + narration + optional music) into a rendered MP4. It
is genuinely end-to-end functional in mock mode: P18 exercised a real drive to a
decodable 1280x720 H.264/AAC MP4 with the `fake` providers, and P19 verified
real FFmpeg scene render + composition at 720p and 1080p.

What is real vs. mocked:

- **Real**: FFmpeg scene rendering, composition/concatenation, ffprobe,
  project persistence, run lifecycle, image editing via `sharp`, the OpenAI
  image adapter, the ElevenLabs TTS + music adapters (network code present,
  gated on keys).
- **Mocked by default**: image generation (`fake`), text-to-speech (`fake`),
  background music (`fake`), video generation (no default provider visible).
- **Missing / partial**: per-scene sound effects (`effectsVolume` is parsed but
  never applied), a real default video-generation provider, and any in-service
  guard against concurrent scene renders writing to a shared temp directory.

Highest-value verified issue: the **scene-render temp directory is shared
per-project and deleted in `finally`** (`lib/render/render-artifacts.ts:13-19`,
`lib/render/scene-render-service.ts:49,58`, `lib/render/renderer.ts:359`). Two
concurrent `renderScene` calls for different scenes in the same project resolve
to the same `tempDir` and each removes it on completion. P19 serialized only the
*persistence* writes (`mutateProject`), not the render itself, so this race
remains. This is the recommended focus for the next phase.

---

## 2. Method

- Traced the project lifecycle from HTTP route → service → storage.
- Traced the production run planner → runner → per-action generators/renders.
- Audited every AI provider registry (`image-generation`, `video-generation`,
  `text-to-speech`, `music`) for real vs. fake vs. missing.
- Audited the render/audio/music mix path for volume application and format
  handling.
- Re-checked the P19 concurrency guarantees against the render path (not just
  the persistence path).

---

## 3. End-to-end workflow map

Ordered execution path (files/services and handoffs):

1. **Project bootstrap** — `app/api/projects/route.ts:25-37` → `createProject`
   (`lib/storage/project-store.ts`). The default template seeds exactly one
   `defaultScene` with `visual.kind='generated_image'`, generation status
   `planned`, empty narration, duration `5` (`lib/storage/project-store.ts:165-223`).
2. **Project edit** — `app/api/projects/[id]/route.ts` → `applyProjectUpdate`
   (`lib/projects/project-update.ts`) + `mutateProject` for atomic persistence.
3. **Scene-intent planning** — `planSceneIntentsFromBeats`
   (`lib/projects/scene-intent-planner.ts:38-64`) creates drafts (status
   `draft`, duration 5). Approval is UI-only
   (`components/project/explainer-story-workspace.tsx:490`); materialization is
   `lib/projects/scene-intent-materializer.ts`.
4. **Run creation** — `lib/production/run-service.ts` builds a run, applies
   policy (`lib/production/run-policy.ts`), and enqueues.
5. **Action planning** — `lib/production/production-planner.ts` emits planned
   actions with dependency statuses: `image_generate`, `video_submit`,
   `video_poll`, `narration_generate`, `scene_render`, `final_compose`
   (`production-planner.ts:9-14`; action IDs `scene:<id>:<type>` and
   `project:final_compose`).
6. **Bounded execution** — `runProductionBatch`
   (`lib/production/production-runner.ts:256`) executes actions in bounded
   batches (`executeBounded`, `production-runner.ts:228-254`) with terminal
   status `completed | partial | failed | unresolved`
   (`production-runner.ts:208-219`).
7. **Generation actions** — image/video/narration/music services under
   `lib/generation/` call provider registries under `lib/ai/`, persisting via
   `mutateProject`.
8. **Scene render** — `SceneRenderService.renderScene`
   (`lib/render/scene-render-service.ts:24`) → `LocalFFmpegRenderer.render`
   (`lib/render/renderer.ts`).
9. **Final compose** — `VideoCompositionService`
   (`lib/render/video-composition-service.ts`) → `VideoCompositor`
   (`lib/render/video-compositor.ts`) concatenates normalized scene renders and
   optionally mixes music.
10. **Persistence of results** — every write funnels through the atomic,
    per-project-locked `writeProjectFile`/`mutateProject`
    (`lib/storage/project-store.ts`) introduced in P19.

Storage layout: `projects/<projectId>/{project.json,assets,references,renders,previews,runs}`;
`getWorkspaceRoot()` = `process.cwd()` (`lib/storage/storage-paths.ts`).

---

## 4. Capability matrix

| Capability | Status | Provider / location | Evidence |
| --- | --- | --- | --- |
| Project persistence (atomic + locked) | Implemented | `project-store.ts` | Code-inspected; P19 tests pass (Verified) |
| FFmpeg scene render | Implemented (real) | `LocalFFmpegRenderer` | Verified (P18/P19 real renders) |
| FFmpeg composition | Implemented (real) | `VideoCompositor` | Verified (P18 real MP4) |
| ffprobe probing | Implemented (real) | `lib/render/ffprobe.ts` | Code-inspected |
| Image generation | Default **mock**, real optional | `fake` / `openai` | Code-inspected |
| Video generation | **Partial/mock** | registry has no default real provider visible | Code-inspected |
| Narration (TTS) | Default **mock**, real optional | `fake` / `elevenlabs` | Code-inspected |
| Background music | Default **mock**, real optional | `fake` / `elevenlabs` | Code-inspected |
| Sound effects | **Missing** (`effectsVolume` unused) | — | Code-inspected |
| Timing/duration planning | Implemented (fixed 5s default) | `scene-intent-planner.ts`, normalized settings | Code-inspected |
| Run lifecycle + limits + recovery | Implemented | `lib/production/*` | Code-inspected; P18 diagnostic projects on disk |
| Concurrency safety | Implemented for persistence; gap in render | `keyed-mutex.ts` | Code-inspected |

---

## 5. Findings

### 5.1 Scene visuals

- `FakeImageGenerationProvider` id `fake`
  (`lib/ai/image-generation/fake-provider.ts:6-42`): deterministic 1280x720 PNG
  via `sharp`, seeded by `SHA1(prompt)`. **Code-inspected.**
- `OpenAiImageGenerationProvider` id `openai`
  (`lib/ai/image-generation/openai-provider.ts:60-144`): real `fetch` to
  `${baseUrl}/images/generations` or `/images/edits`; requires
  `OPENAI_API_KEY`; model from `OPENAI_IMAGE_MODEL` (default `gpt-image-1`);
  base URL hardcoded `https://api.openai.com/v1`. **Code-inspected.**
- Registry maps `openai`/`fake`; configuration status reads `OPENAI_API_KEY`
  (`lib/ai/image-generation/registry.ts:13-37`). **Code-inspected.**
- Video generation registry has no clearly defaulted real provider
  (`lib/ai/video-generation/registry.ts`): visual video steps resolve to
  submit/poll actions that depend on a configured provider. **Unverified**
  whether any real provider is wired by default.

### 5.2 Narration / audio

- TTS registry ids `elevenlabs | fake` (`local` → `fake`)
  (`lib/ai/text-to-speech/registry.ts:7,19-21`). **Code-inspected.**
- `FakeTTS` returns a fixed base64 **WAV** silence with `duration: 0.25`, but
  echoes `request.format`. An `mp3` request therefore yields WAV bytes labeled
  `audio/mpeg` and saved as `.mp3`. **Potential risk**
  (`lib/ai/text-to-speech/fake-provider.ts:3-25`). Mock-only, so the impact is
  limited to fake-mode artifact consistency, not production audio.
- ElevenLabs TTS id `elevenlabs`, `ELEVENLABS_API_KEY`,
  `ELEVENLABS_TTS_MODEL` default `eleven_multilingual_v2`, base
  `https://api.elevenlabs.io/v1`; format map `wav→pcm_44100`,
  `m4a→mp3_44100_128`, `mp3→mp3_44100_128`. An `m4a` request declares
  `Accept: audio/mp4` but returns MP3 bytes. **Potential risk**
  (`lib/ai/text-to-speech/elevenlabs-provider.ts:10-28,47-78`).

### 5.3 Music and effects

- Music registry ids `fake | elevenlabs` (`local` → `fake`)
  (`lib/ai/music/registry.ts:7-26`). **Code-inspected.**
- `FakeMusicProvider` produces a deterministic silent PCM WAV whose duration
  matches the requested length (`lib/ai/music/fake-provider.ts:14-37`).
  **Code-inspected.**
- Two volume controls are applied during composition — `narrationVolume` and
  `musicVolume` (`lib/render/video-compositor.ts:83,163-165`). **Code-inspected.**
- `effectsVolume` is parsed, clamped, and included in equality checks
  (`lib/render/audio-mix.ts:10,29,45`) but is **never used to build an FFmpeg
  filter** and no per-scene sound-effect track exists. **Code-inspected** —
  sound effects are effectively unimplemented.

### 5.4 Timing and duration

- Default scene duration is `5` seconds, set by the template and the
  scene-intent planner (`project-store.ts:165-223`,
  `scene-intent-planner.ts:38-64`). **Code-inspected.**
- Timeouts are bounded and configurable post-P19: `RENDER_SCENE_TIMEOUT_MS`
  (60000), `RENDER_COMPOSE_TIMEOUT_MS` (180000), `RENDER_PROBE_TIMEOUT_MS`
  (30000), clamped to `[1000, 1800000]` (`lib/render/render-timeouts.ts`).
  **Code-inspected**; timeout diagnostics covered by P19 tests (Verified).

### 5.5 Composition

- `VideoCompositor` normalizes each scene render, writes a concat list to
  `options.tempDir`, concatenates, then optionally mixes music
  (`lib/render/video-compositor.ts:211-292`). **Code-inspected.**
- Composition temp dirs are per-composition (`createCompositionArtifacts` /
  `composition-artifacts.ts:28`: `compositions/.tmp/<compositionId>`), so
  composition does **not** share the scene-render temp bug. **Code-inspected.**
- P18 verified a real 2.034s 1280x720@30 MP4 (h264+aac, decode exit 0);
  P19 verified 720p, 1080p, and multi-scene composition. **Verified.**

### 5.6 Reliability and concurrency

- P19 keyed lock is **process-local only** (`lib/utils/keyed-mutex.ts:5-7`);
  cross-process concurrency is not protected. Documented limitation.
  **Code-inspected.**
- **Scene-render temp dir race (primary finding).** `renderScene` calls
  `ensureRenderDirectories(projectId)` and passes the returned shared `tempRoot`
  (`renders/<project>/.tmp`) as `tempDir`
  (`lib/render/scene-render-service.ts:49,58`). `LocalFFmpegRenderer.render`
  removes that directory in `finally`
  (`lib/render/renderer.ts:359`, `fs.rm(options.tempDir, {recursive:true})`).
  A unique per-render temp dir already exists —
  `createSceneRenderPaths(...).tempRoot = renders/.tmp/<renderId>`
  (`lib/render/render-artifacts.ts:28`) — but it is **unused**. Two concurrent
  renders in the same project therefore delete each other's working files.
  P19's lock wraps only the `mutateProject` calls
  (`scene-render-service.ts:82,95`), not the render itself. **Code-inspected
  (confirmed defect by tracing).**
- `deleteProject` performs `fs.rm(getProjectRoot(id), {recursive:true})` with
  **no lock** (`lib/storage/project-store.ts:733-735`), so it can race an
  in-flight `writeProjectFile` for the same project. **Potential risk.**
- `ensureSeedProject` reads the projects dir, and if empty writes the sample,
  with **no lock** (`lib/storage/project-store.ts:569-580`); two concurrent
  first-run callers can double-seed. **Potential risk.**
- Run diagnostics/recovery paths exist and P18 left diagnostic projects on disk
  (success, render-timeout, corrupt, auth-probe). **Verified (P18).**

---

## 6. Existing evidence and limitations

Evidence reused (not regenerated here):

- P18 smoke: driver `/tmp/opencode/p18-e2e.mts`, result `/tmp/opencode/p18-result.json`,
  real MP4 `/tmp/opencode/p18-composition.mp4` (7307 bytes, 2.034s
  1280x720@30, h264+aac, decode exit 0).
- P19: typecheck/lint/build clean; **374 tests / 62 files pass**; real FFmpeg
  720p + 1080p + multi-scene composition.
- Local toolchain: FFmpeg/ffprobe `5.1.9-0+deb12u1`
  (`/usr/bin/{ffmpeg,ffprobe}`), Node v22.22.0, Next 15.5.27, Vitest 5.0.3,
  zod ^4.6.5.

Limitations of this recon:

- The scene-render temp race was proven by reading code, **not** by running two
  concurrent renders (that would need a controlled local test). It is labeled
  Code-inspected (confirmed defect by tracing) rather than Verified.
- Real provider adapters (OpenAI image, ElevenLabs TTS/music) were **not**
  exercised (no paid calls). Their correctness beyond URL/shape inspection is
  **Unverified**.
- Video generation's default provider wiring is **Unverified**; the registry
  surface suggests video is not fully real-provider-defaulted.

---

## 7. Prioritized gaps and risks

1. **P1 — Scene-render temp directory race.** Shared `renders/.tmp` deleted in
   `finally`; concurrent scene renders corrupt/delete each other's work. Fix is
   small and localized: use the already-computed per-render
   `createSceneRenderPaths(...).tempRoot` instead of the shared `tempRoot`.
   (`scene-render-service.ts:49,58`; `render-artifacts.ts:13-31`;
   `renderer.ts:359`.)
2. **P2 — `deleteProject` takes no lock.** Can race an in-flight project write.
   Wrap the removal in the same per-project keyed lock (or gate on the lock).
   (`project-store.ts:733-735`.)
3. **P3 — `ensureSeedProject` unlocked read-then-write.** Concurrent first-run
   double-seed. Guard with a lock or an idempotent existence check.
   (`project-store.ts:569-580`.)
4. **P4 — Sound effects unimplemented.** `effectsVolume` is parsed but never
   applied; there is no effects track. Either wire it into mixing or remove the
   dead setting to avoid a misleading UI/config surface.
   (`audio-mix.ts:10,29,45`; `video-compositor.ts:83,163-165`.)
5. **P5 — Mock audio format mislabeling.** Fake TTS echoes the requested format
   while always emitting WAV; ElevenLabs `m4a` emits MP3. Low impact in mock
   mode but yields mislabeled artifacts. (`text-to-speech/fake-provider.ts:3-25`;
   `elevenlabs-provider.ts:47-78`.)
6. **P6 — Video-generation default provider unclear.** Confirm whether any real
   provider is wired; otherwise video scenes silently remain in
   submit/poll-with-no-provider. (`video-generation/registry.ts`.)
7. **P7 — Process-boundary limitation.** The keyed lock does not protect against
   multiple processes. Acceptable for the current single-process design but must
   be documented wherever deployment topology changes.
   (`keyed-mutex.ts:5-7`.)

---

## 8. Recommended next phase

**P21 — fix the scene-render temp directory race (P1) with a focused
concurrency test.**

- Change `SceneRenderService.renderScene` to pass the per-render temp dir
  (`paths.tempRoot`) to the renderer instead of the shared
  `ensureRenderDirectories(projectId).tempRoot`, and drop the now-unneeded
  shared-dir dependency (or keep directory creation but scope deletion to the
  per-render dir).
- Add a test that starts two concurrent `renderScene` calls for different scenes
  in the same project and asserts both renders complete and both outputs are
  valid — this is the "controlled local test" needed to move P1 from
  Code-inspected to Verified.
- Optionally bundle P2/P3 (lock `deleteProject`, lock `ensureSeedProject`) since
  they are small and share the same concurrency theme.

Rationale: P1 is a concrete, deterministic defect that directly threatens a core
capability (rendering) and is the single highest-value verified issue, with a
low-risk, localized fix and a clear verification path.
