# P30 - Production reliability: stock selection cache, CDN resilience, provider concurrency

Status: **EXECUTED - all three P29 findings fixed, verified and regression-tested.**
The three reliability defects surfaced by the P29 live stock-image pilot were
reproduced, root-caused, fixed with the smallest changes that fit the local
architecture, covered by new regression tests, and verified with a real
Pixabay live smoke. No new feature was added, nothing was committed or pushed, no
credential value was read/printed/logged, no destructive cleanup was performed,
and P22-P29 behaviour (render, manual selection, run status) is unchanged.

Findings addressed (from `p29-live-stock-vidcast-pilot.md`):

| ID | Finding | Root cause | Status |
| --- | --- | --- | --- |
| F1 | `select-stock-image` returned `409 stock.search.expired` for a `searchId` minted moments earlier | Route-scoped in-memory candidate cache | **Fixed** |
| F2 | Pixabay image CDN returned `429` ("Ratelimit exceeded") independently of the API quota | No retry / no de-dup on the CDN download path | **Fixed** |
| F3 | A run with `limits.narration_generate = 8` produced 4 ElevenLabs "Too many concurrent requests" failures | No provider-level concurrency cap (only a caller-configurable run limit) | **Fixed** |

Evidence legend: **[run]** = command output this session; **[code]** = verified by
reading this repo; **[official]** = provider/documented behaviour.

---

## 1. Recon - confirmed root causes

### F1 - cross-route candidate cache

`resolveStockPhoto(searchId, photoId)` read `photoCache`, which was a **module-level
`Map`** in `lib/ai/stock/stock-search-service.ts` **[code]**. The search route
(`app/api/projects/[id]/stock/search/route.ts`) and the select route
(`.../select-stock-image/route.ts`) are separate Next.js route bundles; under
`next dev` each route gets its **own module instance**, so the search route populated
its map while the select route read a different, empty one -> `409 stock.search.expired`.
It was reproduced back-to-back in the running dev server. An in-process service call
always worked because it shares a single module instance, which is why unit tests
passed while the live UI flow failed.

### F2 - Pixabay image CDN rate limiting

`fetchPhoto` in `pixabay-provider.ts` / `pexels-provider.ts` fetched the CDN URL
directly with **no retry and no de-duplication** **[code]**. The Pixabay image CDN
(`pixabay.com/get/...`) throttles by client IP on a short window **independently** of
the search API quota **[run]**:

```
imageUrl   429  108ms  retry-after=0  ct=text/plain  Rate limit exceeded
previewUrl 429   63ms  retry-after=0  ct=text/plain  Rate limit exceeded
```

The search API still reported healthy quota while every CDN request returned 429, so
a download failure must never be attributed to the API quota. The window recovered
by itself after ~20-40 s **[run]**, i.e. bounded retries with back-off are the correct
response, not immediate failure or unbounded hammering.

### F3 - narration concurrency

The in-code default was already conservative (run default `narration_generate = 2`;
`DEFAULT_CONFIG.limits` in `production-runner.ts`) **[code]**. The `8` observed in
P29 came from the caller: `/tmp/opencode/p29-pilot.mts` line 87 passed
`limits: { narration_generate: 8, scene_render: 8, ... }` **[code]**. The root cause
is therefore that a caller could raise the fan-out past the provider's ceiling and
nothing enforced the provider's own limit: ElevenLabs allows **at most 3 concurrent
requests** and returns `429 "Too many concurrent requests ... maximum of 3"`
**[run]**.

---

## 2. Implementation

### F1 - process-global candidate cache

`lib/ai/stock/stock-search-service.ts`: `resultCache` / `photoCache` now live on a
process-global object (`globalThis['__explainerStockSearchCache__']`) reached through
`cacheState()` **[code]**. All reads/writes go through `cacheState()`, so every
route/module instance in the process shares one cache. Ownership, the existing TTLs
(`STOCK_SEARCH_CACHE_TTL_MS`, `STOCK_SEARCH_PHOTO_TTL_MS`), server-side candidate
validation and the SSRF-safe design (only `searchId` + `photoId` are ever exposed;
no client URLs are trusted) are unchanged. `resetStockSearchCacheForTests()` clears
the shared maps.

