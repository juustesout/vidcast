# P38 - FAL.ai Real-Provider Smoke Test (Phase A)

Status: EXECUTED. Exactly **one** paid FAL submit was made. No production code was
changed, nothing was committed or pushed. Estimated spend ~$0.13 against a $1 cap.
The existing untracked recon docs were left untouched.

Outcome: the FAL job itself **succeeded** (queued -> COMPLETED, a valid 5.18 s H.264
MP4 downloaded and stored through the real media store, full FFmpeg decode OK).
However, the initial polling loop failed because of a **real adapter bug** in the
queue URL construction for multi-segment endpoints; the job was recovered manually
via the known request id. Details in sections 4 and 7.

---

## 1. Repository state

- Branch `main`, HEAD `4576ca0e0cd841f6f004b5ba47f2635fcb560dad`
  (`feat(video): add FAL.ai video generation provider`), equal to `origin/main`.
- Working tree clean except the intentionally untracked recon docs
  (`p29`, `p29.2`, `p31`, `p33`, `p35`, `p37`); no production file was modified.
- FAL credentials: `FAL_KEY` present in `/workspace/.env` (existence-only; the value
  was never read into the report, printed or logged). Length reported only as
  `<set:72 chars>`.
- Real-mode configuration confirmed: `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true`,
  `FAL_VIDEO_*` overrides unset (defaults used).

## 2. Authorization and limits

Authorized by the user (Phase A from P37): maximum **1 paid submit**, hard budget
**$1**, model `minimax/h3-max-turbo/text-to-video`, 5 s, no second submit, no
automatic retry, no alternative paid generation. All honored.

## 3. Preflight (no provider request)

- Re-verified the official endpoint schema and price this session:
  - Schema: `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max-turbo/text-to-video`
  - Pricing: `https://fal.ai/pricing` -> `minimax/h3-max-turbo/text-to-video`
    = **$0.025 / second** (40 s per $1).
- Policy enforcement through the existing chain:
  `resolveManualGenerationProvider('video', 'fal', {})` resolved to
  `mode: real`, `provider: fal`; `getVideoGenerationConfigurationStatus().falConfigured
  = true`. Real mode requires `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS` + `FAL_KEY`
  (`lib/production/run-policy.ts:369-370`, `:520-522`).
- Request shape validated: endpoint `minimax/h3-max-turbo/text-to-video`, prompt
  (safe landscape scene), `aspect_ratio: 16:9`, `duration: 5`, no references, no
  `FAL_VIDEO_*` overrides (so `prompt_expansion_mode: disabled`, model-default
  `768P`, `enable_safety_checker` default true).
- Cost check: 5 s x $0.025/s = $0.125 (actual output 5.18 s -> ~$0.13), well under
  the $1 cap.

## 4. The single request

- Submit: `POST https://queue.fal.run/minimax/h3-max-turbo/text-to-video`
  (through `FalVideoGenerationProvider.submit`, the existing adapter/policy chain).
- Response: `request_id = 01a13236-2752-7471-afe6-f0fd68a57b47`, immediate status
  `IN_QUEUE` (`queued`).
- Composite job id persisted: `fal:minimax/h3-max-turbo/text-to-video:01a13236-2752-7471-afe6-f0fd68a57b47`.
- An idempotency lock (`/tmp/opencode/p38-submit-lock.json`) was written right after
  submit so any rerun would refuse to submit again.

Status flow:

| Step | Result |
| --- | --- |
| submit | `IN_QUEUE` / `queued` |
| poll via adapter | **failed** every attempt: `FAL video generation request failed.` (see section 7) |
| manual resume (correct URL) | `COMPLETED`; `metrics.inference_time = 2.207 s`; `timings.inference = 1.355 s` |

The manual polling loop was stopped (no resubmit); the existing task was recovered
using the known request id, which is explicitly permitted by the task.

## 5. Result, storage and validation

- FAL result: `video.url = https://v3b.fal.media/files/b/0aae22f9/fmjZvdGcOe-Xzz1qotAMN_minimax-h3.mp4`,
  `content_type = video/mp4`, `file_size = 3354013`.
- Downloaded 3354013 bytes (exact match) **without sending the API key** to the
  media host, then persisted through the real
  `mediaStore.saveGeneratedVideo` (`lib/storage/media-store.ts:312`).
