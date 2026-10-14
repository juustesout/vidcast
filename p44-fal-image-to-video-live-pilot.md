# P44 - Authorized FAL Image-to-Video Live Pilot

Status: **EXECUTED.** Exactly **one** paid FAL submit was made against the
explicit, single-use user authorization (max 1 submit, max $1). No production code
was changed, nothing was committed or pushed, no credential was read/printed, and
no environment/production setting was modified. The existing untracked recon docs
and the gitignored `projects/` data were left intact.

Outcome: **full chain succeeded.** Submit (`IN_QUEUE`) -> `IN_PROGRESS` ->
`COMPLETED`; the result MP4 was downloaded and stored through the real media store,
`ffprobe` inspected and fully decoded with local FFmpeg. The P39 queue-path
resolution worked for the i2v endpoint on the first attempt (no 405 recurrence).

Convention: **[official]** = quoted from a FAL source fetched this session;
**[run]** = command output this session; **[code]** = verified by reading this repo;
**[estimate]** = not independently confirmed by an invoice/usage figure.

---

## 1. Repository status and preflight decisions

- Branch `main`; `HEAD = b9d7a8043729ade1d3d4266f52aabd0aee35bfed` **equal to
  `origin/main`** **[run]**. Working tree clean except the intentionally untracked
  recon docs (`p29`, `p29.2`, `p31`, `p33`, `p35`, `p37`, `p38`, `p40`, `p42`,
  `p43`). No tracked file modified; no `.gitmodules`.
- Reports consulted: `p42-fal-image-to-video-preflight.md`,
  `p43-fal-image-to-video-pilot-input.md`, `p41-fal-image-to-video-implementation.md`
  (and `p38` for the prior real-smoke precedent).
- Pilot project and reference re-confirmed valid **[run]**: project
  `project_9a05a830-88ff-4435-a10f-ff6495937ebc`, scene
  `scene_90665c67-68c4-4a40-919b-78b90f44eb9e`, reference
  `reference_0cbe7ade-10bb-418e-822b-c0fbbe69d2f4`; the stored PNG re-hashed to
  `d508d002b598de3cee221e47046a9ff6d5d11c82128fc9af55a9c2905b478142` (unchanged).
- Real-mode / opt-in / credentials / policy (existence only; the key value was never
  read, printed or logged) **[run]**:
  - `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS = true`, `PRODUCTION_RUN_DEFAULT_MODE = real`.
  - `FAL_KEY` present (`<set:72 chars>`); `OPENAI_API_KEY` also present.
  - No `FAL_VIDEO_*` overrides are set, so adapter defaults apply
    (`FAL_VIDEO_BASE_URL=https://queue.fal.run`, `prompt_expansion_mode=disabled`,
    no `resolution` override -> model default `768P`, safety checker default true).
  - `resolveRunPolicyServerConfig()` -> `{ allowRealProviders: true, defaultMode: 'real' }`.
  - `resolveManualGenerationProvider('video', 'fal', {})` -> `{ mode: 'real', provider: 'fal' }`
    (existing policy chain; credential assertion passed). Not a bypass.
  - `getVideoGenerationConfigurationStatus().falConfigured = true`.
- Local payload preflight (injected fetch, **no network**) **[run]**: the adapter
  produced exactly `{ prompt, prompt_expansion_mode, duration, sync_mode:false,
  image_url }` at `POST https://queue.fal.run/minimax/h3-max-turbo/image-to-video`,
  auth scheme `Key`; **no `aspect_ratio`**, **no `end_image_url`**; `image_url` is a
  `data:image/png;base64,...` data URI.

### Price source and cost limit (**required preflight check**)

Official model page `https://fal.ai/models/minimax/h3-max-turbo/image-to-video`
fetched this session **[official]**:

> Video costs **$0.015** per second at **480p**, **$0.024** per second at **768p**,
> and **$0.048** per second at **1080p**. ... promotional rates, **40%** off ...
> ends **October 15**, after which 480p is **$0.025**/second, 768p is **$0.04**/second,
> and 1080p is **$0.08**/second.

Decision (go): default resolution 768P; 5 s @ $0.024/s ≈ **$0.12** (promo). Worst
case even at 1080P post-promo for ~5.2 s is ≈ **$0.42**, still well under the **$1**
cap. No additional fees are published for this endpoint. Proceeded.

---

## 2. Exact pilot parameters

| Field | Value |
| --- | --- |
| Project | `project_9a05a830-88ff-4435-a10f-ff6495937ebc` |
| Scene | `scene_90665c67-68c4-4a40-919b-78b90f44eb9e` |
| Provider | `fal` (forced via the existing policy chain) |
| Endpoint/model | `minimax/h3-max-turbo/image-to-video` |
| Input | registered P43 startframe `reference_0cbe7ade-10bb-418e-822b-c0fbbe69d2f4` (PNG 1536x1024, SHA-256 `d508d002...b478142`), sent as inline data URI |
| End frame | none (no `end_image_url` sent) |
| Duration | 5 s (valid: schema default 5, range ~0.92..15) |
| Resolution | not sent -> model default `768P` |
| Aspect ratio | none (no `aspect_ratio`; canvas derived from the frame) |
| `sync_mode` | `false` |
| `prompt_expansion_mode` | `disabled` (adapter default) |
| Prompt | "Subtle cinematic push-in on the provided start frame, warm lighting, no text." |

