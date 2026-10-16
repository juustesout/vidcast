# P29 - Live Stock-Image Vidcast Pilot (Episode 1)

Status: **EXECUTED - end-to-end succeeded.** A real, narrated 49 s MP4 episode was
produced by the existing production pipeline using **real Pixabay stock photos**
(download policy) and **real ElevenLabs narration**, with **no AI image generation
and no paid image/video provider**. No production feature was added, nothing was
committed or pushed, no credential value was read/printed/logged, and the existing
untracked recon docs plus the gitignored `projects/` data were left intact. No
destructive cleanup was performed.

Outcome: one project created (`create` + 7-scene `PUT`), one production run executed
and recovered after a concurrency-driven partial failure, all 7 scenes rendered, and
a final composition produced. Two semantically weak stock matches were then re-curated
via the **manual (`origin:'manual'`) selection path** and the episode was re-rendered
and re-composed. The final MP4 was `ffprobe`-inspected and fully decoded with local
FFmpeg.

Convention: **[official]** = quoted from a provider/publisher source fetched this
session; **[run]** = command output this session; **[code]** = verified by reading
this repo; **[estimate]** = not independently confirmed by an invoice/usage figure.

---

## 1. Repository status and preflight

- Branch `main`; `HEAD = cbfe7fb876c75744b839b965dcd31679b89a9e2a` **equal to
  `origin/main`** **[run]**. No commit/push this session. `.gitmodules` absent;
  no submodules. 76 tracked files show P22-P29 implementation edits in the working
  tree, and the P29 recon docs are untracked **[run]**.
- Real-mode / opt-in / credentials (existence only; **no key value was read, printed
  or logged**) **[run]**:
  - `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS = true`, `PRODUCTION_RUN_DEFAULT_MODE = real`.
  - `PIXABAY_API_KEY` present (`<set:34 chars>`); `UNSPLASH_APP_ID/PUBLIC/SECRET`,
    `FAL_KEY`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` present.
  - `PEXELS_API_KEY` absent; `UNSPLASH_ACCESS_KEY` absent -> **Pixabay is the only
    configured, usable stock provider** (its adapter reads `PIXABAY_API_KEY`) **[code]**.
- **Cost safety gate (required before any live call):** the run plan contains only
  `stock_select` + `narration_generate` + `scene_render` + `final_compose`
  action types. No `image_generate` / `video_submit` actions are planned, so no paid
  image/video provider can be reached **[run]** (see §4). Narration is the only
  metered provider enabled, and it was explicitly bounded (see §4).

---

## 2. Episode brief and sources

Title: **"This Week in Dev & AI - Episode 1"**; 7 scenes x 7 s = 49 s; 1920x1080
(16:9) @ 30 fps; `fade` transitions; dark background `#070b10`.

Five real stories, one per content scene, each with a source URL fetched this session
(HTTP 200 confirmed) **[run]**:

| # | Story | Source | Published | Status |
| --- | --- | --- | --- | --- |
| 2 | Meta Muse Spark Open (open-weight desktop model) | `https://research.meta.ai/blog/muse-spark-open` | 2026-10-15 | 200 |
| 3 | "Neural networks are already clean" (interpretability) | `https://already-clean.goodfire.com/` | 2026-10-15 | 200 |
| 4 | Krea 3 (image editing model) | `https://www.krea.ai/krea-3` | 2026-10-15 | 200 |
| 5 | RPKI now protects 70% of internet routes | `https://ipinfo.io/blog/rpki-protects-70-internet-routes` | 2026-10-15 | 200 |
| 6 | 70 years of Fortran | `https://fortran-lang.org/news/2026/09-15-Fortran-birthday/` | 2026-09-15 | 200 |

Scenes 1 and 7 are the intro/outro (no source). No claim in the episode rests on a
source that could not be fetched.

---

## 3. Final episode (per-scene stock attribution)

All selections: `provider=pixabay`, `usagePolicy=download`, `orientation=landscape`,
license `Pixabay Content License` **[run]**.

| Scene | Narration (chars) | Stock query | photoId | Photographer | Source page | Origin |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 80 | technology newsroom screens night | 6873010 | mjh_shikder | `pixabay.com/photos/technology-network-mesh-network-6873010/` | **manual** |
| 2 | 78 | data center server racks blue light | 2476790 | Akela999 | `pixabay.com/photos/data-center-engine-room-2476790/` | auto |
| 3 | 93 | abstract neural network glowing brain | 7633488 | DeltaWorks | `pixabay.com/photos/cyber-brain-computer-brain-7633488/` | auto |
| 4 | 77 | graphic designer workspace computer screen | 820272 | fancycrave1 | `pixabay.com/photos/hands-ipad-tablet-technology-820272/` | auto |
| 5 | 81 | network cables internet infrastructure | 7014602 | Tho-Ge | `pixabay.com/photos/server-technology-computer-cable-7014602/` | auto |
| 6 | 79 | vintage computer terminal retro | 663396 | ludi | `pixabay.com/photos/computer-hardware-technology-pc-663396/` | **manual** |
| 7 | 53 | laptop coffee desk workspace morning | 480222 | epicantus | `pixabay.com/photos/workplace-lapetop-notebook-480222/` | auto |

