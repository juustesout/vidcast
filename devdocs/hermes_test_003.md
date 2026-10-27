# hermes_test_003.md - Stock-photo digest video (Hermes / MCP)

Status: ready to run
Owner: Hermes (MCP client agent)
Scope: build a ~3-minute "This Week in Dev & AI" digest **video** end-to-end on a
local desktop install of the Explainer app, using **real royalty-free stock photos
from Pixabay or Unsplash** (preferred, free) with **text overlays**, optional
**AI fallback images**, optional **narration**, optional **background music**, then
FFmpeg **render + compose** into one MP4. Cost is kept as low as possible: the
default plan is **stock-only and $0**; every paid step is called out explicitly.

This is a runnable runbook. Follow the steps in order. Record the exact values you
observe (ids, statuses, codes) - do not paraphrase.

> Important reality check: the app's stock pipeline supports **stock photos**, not
> stock video clips. Pixabay/Unsplash clips are **not** a supported source. The
> "video" is produced by rendering stock photos with motion (Ken Burns style) plus
> overlays and (optionally) narration. There is no stock-video-clip action.

---

## 0. At a glance

| # | Stage | Paid calls | Primary tools |
| --- | --- | --- | --- |
| A | Create + author a 12-scene / 180 s digest | No | `create_project`, `update_project` |
| B | Validate + inspect the plan | No | `get_validation_report`, `get_production_plan` |
| C | (optional) Background music | **Yes** in real mode | `manage_project_music` |
| D | Run the digest (stock photos + overlays [+ narration]) | Stock = free; narration = **paid** | `run_production`, `get_run_status`, `get_run_log` |
| E | Fetch + verify the MP4 | No | `get_project_compositions` + HTTP GET |
| F | (optional) Manually curate weak stock matches | No (re-render is free) | REST `stock/search` + `select-stock-image` |
| G | (optional) AI-image fallback for a weak scene | **Yes** (~$0.04-0.06/image) | `update_project` then re-run |

Default recipe for "$0 silent digest": A, B, D (stock only, **no** narration text,
**no** music, **no** AI images), E. See section 3.

---

## 1. What this proves / feature stack exercised

1. A stock-photo scene (`visual.kind = "stock_image"`) is resolved by the server-side
   stock router at production time and rendered to a real MP4 frame.
2. The full authoring stack is used: per-scene **duration**, **motion**, **transition**,
   **text overlay**, and per-scene **narration**.
3. The run is durable and observable: status polling, structured log, composition
   artifact, authenticated download.
4. Manual curation (pick a specific photo) is possible through the REST stock routes
   and survives a forced re-render.

Feature stack (what the app supports today):

- **Visuals**: `stock_image` (Pixabay/Unsplash/Pexels), `generated_image` (OpenAI),
  `generated_video` (OpenAI/FAL), `graphic`, `text`, `blank`, `asset`.
- **Motion presets**: `none | zoom_in | zoom_out | pan_left | pan_right | pan_up |
  pan_down | zoom_left | zoom_right`.
- **Transitions**: `none | fade | crossfade`.
- **Overlay types**: `none | text | title | subtitle | callout | statistic | quote`.
- **Narration**: per scene (`scene.narration.text`), real provider = ElevenLabs.
- **Music**: project-level, opt-in, real provider = ElevenLabs (paid).
- **Render/compose**: local FFmpeg.

---

## 2. Preconditions and environment

| Item | Value |
| --- | --- |
| Repo root | `/workspace` (adjust to your checkout) |
| App | Next.js dev server, `http://localhost:3000` (API on the **same** port, `/api/*`) |
| MCP server | **one** stdio server, entrypoint `mcp/read-only/server.ts`; start via `npm run mcp:local` |
| Auth | `Authorization: Bearer <EXPLAINER_API_TOKEN>` |
| Minimum Node | the version in `package.json` (tested with Node 22) |

### 2.1 FFmpeg is a hard prerequisite

