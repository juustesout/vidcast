# P27: Multi-Provider Stock Image Router & Quota Manager

Status: **executed, mock-verified.** A scene can now source a royalty-free photo
from a stock provider (Unsplash / Pexels / Pixabay) instead of paying for a new
AI-generated image. The selection is a first-class production action
(`stock_select`) that runs inside the existing production run pipeline. Provider
usage terms (hotlink vs. download-to-server) are modelled explicitly, quota is
tracked persistently with a safety margin, and providers are contacted through a
deterministic fallback router. Mock mode is hard-locked to a local, network-free
`fake` provider so a stock request can never silently trigger a real
(paid/quota-consuming) API call. No real provider was called. No commit or push.

---

## 1. Scope and constraints

- Do **not** force paid AI image generation as the default. Stock is an explicit
  per-scene author choice (`visual.kind === 'stock_image'`).
- Separate server-side API key per provider; never leak keys to the browser, logs
  or commits.
- Honour each provider's terms:
  - **Unsplash** requires hotlinking; assets must not be permanently re-hosted.
  - **Pexels** / **Pixabay** allow downloading to the server; Pixabay forbids
    permanent hotlinking.
- Configurable provider preference order with controlled fallback on quota /
  HTTP 429.
- No endless retries, no duplicate search for the same query.
- Idempotent quota accounting that survives a process restart, with a safety
  margin. Response headers always win over hardcoded limits.
- Every phase gated by `typecheck` → `lint` → `test` → `build`.

## 2. Verified provider limits and terms

Fetched from the official docs on **2026-10-16**. Direct fetches were blocked
(Pexels `403`, Pixabay `429`), so the pages were read through the
`https://r.jina.ai/<url>` reader proxy and cross-checked.

| Provider | Window | Monthly | Reset header semantics | Usage policy | Auth | Env var |
| --- | --- | --- | --- | --- | --- | --- |
| Unsplash | 50/h (demo) · 5000/h (prod) | – | `X-Ratelimit-Reset` (epoch s) | **hotlink** (no re-host) | `Authorization: Client-ID` | `UNSPLASH_ACCESS_KEY` |
| Pexels | 200/h | 20000 | `X-Ratelimit-Reset` (epoch s) | **download** | `Authorization: <key>` | `PEXELS_API_KEY` |
| Pixabay | 100/60s | – | `X-Ratelimit-Reset` (seconds **remaining**) | **download** (hotlink forbidden) | `?key=` query param | `PIXABAY_API_KEY` |

Additional verified details:
- Unsplash requires the `download_location` endpoint to be pinged on an actual
  download (accounting only, no bytes) and requires visible photographer
  attribution with a link back.
- Pexels requires a prominent link to Pexels and a credit to the photographer;
  the legacy `/videos/` endpoint is deprecated in favour of `/v1/videos/` (the
  search path used here is `/v1/search`).
- Pixabay reports its reset as *seconds remaining*, not an epoch — captured via
  a `resetIsSecondsRemaining` flag on the header parser.

These values live in `lib/ai/stock/catalog.ts` as **fail-safe defaults only**;
live response headers override them at runtime.

## 3. Architecture

```
scene (visual.kind = 'stock_image')
        │
        ▼
selectSceneStockImage()            lib/generation/stock-image-service.ts
        │  resolveStockMode()  → mock: allowed=['fake'], order=['fake', …]
        ▼
StockRouter.resolve()              lib/ai/stock/stock-router.ts
   ├─ cache lookup (stockSelectionKey)
   ├─ per provider: allowed? → configured? → quota ok?
   ├─ provider.searchPhotos()      lib/ai/stock/*-provider.ts
   ├─ on 429 → recordRateLimited, fall through
   └─ deterministic pick → cache selection
        │
        ▼
usage policy = 'download' → provider.fetchPhoto() → mediaStore.saveStockImage()
usage policy = 'hotlink'  → persist selection only (URL ref at render)
        │
        ▼
scene.visual.selection / scene.visual.assetId  (persisted, idempotent)
```

### New modules