Narration total: **541 characters** across 7 scenes **[run]**. Every scene
`narrationStatus=generated`, `renderStatus=completed`, and carries full
photographer + source-page attribution as required by the Pixabay license **[run]**.

### 3.1 Manual re-curation of the two weak matches

The automated single-query selection produced two semantically weak photos: scene 1
(a "children winning a video game" photo for a technology roundup intro) and scene 6
(a train-station photo for "vintage computer terminal retro"). Both were re-curated
through the P28 manual-selection path:

- Scene 1 -> `pixabay:6873010` (blue mesh-network visual); scene 6 -> `pixabay:663396`
  (vintage computer room). Candidates were searched, their previews downloaded and
  visually reviewed, then pinned **[run]**.
- Both now persist `visual.selection.origin = 'manual'` with the correct attribution
  and a download-policy asset **[run]**. Re-rendering those two scenes and re-composing
  produced the corrected episode (frames verified: scene 1 = mesh network, scene 6 =
  vintage computers) **[run]**.

This is the first **live** exercise of the P28 manual path (P28 only covered it with the
mock provider).

---

## 4. Cost safety, bounds, and quota

Provider/cost model **[code]**:

- Stock: **only Pixabay**, free API + free image CDN. No paid provider is reachable
  from this plan (no `image_generate`/`video_submit`).
- Narration: **ElevenLabs** (`eleven_multilingual_v2`), the only metered call. The
  task's explicit opt-in flags were present (`RUN_REAL_NARRATION_PILOT=true` +
  `CONFIRM_REAL_NARRATION_PILOT=YES`) **[run]**.
- Image generation / video generation: **not invoked** (no such actions in the plan,
  no paid image/video key used for generation) **[run]**.

Hard bounds applied to the server process **[run]**:

```
STOCK_IMAGE_PROVIDER_ORDER=pixabay
PRODUCTION_RUN_CONCURRENCY_STOCK=1
PRODUCTION_RUN_CONCURRENCY_NARRATION=1
PRODUCTION_RUN_CONCURRENCY_RENDER=1
RENDER_SCENE_TIMEOUT_MS=240000
RENDER_COMPOSE_TIMEOUT_MS=360000
```

Quota check **before** the first request: a `curl` Pixabay search returned
`x-ratelimit-limit: 100`, `x-ratelimit-remaining: 98` (60 s window) **[run]**.

Observed quota accounting from the persisted router state
(`projects/_stock/stock-state.json`) **[run]**:

- Pixabay API search events recorded this session: **18** (7 for the production run +
  11 curation searches). Far below the 100/60 s window; the safety `reserve` is 3.
- Pixabay self-reported snapshot: `limit: 100, remaining: 98, windowSeconds: 60`.

### 4.1 Cost accounting

| Item | Call count | Basis | Cost |
| --- | --- | --- | --- |
| Pixabay search (API) | 18 events | `[run]` router state | **$0** (free API) |
| Pixabay image downloads (CDN) | 9 assets (7 run + 2 re-curations) + ~30 previews | `[run]` | **$0** (free CDN) |
| ElevenLabs narration | 7 generated (11 attempts) | `[run]` project state | **[estimate]** credit-based; no invoice/usage figure was obtained |
| FAL / OpenAI image+video | 0 | `[run]` | **$0** |
| FFmpeg render/compose | local | `[run]` | **$0** |

The only potentially metered spend is ElevenLabs narration; no monetary figure is
asserted because none was independently confirmed.

---

## 5. Run execution and recovery

`POST /api/projects/{id}/production-runs` (HTTP 202) with `mode=real`, provider
override `stock=pixabay` **[run]**. Run id is returned as `run.runId` (not `run.id`).

- The **first** run used the default per-action concurrency (`limits.narration_generate
  = 8`, 8-way `scene_render`). This exceeded **ElevenLabs' 3-concurrent limit** (4
  narrations failed with "Too many concurrent requests ... maximum of 3") and starved
  the **2-CPU** box so FFmpeg scene renders timed out **[run]**.