```bash
ffmpeg -version
ffprobe -version
```

Both must print a version. If they are not on `PATH`, set `FFMPEG_PATH` /
`FFPROBE_PATH` when launching the app. `FFMPEG_UNAVAILABLE` in the run log means
FFmpeg was not found by the server process.

### 2.2 Start the app and the MCP server

```bash
# Terminal 1 - app
npm run dev

# Warm the routes once so no dev-mode compile happens mid-run:
curl -s -o /dev/null -H "Authorization: Bearer $EXPLAINER_API_TOKEN" http://localhost:3000/api/projects
```

```bash
# Terminal 2 - MCP server (stdio). Hermes normally launches this from its config.
export EXPLAINER_API_BASE_URL="http://localhost:3000"
export EXPLAINER_API_TOKEN="<same value as the app's EXPLAINER_API_TOKEN>"
npm run mcp:local
```

Point Hermes at it over stdio (see `docs/hermes-mcp-manual.md` section 3). Tool
names below are shown unprefixed; a client that prefixes the server shows them as
e.g. `mcp_explainer_local_run_production`.

### 2.3 Response envelope

Every tool returns:

```json
{ "ok": true, "data": { ... } }
```

```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "...", "details": { ... } } }
```

React on `error.code`, not on message text. Failed calls also set `isError: true`.

### 2.4 Real-provider / stock configuration (app-side, in `.env`)

Stock photos are **real** only when the server is in real-provider mode; mock mode
locks stock to the local `fake` provider. To use Pixabay/Unsplash you need:

```bash
# Real-provider mode (server-side)
PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true
PRODUCTION_RUN_DEFAULT_MODE=real

# Stock provider credentials (at least one; set only the ones you have)
PIXABAY_API_KEY=<key>          # provider id: pixabay  (100 req / 60 s)
UNSPLASH_ACCESS_KEY=<key>      # provider id: unsplash (50 req / hour, hotlink)
PEXELS_API_KEY=<key>           # provider id: pexels   (200 req / hour) - optional

# Optional: force the provider order (default: unsplash,pexels,pixabay).
# The router skips unconfigured / rate-limited providers and falls through.
STOCK_IMAGE_PROVIDER_ORDER=pixabay,unsplash
```

Notes:

- **Unsplash** uses `UNSPLASH_ACCESS_KEY` (a `UNSPLASH_APP_ID` / `UNSPLASH_PUBLIC_KEY`
  alone is **not** enough). Unsplash is a **hotlink** provider: the app references
  the CDN URL at render time and does not store a copy.
- **Pixabay** is a **download** provider: the app downloads and stores a durable
  asset. Pixabay forbids permanent hotlinking, so it must be downloaded.
- If a needed modality's credentials are missing you get `PROVIDER_NOT_CONFIGURED`
  (or the provider is simply skipped by the router).

Narration / AI-image / music credentials (only if you use those steps):

```bash
ELEVENLABS_API_KEY=<key>       # real narration + music
TTS_DEFAULT_VOICE_ID=<voice>   # optional narration voice
OPENAI_API_KEY=<key>           # AI image fallback
OPENAI_IMAGE_MODEL=dall-e-3    # default is gpt-image-1; dall-e-3 is cheaper/known-good
```

### 2.5 Ownership of MCP-created projects (claim)

A project created through the MCP bearer token is **ownerless**. The
`create_project` response also returns a single-use `claimToken`. To open/edit it
in the browser, claim it out-of-band:

```bash
# POST /api/projects/{id}/claim  with {"token":"<claimToken>"} in the BODY
# (never put the token in a URL, log or analytics event)
```

For a purely headless Hermes run you can ignore the claim and keep driving the
project through the same MCP session.

---

## 3. Cost model (keep it down)