- `lib/types/stock.ts` — domain types: `StockProviderId`
  (`'unsplash' | 'pexels' | 'pixabay' | 'fake'`), `StockUsagePolicy`
  (`'download' | 'hotlink'`), `StockOrientation`, `StockAttribution`,
  `StockPhoto`, `StockSearchQuery`, `StockRateLimitSnapshot`,
  `StockSearchResult`, `StockSelection`, and `stockSelectionKey()`.
- `lib/ai/stock/catalog.ts` — `STOCK_PROVIDER_CATALOG` (per-provider window /
  monthly cap / policy / env var / docs URL), `STOCK_PROVIDER_IDS`,
  `isStockProviderId`, `resolveStockProviderOrder`.
- `lib/ai/stock/stock-provider.ts` — `StockProvider` interface
  (`isConfigured`, `searchPhotos`, `fetchPhoto`, optional `trackDownload`),
  `StockProviderError` (codes `NOT_CONFIGURED | AUTH_FAILED | RATE_LIMITED |
  PROVIDER_ERROR | EMPTY_RESULT`), and shared helpers `rateLimitFromHeaders`,
  `createRequestSignal` (abort + hard timeout), `readJsonResponse`,
  `stockProviderFetch`.
- `lib/ai/stock/{fake,unsplash,pexels,pixabay}-provider.ts` — provider adapters.
  `fetchPhoto()` on the Unsplash adapter always throws (`PROVIDER_ERROR`),
  enforcing its hotlink-only policy at the type-safe boundary.
- `lib/ai/stock/registry.ts` — `createStockProviderRegistry()`; the only place
  that reads provider env vars.
- `lib/ai/stock/stock-state-store.ts` — `StockStateStore`,
  `InMemoryStockStateStore`, `FileStockStateStore` (atomic temp-file + rename,
  wrapped in a keyed mutex), `computeQuotaStatus`, `resolveStockQuotaReserve`
  (default `3`, override `STOCK_QUOTA_SAFETY_MARGIN`).
- `lib/ai/stock/stock-router.ts` — `StockRouter` / `StockRoutingError`:
  deterministic candidate selection, selection cache, `allowedProviders`
  lockdown, and roll-through diagnostics (`cache_hit`, `selected`,
  `skipped_unconfigured`, `skipped_quota`, `skipped_not_allowed`, `rate_limited`,
  `auth_failed`, `empty`, `error`).
- `lib/generation/stock-image-service.ts` — `selectSceneStockImage()`,
  `StockImageSelectionError`, `resolveStockMode()`.

### Quota model

`computeQuotaStatus` maintains a rolling window (per-provider `windowSeconds`)
and, where present, a monthly cap. A request is allowed only when the remaining
count is **strictly greater than** the configured reserve, so the last few
requests of a window are never consumed by an automated run. A fresh
provider-reported `limit`/`remaining` overrides the local accounting; a recorded
HTTP 429 sets `remaining = 0` until the reported (or one-window) reset.

## 4. Change summary

- **Types / domain**: `lib/types/stock.ts` (new); `lib/types/scene.ts` adds
  `StockImageVisual` to the `VisualSpec` union.
- **Render**: `lib/types/render.ts` adds `remoteUrl` to `RenderPlanSceneSource`;
  `lib/render/scene-resolver.ts` resolves the `stock_image` case (local asset →
  renderable; hotlink → `remoteUrl`; otherwise planned/warning);
  `lib/render/renderer.ts` adds `fetchRemoteSourceToFile()` so a hotlinked URL
  is fetched transiently into the per-render temp dir (never persisted) with the
  scene render timeout.
- **Storage**: `lib/storage/storage-paths.ts` adds `getStockStatePath()` /
  `getStockStateDir()` (`projects/_stock/stock-state.json`);
  `lib/storage/media-store.ts` adds `saveStockImage()` (provenance `stock`,
  attribution embedded in asset metadata).
- **Production**: `lib/production/production-planner.ts` adds the
  `stock_select` action type and `deriveProductionPlan` logic
  (`current` when a usable selection exists, `blocked` when the query is empty,
  forced re-run under `force`); `production-runner.ts` adds the action with a
  default limit of 2 and puts it first in the execution order;
  `production-log-export.ts` maps it to `STOCK`; `run-service.ts` injects
  `selectStockImage`, adds `PRODUCTION_RUN_CONCURRENCY_STOCK` (default 2) and
  dispatches the action.
