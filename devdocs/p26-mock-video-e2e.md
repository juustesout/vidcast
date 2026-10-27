# P26: Decodable Mock Video, End-to-End

Status: **executed, mock-only.** The `fake` video provider no longer returns a
non-decodable 24-byte `ftyp` stub. It now returns a small, genuinely decodable
H.264/MP4 clip, so a mock `generated_video` run completes the whole chain
`video_submit → video_poll (multiple) → scene_render → final_compose` and
produces a valid composed MP4. No real/paid provider was called. No new
dependency was added (the fixture is an inline base64 constant). No commit or
push.

---

## 1. Recon

- `lib/ai/video-generation/fake-provider.ts` returned
  `FAKE_MP4_BYTES = Buffer.from('000000186674797069736F6D0000020069736F6D69736F32', 'hex')`
  — a 24-byte ISO-BMFF `ftyp` box with no `moov`/`mdat`, i.e. not a playable
  video.
- On `status === 'generated'`, `lib/generation/video-generation-service.ts:836`
  calls `provider.download(...)` and persists the bytes via
  `mediaStore.saveGeneratedVideo` (`lib/storage/media-store.ts:312`). The media
  metadata reader (`lib/media/metadata-reader.ts:107`) parses only the ISO-BMFF
  `mvhd` duration for video (no width/height).
- `scene_render` for a video source runs `buildVideoPipeline`
  (`lib/render/renderer.ts:386`): it `ffprobe`s the source, then FFmpeg
  `trim`/`tpad`/scale/fade re-encodes to `libx264 -pix_fmt yuv420p` MP4. With the
  stub bytes FFmpeg could not demux the input → `FFMPEG_FAILED`
  (`renderer.ts:261`). This was observed live in P25.1
  (`p25.1-live-recovery-and-f2.md` §3.5).
- No existing `.mp4` fixture existed anywhere in the repo (searched).

## 2. Approach chosen

Smallest solution: bundle one tiny, real H.264/MP4 clip as an **inline base64
constant** (`lib/ai/video-generation/fake-video-fixture.ts`), rather than adding
a binary file or a runtime FFmpeg dependency:

- Self-contained: works identically under vitest and the Next.js server bundle
  (no `import.meta.url`/`process.cwd()` path resolution, which breaks once Next
  webpack-bundles the module).
- No new dependency; the mock provider still never shells out and never touches
  the network.
- Deterministic and byte-for-byte reproducible; the regeneration command is
  documented in the module.

Fixture properties: 64x64, 5 fps, 1 s, H.264 baseline, `yuv420p`, no audio,
`moov` up front (fast-start), animated `testsrc` pattern → 1965 bytes. It is
clearly synthetic (`providerId: 'fake'`, `metadata.fake: true`, visible test
pattern), so it cannot be confused with real provider output.

## 3. Change

- New `lib/ai/video-generation/fake-video-fixture.ts`: `FAKE_VIDEO_CLIP_BASE64`,
  `FAKE_VIDEO_CLIP_BYTES`, `FAKE_VIDEO_CLIP_METADATA`.
- `lib/ai/video-generation/fake-provider.ts`: `download()` returns
  `FAKE_VIDEO_CLIP_BYTES` (mime `video/mp4`) and metadata
  `{ ...FAKE_VIDEO_CLIP_METADATA, jobId }`; removed the local `FAKE_MP4_BYTES`.

`submit`/`getStatus` behaviour is unchanged (still queued → generating →
generated on the 3rd poll).

## 4. Full-chain live verification (mock, isolated `next dev`)

Run: `project_89a5cb2b-706d-43c3-952f-9f40a49f8fc6` /
`run_e6a4d604-f249-4dbf-9af7-7465fc1c27b2` (2 × `generated_video` scenes,
duration 4, `force:true`, `mode:mock`).

Run log (no failures):

```
video_poll_scheduled: 6
video_poll_completed: 6          # 3 per scene: queued -> generating -> generated
action_completed:     6
composition_started:  1
composition_completed:1
run_completed:        1
failures:             []
```