- A **resume** run (`run_5a5b9a0d-8dbb-4c75-9182-9b173fdc07c0`) with `limits` all set
  to 1 completed the remaining work: 12 actions (4 narration retries + 7 renders +
  1 compose) **[run]**. This isolates the failure to *concurrency*, not to logic: the
  same actions succeed when serialized.
- Narration accounting: **11 attempts, 7 generated, 4 failed** (all failures from the
  over-concurrent first run) **[run]**.

---

## 6. Rendered artifact verification

Final composition (after re-curation) **[run]**:

- `compositionId`: `composition_54f20ba9-d665-4719-a205-69a8dff6d4c1`
- `outputPath`: `renders/compositions/final-composition_54f20ba9-d665-4719-a205-69a8dff6d4c1.mp4`
- Container: `mov,mp4,m4a,3gp,3g2,mj2`; video `h264` 1920x1080 30/1 fps,
  duration `49.033`; audio `aac` 48000 Hz stereo, duration `49.040`; size `8417585`
  bytes; `mimeType=video/mp4`, `renderer=ffmpeg`, `version=p8` **[run]**.
- Full decode `ffmpeg -i <file> -f null -` completed with **no errors** ("DECODE OK")
  **[run]**.
- 7 boundary frames extracted and visually confirmed: scene 1 = blue mesh network,
  2 = server racks, 3 = glowing brain, 4 = tablet editing, 5 = network cables,
  6 = vintage computers, 7 = laptop + coffee **[run]**.

The pre-recuration composition (`composition_bb808a05-7ea2-4d18-af35-37db657efca4`,
49.04 s, 9050669 bytes) is retained in the project; it used the two weak photos.

---

## 7. Findings (actionable)

1. **F1 - Manual `choose` is broken under `next dev` (route module isolation).**
   The candidate cache (`photoCache`) in `lib/ai/stock/stock-search-service.ts` is a
   module-level `Map`. Under `next dev`, the search route and the
   `select-stock-image` route are separate bundles with **separate module instances**,
   so `resolveStockPhoto(searchId, photoId)` never sees the search's cache entry and
   returns **409 `stock.search.expired`** - even for a search issued immediately
   before the choose **[run]**. The in-process service call works because it shares one
   module instance **[run]**. This is a real defect for the browser manual-selection UX
   in dev; it may or may not reproduce in a production build (separate server chunks
   could have the same problem). Fix options: back `photoCache` with a process-global
   singleton (`globalThis`) or the filesystem state store, or fold the search+choose
   into a single request.
2. **F2 - Pixabay image CDN rate-limits independently of the API quota.** After a
   burst of ~7 rapid preview/image downloads the `pixabay.com/get/...` endpoints
   returned **HTTP 429** ("Ratelimit exceeded") while the search API stayed healthy.
   Bounded exponential backoff (15 s, 30 s) recovered it **[run]**. The stock
   `fetchPhoto` path should treat CDN `429` as retryable with backoff (it currently
   surfaces a single `stock.download.failed` 429).
3. **F3 - Default per-action run concurrency is unsafe on small hosts.**
   `limits.narration_generate=8` violates ElevenLabs' 3-concurrent limit and 8-way
   rendering starves a 2-CPU box (FFmpeg timeouts). Serialized execution succeeded
   **[run]**. Consider provider-aware concurrency caps by default.

---

## 8. Proved vs assumptions

- **Proved (run):** live Pixabay search + download integration; live ElevenLabs
  narration; full plan -> run -> render -> compose chain; run recovery via resume;
  P28 manual selection (`origin:'manual'`) with the real provider; artifact validity
  (ffprobe + full decode); per-scene attribution; source URLs reachable.
- **Assumed / not independently confirmed:** ElevenLabs monetary cost (no invoice);
  whether F1 reproduces in a production build (only `next dev` was exercised); Pixabay
  CDN rate-limit window size (observed behavior only, not a published figure).

---

## 9. Artifacts and files (no commit/push)

- Episode MP4: `projects/project_ba439064-e936-409b-9ec7-cc38bee1dbb3/renders/compositions/final-composition_54f20ba9-d665-4719-a205-69a8dff6d4c1.mp4` (gitignored).
- Project state: `projects/project_ba439064-e936-409b-9ec7-cc38bee1dbb3/`.
- Stock router quota state: `projects/_stock/stock-state.json` (gitignored).
- Scratch (outside repo): `/tmp/opencode/p29-*` (brief, preflight, curation scripts,
  candidate previews, montages, run/project JSON).
- Report: this file (`p29-live-stock-vidcast-pilot.md`).

Nothing was committed or pushed; the working tree changes are pre-existing P22-P29
implementation edits plus these untracked docs.