- **UI**: `components/project/project-workspace.tsx` registers `stock_image` as
  a `VisualMode` and a default `{ kind: 'stock_image', query: '' }` visual.
- **Tests / scripts**: `stock_select` inserted into the run-limit literals of
  ~21 test/script files (e.g. `scripts/p11.4.1-credential-harness-server.ts`,
  `tests/mcp-production.test.ts`, `tests/production-run-service.test.ts`,
  `tests/production-runner.test.ts`).

### Fixes discovered while hardening

- **Mock lockdown was non-functional**: `resolveStockProviderOrder()` only
  returns the real catalog ids, so in mock mode (`allowedProviders: ['fake']`)
  the router had no allowed provider in its order and failed closed with
  `NO_PROVIDER_AVAILABLE`. `resolveStockMode()` now prepends `fake` to the order
  in mock mode.
- `lib/types/scene.ts` imports `StockOrientation` / `StockProviderId` /
  `StockSelection` (no circular import; `stock.ts` is dependency-free).

## 5. Configuration

| Env var | Purpose | Default |
| --- | --- | --- |
| `UNSPLASH_ACCESS_KEY` | Unsplash access key (server only) | – |
| `PEXELS_API_KEY` | Pexels API key (server only) | – |
| `PIXABAY_API_KEY` | Pixabay API key (server only) | – |
| `STOCK_IMAGE_PROVIDER_ORDER` | Comma-separated preference order | catalog order |
| `STOCK_QUOTA_SAFETY_MARGIN` | Requests kept in reserve per window | `3` |
| `PRODUCTION_RUN_CONCURRENCY_STOCK` | `stock_select` concurrency | `2` |

A provider without its key is treated as unconfigured and skipped
(`skipped_unconfigured`); it is never contacted.

## 6. Verification

```
npm run typecheck   # clean
npm run lint        # clean (no warnings)
npm test            # 105 files, 786 tests passed
npm run build       # succeeded
```

New P27 tests (35 added):

- `tests/stock-providers.test.ts` — mapping + rate-limit parsing + 429 handling
  for all three adapters, Unsplash `fetchPhoto` refusal, fake-provider
  determinism and PNG magic bytes.
- `tests/stock-quota-store.test.ts` — default windows, reserve enforcement,
  rolling-window expiry, header precedence, Pexels monthly cap, 429 exhaustion
  until reset, on-disk persistence, reserve resolution.
- `tests/stock-router.test.ts` — deterministic selection + cache hit (single
  search), 429 fallback, quota skip, mock lockdown (real providers never
  contacted), unconfigured skip, preferred order, `NO_PROVIDER_AVAILABLE`,
  empty-query rejection.
- `tests/stock-image-service.test.ts` — mock selection persists an asset, second
  call is `current` (idempotent, no re-download), existing hotlink selection is
  current without an asset, missing query rejected.
- `tests/production-planner.test.ts` — blocked without query, ready with query,
  downloaded selection current, hotlink selection current, force/complete
  lifecycle.
- `tests/stock-render-resolution.test.ts` — planned (no selection), hotlink
  `remoteUrl`, downloaded local-asset path.

## 7. Limitations / follow-ups

- **No dedicated HTTP route yet.** The run-service dispatch advertises
  `/api/projects/{id}/scenes/{sceneId}/select-stock-image` only as the
  run-log endpoint label; that route does not exist. Manual, out-of-run stock
  selection currently has no UI/API entry point; the UI exposes the visual mode
  but not yet a query/provider editor. Selections are driven by the production
  planner today.
- **No live provider call was made** (mock-only verification). Adapter behaviour
  is covered by injected-fetch unit tests, not by a real network smoke test.
- The Unsplash per-provider production limit (5000/h) is not distinguished from
  the demo limit (50/h); the catalog uses the conservative demo value as the
  fail-safe default until headers report the true limit.
- `docs`-fetch workaround (`r.jina.ai`) is documented in §2 for reproducibility;
  it is not part of the runtime.