| Item | Cost | Notes |
| --- | --- | --- |
| Stock photo (Pixabay/Unsplash/Pexels) | **$0** | Free tiers; quota-limited (`RATE_LIMITED` when exceeded) |
| FFmpeg render + compose | **$0** | Local CPU only |
| Text overlays, motion, transitions | **$0** | Rendered locally |
| AI image fallback (OpenAI `dall-e-3` / `gpt-image-1`) | ~**$0.04-$0.06 / image** | Assumption; verify current OpenAI pricing. Only for scenes stock cannot satisfy |
| Narration (ElevenLabs TTS) | **paid** | Metered per character/time; keep copy short (see 2.4/5.4) |
| Background music (ElevenLabs) | **paid** | Optional; skip for the cheap recipe |

Recommended recipes:

- **$0 silent digest (cheapest)** - stock photos + overlays only; **no** narration,
  **no** music, **no** AI images. See the caveat in 5.4 about the run status.
- **$0 + voice** - the same, plus real narration (ElevenLabs). Cost = narration only.
- **+ quality fill** - add a handful of AI images only for the 1-2 scenes where no
  stock match is acceptable, at ~$0.04-0.06 each.

---

## 4. Mode rules for stock (read this before running)

- **Real mode is required for real stock photos.** `mode: "mock"` locks
  `stock_select` to the local `fake` provider, so you would get synthetic frames.
- `stock_select` is **not** an "image generation" modality, so a real run does not
  need the `openai` image provider: a stock-only digest needs **no** `OPENAI_API_KEY`.
- Only the modalities actually in the plan are validated:
  - stock-only (no narration) -> no paid credentials needed at all;
  - stock + narration -> `ELEVENLABS_API_KEY` required (real mode forces a real
    narration provider);
  - stock + an AI fallback scene -> `OPENAI_API_KEY` required.
- Real mode needs `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true` on the app or every
  run returns `POLICY_DENIED`.

---

## 5. Authoring the 3-minute digest

Target: **12 scenes x 15 s = 180 s (3:00)**, 1920x1080 (16:9), 30 fps.

### 5.1 Create the project

```jsonc
// tool: create_project
{ "title": "This Week in Dev & AI - digest", "description": "3-minute weekly dev & AI digest",
  "durationTarget": 180, "aspectRatio": "16:9", "fps": 30 }
// -> data.projectId  (call it PROJECT_D). create_project seeds one default scene; 5.2 replaces it.
```

### 5.2 Scene plan (replace the story content with the week's real stories)

The `scenes` array is **replaced wholesale**, so send complete scene objects.

| # | Stock query (orientation `landscape`) | Motion | Overlay type | Overlay text (example) |
| --- | --- | --- | --- | --- |
| 1 | `abstract technology network blue` | zoom_in | title | This Week in Dev & AI |
| 2 | `server racks data center blue light` | pan_left | title | Open-weight models keep climbing |
| 3 | `graphic designer laptop screen workspace` | zoom_out | statistic | 60% faster edits |
| 4 | `fiber optic network cables` | pan_right | title | Internet infrastructure gets sturdier |
| 5 | `developer coding screen night` | zoom_in | quote | Ship small, ship often. |
| 6 | `data center server room` | pan_left | title | Compute costs under pressure |
| 7 | `robot arm laboratory` | zoom_out | title | Robotics meets foundation models |
| 8 | `smartphone app developer` | pan_right | callout | On-device AI |
| 9 | `open source code collaboration` | zoom_in | statistic | New OSS release |
| 10 | `cybersecurity lock code screen` | pan_left | title | Security patch roundup |
| 11 | `calendar planning desk` | zoom_out | title | What to watch next week |
| 12 | `sunrise city skyline timelapse` | zoom_in | title | Thanks for watching |

> Replace query text and overlay/narration copy with the stories you actually want
> to publish. Do **not** assert numbers you have not verified; use a `title`,
> `quote` or `callout` overlay instead of `statistic` when there is no real figure.

### 5.3 Complete `update_project` example (scenes 1-3 shown; repeat the pattern)