### F2 - shared resilient CDN download helper

New `lib/ai/stock/stock-download.ts` exports `downloadStockImageBytes()` **[code]**:

- Bounded retry with exponential back-off + jitter; retryable statuses
  `429/502/503/504`; non-retryable client errors fail immediately.
- Honours `Retry-After` (delta-seconds or HTTP-date), but a `Retry-After: 0` - which
  Pixabay emits on every 429 - is treated as "no useful hint" and falls back to the
  computed back-off, so retries stay spaced out instead of tight-looping **[code]**.
- In-flight de-duplication: concurrent downloads of the same URL share one request,
  keyed on `globalThis['__explainerStockDownloads__']` (also cross module instances).
- Configurable and clamped via env: `STOCK_DOWNLOAD_MAX_RETRIES` (default 3, clamp
  0-6), `STOCK_DOWNLOAD_BASE_DELAY_MS` (default 400, clamp 0-60000),
  `STOCK_DOWNLOAD_MAX_DELAY_MS` (default 8000, clamp 0-120000).
- A persistent failure surfaces a clear `StockProviderError` (`RATE_LIMITED`, 429;
  or `PROVIDER_ERROR`), which the service maps to `stock.download.failed`. CDN
  failures are never recorded against the API quota.

`pixabay-provider.ts` and `pexels-provider.ts` `fetchPhoto()` now delegate to this
helper **[code]**.

### F3 - provider-keyed concurrency limiter

New `lib/concurrency/keyed-limiter.ts` **[code]**:

- `withKeyedLimit(key, limit, task)`: a FIFO counting semaphore stored on
  `globalThis['__explainerKeyedLimiter__']` so the ceiling is shared by **all callers
  in the process** (every scene and every simultaneous run), not per-call or per-run.
  A released slot is handed directly to the next waiter; slots are released in a
  `finally` so a failing task never leaks a slot.
- `resolveProviderConcurrencyLimit(envValue, fallback, max)` clamps the configured
  value to `[1, max]`.

`elevenlabs-provider.ts` wraps the TTS HTTP call in
`withKeyedLimit('tts:elevenlabs', concurrencyLimit, ...)` with
`DEFAULT_MAX_CONCURRENCY = 3`, overridable via `ELEVENLABS_TTS_MAX_CONCURRENCY`; the
request deadline starts **after** the slot is acquired, so queueing never counts
against the per-request timeout **[code]**.

No run-orchestration code (`production-runner.ts`, `run-service.ts`) was changed:
production order and run-status semantics are untouched.

---

## 3. Regression tests

New / extended tests (20 new cases) **[run]**:

| File | Cases | Covers |
| --- | --- | --- |
| `tests/stock-candidate-cache.test.ts` | 4 | Cross-module-instance resolve (via `vi.resetModules()`), shared de-dup cache, TTL expiry across instances, unknown candidate rejected |
| `tests/stock-cdn-download.test.ts` | 9 | Retry-then-success, bounded give-up (`RATE_LIMITED`), `Retry-After` honoured, `Retry-After: 0` not collapsed, non-retryable 404, same-URL de-dup, distinct URLs, Pixabay provider wiring, env clamps |
| `tests/elevenlabs-provider-concurrency.test.ts` | 6 | Default cap 3, env override 2, cap 1, slot released on failure, keyed limiter serialises, limiter error-independence |
| `tests/narration-service.test.ts` | +1 | Provider rate-limit (`PROVIDER_RATE_LIMIT` 429) -> failed attempt recorded, previous asset preserved, `narration.provider.failed` surfaced |

The cross-route test deliberately resets the module registry between the search and
the select step, reproducing the P29 dev-server symptom in-process.

Existing run/recovery coverage continues to pass unchanged:
`production-runner`, `production-runner-force-recovery`, `production-run-service`,
`production-run-lifecycle`, `run-recovery`, `scene-render-concurrency`,
`production-run-e2e.integration` (53 cases) **[run]**.

## 4. Full regression

- `npm run typecheck` - clean **[run]**.
- `npm run lint` - no warnings or errors **[run]**.
- `npm test` - **112 files, 840 tests passed** (was 839; +1 net after the final
  `Retry-After: 0` case) **[run]**.
