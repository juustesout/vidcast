# P28: Manual Stock Photo Search & Selection

Status: **executed, mock-verified.** P27 gave scenes a multi-provider stock
router that could auto-pick a photo during a production run, but there was no
way for an author to *browse* candidates over HTTP or to *choose* a specific
photo outside a run. P28 adds an authenticated search endpoint, a per-scene
manual-select endpoint, and a compact search/select panel in the Scenes
inspector. A manual choice is pinned so a later (even forced) production run
never silently swaps it for another provider or an AI-generated image. Searching
only ever goes through the stock router — no paid image generation is triggered.
No real provider was called (mock mode). No commit or push.

---

## 1. Scope and constraints

- Browse stock candidates for a scene's query via an authenticated HTTP endpoint.
- Validate query, orientation, provider filters and result limit server-side.
- Provider API keys stay server-side; never returned in responses or logs.
- Apply a chosen candidate to a **specific scene**; persist provider, photo id,
  photographer, source URL and attribution on the existing project/scene model.
- Respect project ownership, validation and server-side mutation boundaries.
- A manually selected photo is preserved through planning/rendering and is not
  silently replaced by AI generation or a different provider.
- Manual search uses only the stock router; never paid image generation. Surface
  useful quota/error feedback and avoid redundant repeated searches.
- Every phase gated by `typecheck` → `lint` → `test` → `build`.

## 2. What changed

| Area | File | Change |
| --- | --- | --- |
| Domain types | `lib/types/stock.ts` | `StockSelectionOrigin = 'auto' | 'manual'`; `origin?` on `StockSelection`. |
| Router | `lib/ai/stock/stock-router.ts` | `searchPhotos()` aggregates candidates (never caches a winner) + per-provider quota snapshot + `StockSearchOutcome`. |
| Search service | `lib/ai/stock/stock-search-service.ts` (new) | `searchStockPhotos` / `resolveStockPhoto`: result + photo caches, server-side photo resolution, sanitized browser view. |
| Selection service | `lib/generation/stock-image-service.ts` | Extracted `persistSceneSelection`; auto path sets `origin:'auto'`; new `selectSceneStockPhoto` for the manual (`origin:'manual'`) path. |
| Persistence | `lib/projects/normalize-project.ts` | `stock_image` branch preserves `query/orientation/preferredProviders/assetId/selection` verbatim (runs before the asset branch). |
| Planner | `lib/production/production-planner.ts` | `pinnedManual` keeps a manual selection `current` even under `force`. |
| Security | `lib/security/access-control.ts` | New throttle buckets `stock_search` (30/60s) and `stock_select` (20/60s). |
| HTTP | `app/api/projects/[id]/stock/search/route.ts` (new) | `GET` authenticated search. |
| HTTP | `app/api/projects/[id]/scenes/[sceneId]/select-stock-image/route.ts` (new) | `POST` `action: 'auto' | 'choose'`. |
| UI | `components/project/project-workspace.tsx` | Search/select panel in the Scenes inspector. |

## 3. HTTP surface

### `GET /api/projects/{id}/stock/search`

Query params: `query` (required), `orientation`, `providers` (comma list),
`limit` (1–24), `mode`. Response is a sanitized `StockSearchResponse`:
`searchId`, `query`, `orientation`, `cached`, `results[]`, `diagnostics[]`,
`quota[]`. Each result carries only public CDN URLs, photographer, license and
usage policy — no keys, no server paths.

Error codes: `stock.search.missingQuery`, `stock.search.invalidOrientation`,
`stock.search.invalidProvider`, `stock.search.invalidLimit`,
`stock.search.invalidMode`, `stock.search.noProviders`, `stock.search.noProvider`
(503 when no provider can satisfy), `stock.policy.denied` (403, real mode
disabled). Unauthenticated → `401`; another owner's project → `404`.

### `POST /api/projects/{id}/scenes/{sceneId}/select-stock-image`

Body: `{ action: 'auto' | 'choose', regenerate?, mode?, searchId?, photoId?,
query?, orientation? }`. `auto` runs `selectSceneStockImage`; `choose` resolves
the candidate from the **server-side** search cache (`resolveStockPhoto`) and
applies it via `selectSceneStockPhoto`. Client-supplied image URLs are never
trusted (SSRF-safe). Errors: `stock.select.missingCandidate`,
`stock.select.invalidAction`, `stock.search.expired` (409), plus the selection
errors (`stock.provider.notAllowed`, `stock.download.failed`, …).