Final run: all 9 actions completed
(`video_submit`, `video_poll`, `narration_generate`, `scene_render` per scene +
`project:final_compose`), `failedActionIds: []`.

Artifacts on disk:

- 2 generated video assets, 1965 B each (the fixture) + 2 narration WAV assets.
- `renders/compositions/final-composition_3d3c86b8-*.mp4`.

`ffprobe` of the final composition:

```
video: h264, 1920x1080, avg_frame_rate 30/1, duration 8.033333
audio: aac, duration 8.032000
format: mov,mp4,m4a,3gp,3g2,mj2, duration 8.034000, size 201107
```

`ffprobe` of a scene render: `h264, 1920x1080, duration 4.000000`. Expected
composition duration ≈ 2 × 4 s; codec/streams/resolution all as expected and the
file decodes without errors.

(Note: the interactive `p25_1.mjs wait` helper hit a client-side polling
hiccup during this run; the run itself reached `completed` — confirmed by the
run log and persisted state above.)

## 5. Automated tests

New/changed:

- `tests/fake-video-provider-render.test.ts` (new): drives the fake provider
  `submit` → 3× `getStatus` → `generated` → `download`; asserts the bytes are
  deterministic, `ffprobe`-decodable (`h264`, 64x64, no audio), and that
  `LocalFFmpegRenderer` renders it to a 1280x720 H.264 MP4.
- `tests/production-run-e2e.integration.test.ts` (extended): new full-chain
  integration test with real service + real runner + real renderer/compositor
  and the mock `fake` provider. Asserts `completed`, no failed actions, ≥2
  completed polls, no `run_stopped_unresolved`, decodable 1965 B video assets
  (duration ≈ 1 s), per-scene renders, and a composed MP4 with h264 640x360 +
  aac, duration ≈ 8 s, decoding without errors.
- `tests/production-run-service.test.ts` (extended):
  - `enforces the per-run maxVideoPolls limit` → 3rd/4th poll raise
    `VIDEO_POLL_LIMIT_REACHED`, provider polled exactly twice.
  - `enforces the per-run maxActionExecutions limit` → 3rd/4th action raise
    `ACTION_LIMIT_REACHED`, executor invoked exactly twice.

Regression guarantees preserved (unchanged, all passing):

- Poll dedup / no early stop:
  `tests/production-runner.test.ts` — "re-polls an in-flight video job across
  iterations…".
- Restart recovery + no double submit:
  `tests/run-recovery.test.ts` — "resumes a stored video job by polling and does
  not resubmit"; headless run-recovery restart tests.

## 6. Verification

| Step | Command | Result |
| --- | --- | --- |
| Targeted | `npx vitest run tests/fake-video-provider-render.test.ts tests/production-run-e2e.integration.test.ts tests/production-run-service.test.ts tests/production-runner.test.ts tests/run-recovery.test.ts` | 5 files, 43 tests passed |
| Typecheck | `npm run typecheck` | clean |
| Lint | `npm run lint` | no warnings or errors |
| Full suite | `npm test` | 100 files, 749 tests passed |
| Build | `npm run build` | ok |

## 7. Limitations / boundaries

- The mock source clip is 64x64; the renderer scales it to the canvas (`cover`).
  Quality is irrelevant for a mock and is not representative of real output.
- Video asset metadata still records only duration (the existing lightweight
  `mvhd` reader); width/height are intentionally not added.
- The `fake` provider keeps jobs in memory, so a **real process restart cannot
  resume a fake video job** (the provider job is gone). The resume-by-poll and
  no-double-submit guarantees are provider-agnostic and covered by the planner /
  recovery tests; a live restart resume would need a persistent provider and was
  out of scope.
- No real providers used, no refactors beyond the fake provider + fixture, no
  secrets logged, no destructive cleanup.

## 8. Files

- `lib/ai/video-generation/fake-video-fixture.ts` (new)
- `lib/ai/video-generation/fake-provider.ts`
- `tests/fake-video-provider-render.test.ts` (new)
- `tests/production-run-e2e.integration.test.ts`
- `tests/production-run-service.test.ts`