- `npm run build` - `Compiled successfully`, 9/9 static pages **[run]**.

Manual selection (`origin:'manual'`), the P29 render path and run status were not
touched by the changes and their tests remain green.

## 5. Live verification

Dev server started with the real `.env` and the P30 smoke script
(`/tmp/opencode/p30-smoke.mts`) run over HTTP, i.e. through the real Next.js route
boundary (separate route bundles = the F1 condition) **[run]**.

Mock/proof split: F1 and F2 are additionally proven by the automated tests above
(hermetic, deterministic). The live run below exercises the real Pixabay provider and
CDN. **F3 was verified with tests only - no extra ElevenLabs generation calls were
made** to avoid unnecessary metered usage.

Final live smoke (CDN healthy):

```
search status 200, results 12, quota: unsplash:ok pexels:ok pixabay:ok
search returns searchId: PASS
cross-route choose status 200 (error null)     -> F1: search->choose across routes resolves (no 409): PASS
persisted selection: origin=manual provider=pixabay photographer=jpeter2 hasAsset=true
                                                -> F2: provider fetchPhoto downloaded + persisted asset: PASS
back-to-back search -> choose status 200        -> F1: immediate second search->choose resolves: PASS
TOTAL FAILURES 0
```

During the same session the CDN was observed returning `429` on a burst; the select
route then returned a **clear, controlled** `429 stock.download.failed` (not a
crash, not a quota charge), and once the CDN window reopened the same flow succeeded
again. This is exactly the intended F2 behaviour: bounded retry, then a clear error,
never unbounded requests.

Quota after the smoke: Pixabay `remaining 99` (`limit 100 / 60s`) **[run]** - CDN
throttling had no effect on the API quota accounting.

## 6. Resource considerations (2-CPU host)

- Narration concurrency is now bounded by the provider semaphore rather than by the
  caller, so a misconfigured run (as in P29) can no longer exceed ElevenLabs' 3
  and can no longer spam failures **[code]**.
- The limiter is process-wide, so **simultaneous runs share the same ceiling** and
  cannot jointly exceed it **[code]**.
- Retries are bounded (<= 4 attempts) with back-off; the maximum added delay per
  download is `maxRetries * maxDelayMs` bounded by the clamp, and downloads are
  de-duplicated, so retries do not multiply CPU/network load on the small host.
- Scene render concurrency (default 1) and production order are unchanged, so the
  P29 FFmpeg-timeout class of problem is not reintroduced.

## 7. Limitations / remaining risk

- Pixabay's CDN IP throttle is a **provider-side** limit. If a burst is large enough,
  downloads can still fail after bounded retries and surface `stock.download.failed`.
  This is the documented "clear error" outcome; there is no cross-provider fallback
  because the chosen photo is provider-specific and, in this environment, Pixabay is
  the only configured stock provider (`PEXELS_API_KEY`/`UNSPLASH_ACCESS_KEY` absent)
  **[code]**.
- The cache/limiter singletons are per **process**. This is correct for the local
  single-process dev/deploy model; a future multi-process deployment would need a
  shared store. This was explicitly out of scope for the local architecture
  **[code]**.
- The candidate cache is still in-memory, so a process restart between search and
  select will still yield `409 stock.search.expired` (client re-searches). Only TTL
  and route-instance sharing were in scope.

## 8. Repository state / boundaries

- Branch `main`; `HEAD = cbfe7fb876c75744b839b965dcd31679b89a9e2a`, **equal to
  `origin/main`**. No commit/push this session **[run]**.
- P30 additions: modified `lib/ai/text-to-speech/elevenlabs-provider.ts`,
  `lib/ai/stock/pixabay-provider.ts`, `lib/ai/stock/pexels-provider.ts`,
  `lib/ai/stock/stock-search-service.ts`, `tests/narration-service.test.ts`; new
  `lib/ai/stock/stock-download.ts`, `lib/concurrency/keyed-limiter.ts`,
  `tests/stock-candidate-cache.test.ts`, `tests/stock-cdn-download.test.ts`,
  `tests/elevenlabs-provider-concurrency.test.ts` **[run]**.
- No credential value was read, printed or logged; no destructive cleanup; the
  gitignored `projects/` data and untracked recon docs were left intact **[run]**.