```jsonc
// tool: update_project
{
  "projectId": "<PROJECT_D>",
  "project": {
    "scenes": [
      {
        "id": "scene-1",
        "order": 1,
        "duration": 15,
        "type": "image",
        "visual": { "kind": "stock_image", "query": "abstract technology network blue", "orientation": "landscape", "preferredProviders": ["pixabay", "unsplash"] },
        "narration": { "text": "Welcome back. Here are ten developer and AI stories from this week, in three minutes." },
        "overlay": { "type": "title", "text": "This Week in Dev & AI", "position": "top", "style": { "fontSize": 84, "color": "#f8fafc", "box": true, "margin": 64 }, "timing": { "fadeInSeconds": 0.5, "fadeOutSeconds": 0.4 } },
        "render": { "motion": { "preset": "zoom_in" }, "transition": { "type": "fade" } },
        "referenceIds": [],
        "notes": ""
      },
      {
        "id": "scene-2",
        "order": 2,
        "duration": 15,
        "type": "image",
        "visual": { "kind": "stock_image", "query": "server racks data center blue light", "orientation": "landscape", "preferredProviders": ["pixabay", "unsplash"] },
        "narration": { "text": "Open-weight language models closed more of the gap with closed models this week, and new releases keep arriving." },
        "overlay": { "type": "title", "text": "Open-weight models keep climbing", "position": "bottom", "style": { "fontSize": 64, "color": "#ffffff", "box": true, "margin": 56 }, "timing": { "fadeInSeconds": 0.4, "fadeOutSeconds": 0.3 } },
        "render": { "motion": { "preset": "pan_left" }, "transition": { "type": "fade" } },
        "referenceIds": [],
        "notes": ""
      },
      {
        "id": "scene-3",
        "order": 3,
        "duration": 15,
        "type": "image",
        "visual": { "kind": "stock_image", "query": "graphic designer laptop screen workspace", "orientation": "landscape" },
        "narration": { "text": "Image and video editing tools added faster, cheaper editing workflows powered by generative models." },
        "overlay": { "type": "statistic", "text": "60% faster edits", "position": "center", "style": { "fontSize": 120, "color": "#fde047", "box": true, "margin": 48 } },
        "render": { "motion": { "preset": "zoom_out" }, "transition": { "type": "fade" } },
        "referenceIds": [],
        "notes": ""
      }
      // ... scenes 4-12 follow the same shape (order 4..12, ids "scene-4".."scene-12")
    ]
  }
}
// expect: ok:true, data.valid:true
```

### 5.4 Text overlays - the rules that matter

- The overlay only renders when `type != "none"` **and** `text` is non-blank.
- `type`: `"none" | "text" | "title" | "subtitle" | "callout" | "statistic" | "quote"`.
  - `title` -> default position `top` (great for a scene headline)
  - `statistic` / `quote` -> default `center` (great for numbers/quotes)
  - `subtitle` / `callout` / `text` -> default `bottom`
- `position` (optional): `top | center | bottom`.
- `style` (optional): `fontSize` (24-220), `color` (hex `#rgb`/`#rrggbb`, `0xrrggbb`,
  or FFmpeg names like `white` / `black@0.45`), `box` (boolean background plate),
  `margin` (16-240). Out-of-range values are rejected (`VALIDATION_FAILED`), not clamped.
- `timing` (optional): `fadeInSeconds` / `fadeOutSeconds` (0-600, clamped to the
  scene duration at render time).
- **Do not** add an overlay to a `text` scene (its whole frame is authored copy).
- Changing any overlay field changes the scene render fingerprint -> the scene is
  re-rendered by the next run.

### 5.5 Narration is per scene (`scene.narration.text`)