- Stored asset:
  - project: `p38-fal-smoke-mv5tpir1`
  - path: `projects/p38-fal-smoke-mv5tpir1/assets/scene-01-generated-p38-attempt-1.mp4`
    (`projects/` is gitignored)
  - asset id: `asset_f57f1d74-b12a-4a66-b2b0-f1681b019d08`
  - type `video`, status `available`, provenance `generated`, mimeType `video/mp4`
  - filesize `3354013`, duration `5.184`
  - `metadata.providerJobId` = `fal:minimax/h3-max-turbo/text-to-video:01a13236-...`,
    `metadata.providerRequestId` = `01a13236-2752-7471-afe6-f0fd68a57b47`.

FFprobe (stored file):

- Video: `h264` (Constrained Baseline, `avc1`), **1344x768**, `yuv420p`,
  `24 fps`, 124 frames, duration `5.166667 s`, ~4.97 Mbps.
- Audio: `aac` LC, 32000 Hz, stereo, duration `5.184 s`.
- Container: `mov,mp4,...`, duration `5.184 s`, size 3354013.

FFmpeg decode test: `ffmpeg -v error -i <file> -f null -` -> **DECODE_OK** (full
decode, no errors).

## 6. Cost

- Estimated: requested 5 s -> ~$0.125; actual output 5.18 s -> **~$0.13** at the
  official $0.025/s rate. Comfortably under the $1 cap.
- **Not independently verified.** The actual charge could not be confirmed from a
  response body, invoice or FAL usage overview within this run, so the figure above
  is the reported estimate, not a verified charge. No cost number is invented.

## 7. Findings, errors and uncertainties

1. **Adapter bug (main finding): wrong queue path for multi-segment endpoints.**
   The adapter builds status/result/cancel URLs by appending
   `/requests/{id}/status` to the **full** model endpoint, producing
   `https://queue.fal.run/minimax/h3-max-turbo/text-to-video/requests/{id}/status`,
   which FAL rejects with **HTTP 405** (`allow: POST`). FAL's actual queue resource
   path drops the sub-path:
   `https://queue.fal.run/minimax/h3-max-turbo/requests/{id}/status` -> **HTTP 200**
   (`minimax/h3-max-turbo` is the app; `text-to-video` is the in-app endpoint path).
   The submit response already returns the correct `status_url`, `response_url`
   (`.../minimax/h3-max-turbo/requests/{id}`) and `cancel_url`, but the adapter
   discards them and re-derives the URL. Consequence: although the paid job ran and
   completed, polling/download/cancel through the adapter cannot work for this
   endpoint as-is. This directly contradicts the P36 assumption that the endpoint
   path is part of the queue path and should be fixed in a follow-up (store/use the
   returned URLs, or derive the app path from them). **No production code was
   changed in P38**, per instruction.
2. **Aspect ratio not exactly 16:9.** Requested `aspect_ratio: 16:9`, but the model
   produced **1344x768** (1.75:1), not 1.7778:1. Treat requested aspect as
   approximate for this model.
3. **Cost not verifiable** (see section 6).
4. The initial failure surfaced as the generic `PROVIDER_FAILED` message; the raw
   HTTP status (405) was only visible by inspecting the response directly. The
   adapter maps 4xx to `PROVIDER_REJECTED`/`PROVIDER_AUTH` but the message is the
   same fallback text, which made the first diagnosis slow.
5. Media URLs expire; the result was downloaded promptly (same session).

## 8. Confirmation

- Exactly **one** paid submit was made (FAL request id `01a13236-...`).
- **No second submit, no automatic retry, and no other paid generation** occurred.
  The polling failures triggered no resubmission; the existing job was resumed by
  request id only.
- No production code was modified, no commit and no push were made. Untracked recon
  docs were left untouched.
- The API key was never read into, printed in, or logged by the report; it was sent
  only to `queue.fal.run`.

## 9. Recommended next steps

1. Fix the adapter URL handling for multi-segment endpoints (use the `status_url` /
   `response_url` / `cancel_url` returned by submit, or construct the correct
   `{owner}/{app}/requests/{id}` path), with unit tests for a `owner/app/endpoint`
   model id. This is a code change and therefore outside P38's scope.
2. Optionally re-run a single smoke **after** that fix to confirm the adapter's own
   poll -> download -> store path works end-to-end (still 1 submit, <= $1).
3. Then proceed with the image-to-video start/end-frame work from P37 (Phase B).