## 4. Search, caching and cost control

- `searchStockPhotos` aggregates candidates from the router's provider order and
  never writes a scene selection — searching is side-effect free for the project.
- Results are cached by `(normalized query, orientation, providers, limit, allowed
  providers)`; an identical search returns the same `searchId` with `cached:true`
  and does **not** re-hit the provider (dedupe / no redundant calls).
- Candidate photos are stored under a server-side `searchId` + `photo:<provider>
  :<photoId>` key (TTL), so applying a choice never triggers a second search and
  never accepts a browser-provided URL.
- TTLs: `STOCK_SEARCH_CACHE_TTL_MS` (default 120000), `STOCK_SEARCH_PHOTO_TTL_MS`
  (default 900000). Expired selection → `409 stock.search.expired`.
- Quota feedback is returned per provider (configured, allowed, window
  remaining/limit, monthly remaining); the router’s quota guard is respected
  before any provider call. No image generation endpoint is involved.
- Mock mode is locked to the `fake` provider (P27 `resolveStockMode`), so a search
  or selection can never silently spend real provider quota.

## 5. Persistence, attribution and pinning

- Manual selection persists `origin:'manual'`; the auto path persists
  `origin:'auto'`. Both write provider, photo id, query, orientation, usage
  policy, attribution (`providerName`, photographer + URL, source URL, license)
  and, for `download`-policy providers, a durable project asset.
- `normalizeProject` preserves a `stock_image` visual verbatim (including the
  selection and its `origin`), so loading/saving a project never coerces it into
  `asset`/`generated_image` or drops attribution.
- The planner pins manual selections: `stock_select` reports `current` with
  reason “Manual stock image selection is pinned.” even under `force`, while
  auto selections remain re-runnable under force.

## 6. Tests

New/updated suites (all mock, no real API calls):

- `tests/stock-search-service.test.ts` — fake-provider aggregation + inline
  previews, query dedupe (provider called once), photo resolution, missing/empty
  query, unavailable provider filter, real-mode policy denial, allowed real mode,
  quota diagnostics with no secret leakage.
- `tests/stock-search-route.test.ts` — auth (401), cross-owner (404), sanitized
  response + forwarded params, service-failure mapping with diagnostics, input
  validation matrix, throttle (429).
- `tests/stock-select-route.test.ts` — auth, cross-owner, `auto` dispatch,
  `choose` resolves server-side + applies, missing candidate, expired search
  (409), selection error mapping.
- `tests/stock-image-service.test.ts` — `selectSceneStockPhoto`: manual
  persistence + attribution, idempotency, disallowed provider (403), invalid
  payload.
- `tests/stock-selection-persistence.test.ts` — `normalizeProject` preserves a
  download-policy selection with asset, keeps a hotlink visual, is idempotent.
- `tests/production-planner.test.ts` — manual selection stays `current`
  (reason “pinned”) under `force`.

## 7. Verification

- `npm run typecheck` — clean.
- `npm run lint` — clean, no warnings.
- `npm test` — **109 files / 820 tests passed**.
- `npm run build` — ok; both new routes appear in the route table
  (`/api/projects/[id]/stock/search`,
  `/api/projects/[id]/scenes/[sceneId]/select-stock-image`).
- HTTP smoke test against the running dev server (mock mode, `fake` provider):
  - unauthenticated search/select → `401`;
  - create + `PUT` a project with a `stock_image` scene → `200`;
  - `GET …/stock/search?query=mountain sunset` → `200`, 8 candidates, inline PNG
    previews, `fake:ok` quota;
  - `POST …/select-stock-image {action:'auto'}` → `200` `{status:'selected',
    provider:'fake'}`;
  - a second search (cached) + `{action:'choose'}` on a different candidate →
    `200` `{status:'selected'}`; re-read project shows `origin:'manual'`,
    attribution and a persisted asset.
- **Browser checks:** no headless browser / click-through UI interaction was
  performed (no browser automation tool in this environment). The UI panel was
  verified only by `typecheck`/`lint`/`build` plus the HTTP-level flow above.

## 8. Limitations / follow-ups

- Only the `fake` provider is exercised end-to-end; real providers were not
  called (mock-only), consistent with P27. A live smoke test would need real keys.
- The search/photo cache is in-process (per server instance); a multi-instance
  deployment would want a shared cache. Persisted selections themselves are
  durable and restart-safe.
- The panel shows quota and diagnostics textually; no result pagination beyond
  the `limit` parameter.