- There is **no** project-level narration fallback for production. Write it per scene.
- Keep each line short enough to fit its scene: a TTS clip **longer than the scene
  duration fails** with `narration.invalid` ("Narration duration (x s) exceeds scene
  duration"). For a 15 s scene aim for **~30-36 words**.
- **$0 caveat (important):** if you omit narration on **all** scenes, the planner
  still schedules a `narration_generate` action per scene; with no text it is
  `blocked`, so the run's terminal status becomes **`unresolved`** even though the
  scenes render and the final composition is produced (verified: a no-narration
  run ended `unresolved` with `summary.completed = 2` and a written composition).
  For a clean `completed` status, give **every** scene narration text (real mode ->
  ElevenLabs -> paid), or accept `unresolved` and read the composition anyway.

---

## 6. Validate + inspect before running

```jsonc
// tool: get_validation_report
{ "projectId": "<PROJECT_D>" }   // expect valid:true, errors:[]

// tool: get_production_plan
{ "projectId": "<PROJECT_D>" }
// expect per scene: stock_select + narration_generate + scene_render (status ready/current),
// and a single final_compose waiting on the renders.
```

> A stock scene with an empty `query` is `blocked` (`Stock search query is
> required.`). A scene with empty narration leaves `narration_generate` `blocked`.

---

## 7. (optional) Background music - paid in real mode

```jsonc
// tool: manage_project_music   (generate is an EXPLICIT PAID action in real mode)
{ "projectId": "<PROJECT_D>", "action": "generate",
  "prompt": "calm minimal tech underscore, no drums, sparse piano", "musicLengthMs": 185000,
  "instrumental": true, "mode": "real" }
// -> on success the track is attached; it is mixed during final compose.
```

Skip this entirely for the cheapest recipe (no music == no music provider call).

---

## 8. Run the digest

Real mode, stock + overlays (+ narration if you set narration text):

```jsonc
// tool: run_production
{
  "projectId": "<PROJECT_D>",
  "mode": "real",
  "providers": { "narration": "elevenlabs" },   // omit this line for the $0 silent recipe
  "force": true,
  "maxIterations": 200,
  "limits": { "narration_generate": 3, "scene_render": 1, "final_compose": 1 }
}
// expect: ok:true, data.reused:false, data.run.status:"queued"|"running", data.run.runId -> RUN_D
```

Notes:

- `limits` are **per action type** and keep the local 2-CPU host healthy:
  `scene_render: 1` avoids FFmpeg contention; `narration_generate: 3` matches the
  ElevenLabs concurrent-request ceiling (the server also enforces a provider cap of
  3, so never set it higher).
- The MCP `limits` schema exposes only `image_generate`, `video_submit`,
  `video_poll`, `narration_generate`, `scene_render`, `final_compose`. **Stock
  concurrency is not a `limits` key**; it is controlled server-side by
  `PRODUCTION_RUN_CONCURRENCY_STOCK` (default 2). Any `stock_select` key sent to
  `run_production` is ignored.
- `force: true` regenerates current outputs once (useful after curation or first run).
- A stock-only run with **no** narration text needs no paid credentials; it still
  ends `unresolved` (see 5.5), which is expected.

Poll to terminal (`completed | partial | failed | unresolved`):

```jsonc
// tool: get_run_status  (every ~2-3 s)
{ "runId": "<RUN_D>" }
// walk queued -> running -> terminal
// expect summary.failed = 0; summary.completed grows to ~ (scenes + renders + compose)
```

Read the structured log:

```jsonc
// tool: get_run_log
{ "runId": "<RUN_D>", "cursor": 0, "limit": 100 }
// expect: run_started, plan_created, action_scheduled/started/completed (stock_select,
// narration_generate, scene_render ...), composition_started/composition_completed, run_completed
// use data.log.nextCursor / data.log.hasMore to page
```

If a `stock_select` failed (`stock.download.failed` / `stock.routing.failed`), see
sections 10 and 12. Pixabay's CDN rate-limits by IP on short bursts; the download
path retries with bounded back-off and de-duplicates concurrent downloads, and a
persistent failure surfaces a clear error (never a silent bad frame).

---

## 9. Fetch + verify the MP4

```jsonc
// tool: get_project_compositions
{ "projectId": "<PROJECT_D>" }
// expect data.available:true, data.latest.downloadPath
//   downloadPath = /api/projects/{id}/compositions/{compositionId}/file
//   plus duration, width, height, fps, sceneCount, filesize
```

```bash
# MP4 bytes are never an MCP payload: plain authenticated HTTP GET.
curl -s -o /tmp/opencode/hermes_test_003.mp4 \
  -H "Authorization: Bearer $EXPLAINER_API_TOKEN" \
  "http://localhost:3000<downloadPath>"

ffprobe -v error -show_entries format=format_name,duration,bit_rate -of default=nw=1 /tmp/opencode/hermes_test_003.mp4
ffmpeg -v error -i /tmp/opencode/hermes_test_003.mp4 -f null -     # exit 0, no output
```

Pass criteria: run terminal status `completed` (or `unresolved` only in the
no-narration recipe, with a composition still present); MP4 exists; `ffprobe`
reports a container + a video stream; full decode exits 0; duration ~180 s.

---

## 10. (optional) Manually curate weak stock matches

Auto-selection is deterministic and cached per `query + orientation`. To replace a
scene's photo, use the REST stock routes (they are **not** MCP tools), then force a
re-render. The client only ever passes `searchId` + `photoId`; no arbitrary URL.

```bash
# 1) search (mints a server-side searchId; candidates stay server-side)
curl -s -H "Authorization: Bearer $EXPLAINER_API_TOKEN" \
  "http://localhost:3000/api/projects/<PROJECT_D>/stock/search?query=binary%20code%20screen&orientation=landscape" \
  | jq '{searchId, results: [.results[] | {provider, photoId: .id, photographerName, previewUrl}]}'
```

```bash
# 2) choose a candidate for the scene (note: photoId, not a URL)
curl -s -X POST -H "Authorization: Bearer $EXPLAINER_API_TOKEN" -H "content-type: application/json" \
  -d '{"action":"choose","searchId":"<searchId>","photoId":"<photoId>","query":"binary code screen","orientation":"landscape"}' \
  "http://localhost:3000/api/projects/<PROJECT_D>/scenes/<sceneId>/select-stock-image"
# -> selected; a manual selection (origin:"manual") is PINNED and never swapped by a forced run
```

Then re-run affected scenes (a forced run re-renders only stale/changed scenes and
re-composes):

```jsonc
// tool: run_production
{ "projectId": "<PROJECT_D>", "mode": "real", "providers": { "narration": "elevenlabs" },
  "force": true, "limits": { "narration_generate": 3, "scene_render": 1, "final_compose": 1 } }
```

Search/select codes: `stock.search.expired` (re-search), `stock.download.failed`
(bounded retry then clear error), `stock.provider.notAllowed`, `stock.scene.missingQuery`.

---

## 11. Using Unsplash specifically

- Set `UNSPLASH_ACCESS_KEY=<key>` and either list `unsplash` first in
  `STOCK_IMAGE_PROVIDER_ORDER` or set `preferredProviders: ["unsplash"]` on the scene.
- Unsplash is **hotlink** policy: the app references the CDN URL at render time and
  does **not** store a copy. Rendering therefore needs outbound network access.
- Unsplash quota is small (~50 requests/hour); use `preferredProviders` + caching to
  stay under it. When it is exhausted the router falls through to the next provider.

---

## 12. (optional) AI-image fallback for a weak scene

Only when stock cannot satisfy a scene, and you accept the cost (~$0.04-0.06/image).
Switch just that scene to a generated image:

```jsonc
// tool: update_project  (send the WHOLE scenes array; this example changes scene-7 only)
{
  "projectId": "<PROJECT_D>",
  "project": {
    "scenes": [
      /* ... scenes 1-6 unchanged ... */
      {
        "id": "scene-7", "order": 7, "duration": 15, "type": "image",
        "visual": { "kind": "generated_image",
          "generation": { "kind": "image", "status": "planned", "provider": "openai",
                          "model": "dall-e-3", "prompt": "A friendly humanoid robot arm assembling a circuit board, clean studio lighting, photorealistic, 16:9" } },
        "narration": { "text": "Robotics researchers are pairing foundation models with real hardware to generalise manipulation tasks." },
        "overlay": { "type": "title", "text": "Robotics meets foundation models", "position": "bottom" },
        "render": { "motion": { "preset": "zoom_out" }, "transition": { "type": "fade" } },
        "referenceIds": [],
        "notes": ""
      }
      /* ... scenes 8-12 unchanged ... */
    ]
  }
}
```

Then run with a real image provider (required because the plan now has
`image_generate`):

```jsonc
// tool: run_production
{ "projectId": "<PROJECT_D>", "mode": "real", "providers": { "image": "openai", "narration": "elevenlabs" },
  "force": true, "limits": { "image_generate": 1, "narration_generate": 3, "scene_render": 1, "final_compose": 1 } }
```

Model notes: default is `gpt-image-1`; if your org is not verified you may get
`provider.request.unauthorized` / `provider.request.rejected` -> use `dall-e-3`
(set `OPENAI_IMAGE_MODEL=dall-e-3` or per-scene `visual.generation.model`).

---

## 13. Evidence checklist

| Field | Stage | Value |
| --- | --- | --- |
| `PROJECT_D` id | A | |
| first scene `stock_query` + resolved `selection.provider`/`photoId` | D | |
| `RUN_D` id + terminal status | D | |
| `RUN_D` `summary` + `completedActionIds.length` | D | |
| `action_failed` codes (if any) | D | |
| `downloadPath` + `duration` + `filesize` | E | |
| `ffprobe` output + full-decode exit code | E | |
| curated `searchId`/`photoId` + pinned `origin:"manual"` | F | |
| AI fallback cost (images generated) | G | |

Report format: one short table of observed values, a pass/fail line per stage, then
any deviations with the exact error `code` and HTTP status. Do **not** claim a pass
for a stage you did not execute.

---

## 14. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `API_UNAVAILABLE` on every call | MCP pointed at the wrong port | `EXPLAINER_API_BASE_URL=http://localhost:3000` (MCP default is 5555) |
| `UNAUTHENTICATED` on every call | token mismatch | app and MCP must share the same `EXPLAINER_API_TOKEN` |
| Run returns `POLICY_DENIED` | real mode disabled | set `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true` and restart the app |
| `PROVIDER_NOT_CONFIGURED` on narration | real mode needs a real narration provider | set `ELEVENLABS_API_KEY` or remove narration text (`$0` recipe) |
| Stock frames look synthetic/fake | run was `mode:"mock"` | use `mode:"real"` |
| `stock.routing.failed` / `ALL_PROVIDERS_FAILED` | no configured provider / all rate-limited | set `PIXABAY_API_KEY`/`UNSPLASH_ACCESS_KEY`, lower request rate, retry |
| `stock.download.failed` (429) | Pixabay CDN IP throttle | wait ~20-60 s; the download path already retries with back-off and de-dups |
| `narration.invalid` (duration) | narration longer than the scene | shorten the copy or raise `scene.duration` |
| Run ends `unresolved` with a composition | scenes without narration text | expected for the silent recipe; add narration for `completed`, or read the composition anyway |
| `FFMPEG_UNAVAILABLE` | FFmpeg not on the server's PATH | install FFmpeg / set `FFMPEG_PATH`, restart the app |
| `VALIDATION_FAILED` on `update_project` | incomplete scene object (scenes replace wholesale) | resend every field you want to keep for every scene |
| `image_generate` -> `provider.request.unauthorized` | `gpt-image-1` not enabled for the org | switch to `dall-e-3` |

---

## 15. Cleanup

Projects are written under `/workspace/projects/` (gitignored). List and keep them
for inspection:

```bash
ls -1 projects
```

Do **not** delete anything without explicit confirmation.
