# P39 - FAL.ai Queue URL Resolution Fix

Status: IMPLEMENTED. The FAL adapter now resolves the queue resource path from
the URLs FAL returns on submit, instead of assuming the model id equals the queue
path. **No real FAL request was made, no credential was read, and no FAL credit
was spent.**

Baseline: branch `main`, HEAD `4576ca0e0cd841f6f004b5ba47f2635fcb560dad`
(`feat(video): add FAL.ai video generation provider`) == `origin/main`.

## 1. Repository state

- Verified branch `main`, HEAD `4576ca0`, working tree clean apart from the
  intentionally untracked recon docs (`p29*`, `p29.2*`, `p31*`, `p33*`, `p35*`,
  `p37*`, `p38*`), left untouched.
- No `.gitmodules` (no submodules). Gitignored `projects/` output untouched.

## 2. Root cause (from P38)

The adapter built status/result/cancel URLs by appending `/requests/{id}/...` to
the **full** model id:

```
https://queue.fal.run/minimax/h3-max-turbo/text-to-video/requests/{id}/status  -> HTTP 405
```

FAL's real queue resource for this model drops the endpoint sub-path:

```
https://queue.fal.run/minimax/h3-max-turbo/requests/{id}/status                -> HTTP 200
```

The submit response already carries the authoritative URLs (`response_url`,
`status_url`, `cancel_url`); the adapter discarded them and re-derived the URL,
so polling/download/cancel could never succeed for a multi-segment model id even
though the paid job itself ran and completed.

## 3. Fix

Changed: `lib/ai/video-generation/fal-provider.ts`.

1. **New `resolveQueuePath(requestId, candidates, baseUrl)` resolver.** It reads
   the `response_url` / `status_url` / `cancel_url` returned by submit and takes
   the path segment(s) before the `/requests/{requestId}` marker as the queue
   resource path. A candidate is trusted only if it is an absolute URL whose
   protocol **and** host match the configured queue origin
   (`FAL_VIDEO_BASE_URL`, default `https://queue.fal.run`) and whose path contains
   this request's `/requests/{id}` marker; the extracted path must also match the
   existing anchored `ENDPOINT_PATTERN`. Otherwise it is ignored.
2. **Submit prefers the returned URLs.** `submit` now reads `response_url`,
   `status_url`, `cancel_url` from the response and encodes the resolved queue
   path into the job id; if none is usable it falls back to the submitted
   endpoint (unchanged legacy behaviour).
3. **Status/result/cancel use the queue path.** `getStatus`, `download` and
   `cancel` rebuild `{base}/{queuePath}/requests/{id}[/status|cancel]` from the
   durable job id, so submit, poll, download, cancel and resume all share the same
   queue identity.
4. **Comment/contract updated** to document that the model id and queue path are
   not always identical.

## 4. Job-id compatibility

The job-id string format is unchanged: `fal:{queuePath}:{request_id}` (was
`fal:{endpoint}:{request_id}`). Only the meaning of the middle segment is now
"queue resource path"; for a two-segment app id it is identical to the model id.
`decodeFalJobId` still parses old-format ids and raw request ids exactly as
before, so existing ids keep their previous behaviour (for a pre-fix multi-segment
id the middle segment is the full model id, i.e. the old, un-pollable behaviour).
New submissions always carry the validated queue path. `download` metadata now
reports `queuePath` instead of `endpoint`.

## 5. Security

- A returned URL is used **only** to learn the queue path; no request is ever sent
  to a returned host. URLs on a foreign host, with a different protocol, or without
  the matching `/requests/{id}` marker are ignored.
- The `FAL_KEY` is only ever attached to requests against the configured
  `baseUrl`; the media download still omits the `Authorization` header.
- Tests assert no request reaches a foreign host and the key does not leak.

## 6. Tests

Added to `tests/fal-video-provider.test.ts` (all fixture/mock based, injected
`fetch`, no live requests):

1. Multi-segment model `minimax/h3-max-turbo/text-to-video`: queue path derived
   from the response, status URL drops the sub-path, no `text-to-video/requests`
   URL is ever used.
2. Status/result URL resolution and download from the resolved queue path.
3. Preference for the validated `response_url` while a foreign-hosted
   `status_url` is ignored.
4. Fallback to the submitted endpoint when no response URL is usable, and only the
   configured host is contacted.
5. Poll and download after a fresh provider instance is reconstructed from the job
   id (resume).
6. Cancel URL resolution through the queue path.
7. Rejection of unexpected-host URLs (no key sent off-host).
8. Backward compatibility: legacy `fal:{endpoint}:{request_id}` and raw ids still
   decode as before.

Existing FAL tests were updated for the `queuePath` field rename. The service and
storage-integration tests continue to pass unchanged (their submit responses omit
URLs, so they exercise the endpoint fallback).

## 7. Verification

- `npx tsc --noEmit` -> clean.
- `npm run lint` -> clean (`No ESLint warnings or errors`).
- `npm run build` -> succeeded.
- `npx vitest run` -> **81 files / 552 tests passed** (baseline 546; +6).
- Targeted run: `tests/fal-video-provider.test.ts`,
  `tests/fal-video-service.test.ts`, `tests/fal-video-storage.integration.test.ts`
  -> 28 tests passed (the storage integration used a local FFmpeg fixture only).

## 8. Out of scope (respected)

No image-to-video/start-frame support, no new provider or job architecture, no
second real FAL request, no changes to music/TTS/image generation/compositor. No
other paid tests.

## 9. Confirmation

No real FAL.ai request was executed and no FAL credit was consumed during this
phase; all verification used injected fetch mocks and a local FFmpeg fixture. The
API key was never read, printed or logged. Existing untracked recon docs and the
gitignored `projects/` output were left untouched.