No other project/scene setting was changed; no image was generated; no
text-to-video call was made.

---

## 3. Exactly one submit (confirmation)

- A pre-submit guard file (`/tmp/opencode/p44-submit-guard.json`) was written
  **before** the call with `status: submitting`, so any rerun refuses to submit.
- One call to `submitSceneVideoGeneration(projectId, sceneId, { provider: 'fal',
  mode: 'real' })` (the existing service flow used by
  `app/api/projects/[id]/scenes/[sceneId]/generate-video/route.ts`) **[run]**.
- **Total paid submit requests: 1.** No probe, no test request, no retry, no second
  generation, no end frame. Polling, result fetch and (unused) cancel targeted only
  the original job.

---

## 4. FAL request and status flow

- `POST https://queue.fal.run/minimax/h3-max-turbo/image-to-video`.
- **Request ID: `01a13475-721d-79c1-80c0-3a8f2e91da48`**
- Composite job id persisted: `fal:minimax/h3-max-turbo:01a13475-721d-79c1-80c0-3a8f2e91da48`
  (queue path `minimax/h3-max-turbo` learned from FAL's returned URLs — the endpoint
  sub-path is dropped, exactly as P39 intended).
- Generation attempt: `generation_attempt_8b066a33-9648-4519-834f-c8b6f76e1bae`.

| Step | Provider status | Mapped status | Time (UTC) |
| --- | --- | --- | --- |
| submit | `IN_QUEUE` | `queued` | 08:51:14 |
| poll 1 | `IN_PROGRESS` | `generating` | 08:51:15 |
| poll 2 | `COMPLETED` | `generated` | 08:51:24 |

No ambiguity: the submit response contained a usable request id and FAL URLs.
Polling stopped at the first terminal status.

---

## 5. Result, storage and validation

- Result `video.url` (public CDN) fetched **without** the API key, then persisted via
  the real `mediaStore.saveGeneratedVideo`.
- Stored asset:
  - id: `asset_9be35a34-fc94-40f0-911f-0434d39ecae1`
  - path: `projects/project_9a05a830-88ff-4435-a10f-ff6495937ebc/assets/scene-01-generated-generation_attempt_8b066a33-9648-4519-834f-c8b6f76e1bae.mp4` (gitignored)
  - type `video`, status `available`, provenance `generated`, mimeType `video/mp4`,
    filesize `5404210`, duration `5.184`, SHA-256
    `d1e763781043d3c335887adabdc1492191cc443d9873b05c8988f7d1b27b051f`.
  - `metadata.providerJobId = fal:minimax/h3-max-turbo:01a13475-...`,
    `metadata.providerRequestId = 01a13475-...`, `metadata.queuePath = minimax/h3-max-turbo`.
- The scene now references the result **[run]**: `scenes[0].visual.assetId =
  asset_9be35a34-...`, `generation.status = generated`, `generation.assetId` set,
  `assets[]` contains the new video. File re-opened successfully for probing.

### `ffprobe` (stored file) **[run]**

- Video: `h264` (Constrained Baseline, `avc1`), **1152x768**, `yuv420p`, 24 fps,
  124 frames, duration **5.166667 s**, ~8.14 Mbps. (1152x768 is 3:2, matching the
  1536x1024 input frame — the i2v canvas follows the image, not the 16:9 project.)
- Audio: `aac` LC, 32000 Hz, stereo, duration **5.184 s**.
- Container: `mov,mp4,...`, duration **5.184 s**, size `5404210`.

### Full decode **[run]**

`ffmpeg -v error -i <file> -f null -` -> **exit 0** (no errors); frame-count probe
reports 124 decoded video frames.

### Duration deviation

Requested 5 s; container output 5.184 s (+0.184 s), video stream 5.166667 s. This is
within the documented tolerance ("the output can run up to about 0.7 s longer than
requested") **[official]**.

---

## 6. Cost

- **Estimated spend:** ~**$0.12** (5.184 s × $0.024/s promo 768P) **[estimate]**.
  At the post-Oct-15 768P rate it would be ~$0.21; at 1080P post-promo ~$0.41.
  Comfortably under the **$1** cap.
- **Confirmed billing: not available in this run.** The result payload carries no
  price and no invoice/usage figure was reachable; the figure above is an estimate,
  not a verified charge. No cost number is invented.

---

## 7. Errors, deviations and remaining uncertainties

- No errors. The P38 adapter bug (wrong queue path for multi-segment endpoints) did
  **not** recur: the composite job id and poll/result URLs used
  `minimax/h3-max-turbo` correctly, so P39's fix works for i2v as well.
- Confirmed on live call: base64 data-URI `image_url` is accepted; the i2v output
  canvas follows the frame (3:2), independent of the project's 16:9; `sync_mode:false`
  returned a CDN URL.
- Still **[open]** (non-blocking): per-field image byte/pixel limits are undocumented
  (2.69 MB PNG accepted); pixel-exactness of the start frame is not asserted; the
  precise billed seconds (rounding policy) are unknown, so the cost remains an estimate.

---

## 8. Scope confirmation

No application code was changed; nothing was committed or pushed. No extra paid
requests, retries or regenerations; no end frame; no other provider; no adapter
refactor; no text-to-video change. No credentials were read, printed, copied or
modified; no environment or production setting was altered. Existing untracked recon
docs and gitignored project data were left untouched. This pilot is complete; no
follow-up work was started.
