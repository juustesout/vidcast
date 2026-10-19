import { createHash } from 'node:crypto';

import type { StockOrientation, StockPhoto, StockProviderId, StockSelection } from '@/lib/types/stock';
import { stockSelectionKey } from '@/lib/types/stock';

import { STOCK_PROVIDER_IDS } from './catalog';
import type { StockProvider } from './stock-provider';
import { StockProviderError } from './stock-provider';
import { resolveStockQuotaReserve, type StockStateStore } from './stock-state-store';

export interface StockRouterRequest {
  query: string;
  orientation?: StockOrientation;
  preferredProviders?: StockProviderId[];
  perPage?: number;
  // Deterministic seed for candidate selection; defaults to the query. Keeps
  // repeated resolutions of the same query stable even before caching.
  selectionSeed?: string;
  // Provider-scoped photo keys (`provider:photoId`) that must not be selected.
  // Used when a selected candidate's download fails: the next resolution skips
  // both the cached selection and that photo, so a transient CDN failure cannot
  // pin a scene to a permanently unusable image.
  excludePhotoKeys?: string[];
}

export function stockPhotoKey(photo: { provider: StockProviderId; photoId: string }): string {
  return `${photo.provider}:${photo.photoId}`;
}

export interface StockSearchRequest {
  query: string;
  orientation?: StockOrientation;
  preferredProviders?: StockProviderId[];
  perPage?: number;
  limit?: number;
}

export interface StockProviderQuota {
  provider: StockProviderId;
  configured: boolean;
  allowed: boolean;
  windowSeconds: number;
  windowLimit: number;
  windowRemaining: number;
  resetAt?: number;
  reserve: number;
  monthlyLimit?: number;
  monthlyRemaining?: number;
}

export interface StockSearchOutcome {
  photos: StockPhoto[];
  diagnostics: StockRouterDiagnostic[];
  quota: StockProviderQuota[];
}

export type StockRouterOutcome =
  | 'cache_hit'
  | 'selected'
  | 'skipped_unconfigured'
  | 'skipped_quota'
  | 'skipped_not_allowed'
  | 'rate_limited'
  | 'auth_failed'
  | 'empty'
  | 'error';

export interface StockRouterDiagnostic {
  provider: StockProviderId;
  outcome: StockRouterOutcome;
  detail?: string;
}

export interface StockRouterResult {
  selection: StockSelection;
  cached: boolean;
  diagnostics: StockRouterDiagnostic[];
}

export class StockRoutingError extends Error {
  readonly code: 'NO_PROVIDER_AVAILABLE' | 'ALL_PROVIDERS_FAILED';
  readonly diagnostics: StockRouterDiagnostic[];
  readonly status: number;

  constructor(
    message: string,
    code: 'NO_PROVIDER_AVAILABLE' | 'ALL_PROVIDERS_FAILED',
    diagnostics: StockRouterDiagnostic[],
    status = 503
  ) {
    super(message);
    this.name = 'StockRoutingError';
    this.code = code;
    this.diagnostics = diagnostics;
    this.status = status;
  }
}

export interface StockRouterOptions {
  store: StockStateStore;
  getProvider: (id: StockProviderId) => StockProvider;
  // Provider preference order. Defaults to the configured/catalog order.
  order?: StockProviderId[];
  // When set, only these providers are considered (used to lock mock runs to
  // the fake provider). Providers outside the set are never contacted.
  allowedProviders?: StockProviderId[];
  reserve?: number;
  now?: () => number;
}

function deterministicIndex(seed: string, length: number): number {
  if (length <= 1) {
    return 0;
  }
  const digest = createHash('sha1').update(seed).digest();
  return digest.readUInt32BE(0) % length;
}

export class StockRouter {
  private readonly store: StockStateStore;
  private readonly getProvider: (id: StockProviderId) => StockProvider;
  private readonly order: StockProviderId[];
  private readonly allowedProviders?: Set<StockProviderId>;
  private readonly reserve: number;
  private readonly now: () => number;

  constructor(options: StockRouterOptions) {
    this.store = options.store;
    this.getProvider = options.getProvider;
    this.order = options.order ?? STOCK_PROVIDER_IDS;
    this.allowedProviders = options.allowedProviders ? new Set(options.allowedProviders) : undefined;
    this.reserve = options.reserve ?? resolveStockQuotaReserve();
    this.now = options.now ?? (() => Date.now());
  }

  private resolveOrder(preferred?: StockProviderId[]): StockProviderId[] {
    const seen = new Set<StockProviderId>();
    const ordered: StockProviderId[] = [];
    for (const id of [...(preferred ?? []), ...this.order]) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      ordered.push(id);
    }
    return ordered;
  }

  private isProviderAllowed(providerId: StockProviderId): boolean {
    return !this.allowedProviders || this.allowedProviders.has(providerId);
  }

  async resolve(request: StockRouterRequest): Promise<StockRouterResult> {
    const query = request.query.trim();
    if (!query) {
      throw new StockRoutingError('Stock search query is empty.', 'NO_PROVIDER_AVAILABLE', [], 400);
    }

    const key = stockSelectionKey(query, request.orientation);
    const excluded = new Set(request.excludePhotoKeys ?? []);
    const cached = await this.store.getCachedSelection(key);
    // A cache hit is only valid if the cached selection's provider is allowed in
    // this router's mode. Without this check a mock-mode fake selection would be
    // reused verbatim by a real-mode router before `allowedProviders` is applied.
    if (cached && this.isProviderAllowed(cached.provider) && !excluded.has(stockPhotoKey(cached))) {
      return { selection: cached, cached: true, diagnostics: [{ provider: cached.provider, outcome: 'cache_hit' }] };
    }

    const order = this.resolveOrder(request.preferredProviders);
    const diagnostics: StockRouterDiagnostic[] = [];
    let attempted = false;

    for (const providerId of order) {
      if (!this.isProviderAllowed(providerId)) {
        diagnostics.push({ provider: providerId, outcome: 'skipped_not_allowed' });
        continue;
      }

      const provider = this.getProvider(providerId);
      if (!provider.isConfigured()) {
        diagnostics.push({ provider: providerId, outcome: 'skipped_unconfigured' });
        continue;
      }

      if (!(await this.store.canRequest(providerId, this.reserve))) {
        diagnostics.push({ provider: providerId, outcome: 'skipped_quota' });
        continue;
      }

      attempted = true;
      let result;
      try {
        result = await provider.searchPhotos({
          query,
          orientation: request.orientation,
          perPage: request.perPage
        });
      } catch (error) {
        if (error instanceof StockProviderError) {
          if (error.code === 'RATE_LIMITED') {
            await this.store.recordRateLimited(providerId, error.rateLimit);
            diagnostics.push({ provider: providerId, outcome: 'rate_limited', detail: error.message });
            continue;
          }
          if (error.code === 'AUTH_FAILED') {
            diagnostics.push({ provider: providerId, outcome: 'auth_failed', detail: error.message });
            continue;
          }
          if (error.code === 'NOT_CONFIGURED') {
            diagnostics.push({ provider: providerId, outcome: 'skipped_unconfigured' });
            continue;
          }
          if (error.code === 'EMPTY_RESULT') {
            await this.store.recordRequest(providerId, error.rateLimit);
            diagnostics.push({ provider: providerId, outcome: 'empty', detail: error.message });
            continue;
          }
          await this.store.recordRequest(providerId, error.rateLimit);
          diagnostics.push({ provider: providerId, outcome: 'error', detail: error.message });
          continue;
        }
        await this.store.recordRequest(providerId);
        diagnostics.push({
          provider: providerId,
          outcome: 'error',
          detail: error instanceof Error ? error.message : 'unknown provider error'
        });
        continue;
      }

      await this.store.recordRequest(providerId, result.rateLimit);

      const candidates = result.photos.filter((photo) => !excluded.has(stockPhotoKey(photo)));
      if (candidates.length === 0) {
        diagnostics.push({ provider: providerId, outcome: 'empty', detail: 'no candidate photos' });
        continue;
      }

      const selection = this.buildSelection(provider, candidates, request, query, key);
      await this.store.setCachedSelection(key, selection);
      diagnostics.push({ provider: providerId, outcome: 'selected' });
      return { selection, cached: false, diagnostics };
    }

    throw new StockRoutingError(
      'No stock provider could satisfy the request.',
      attempted ? 'ALL_PROVIDERS_FAILED' : 'NO_PROVIDER_AVAILABLE',
      diagnostics
    );
  }

  // Aggregate candidate photos across providers for a manual search. Unlike
  // `resolve`, this never writes a scene selection to the cache and never picks a
  // single winner; it only gathers candidates and reports per-provider quota and
  // diagnostics so the caller can present results and failure feedback.
  async searchPhotos(request: StockSearchRequest): Promise<StockSearchOutcome> {
    const query = request.query.trim();
    if (!query) {
      throw new StockRoutingError('Stock search query is empty.', 'NO_PROVIDER_AVAILABLE', [], 400);
    }

    const limit = Math.min(Math.max(Math.floor(request.limit ?? 12), 1), 40);
    const order = this.resolveOrder(request.preferredProviders);
    const diagnostics: StockRouterDiagnostic[] = [];
    const photos: StockPhoto[] = [];
    const quota: StockProviderQuota[] = [];
    const seen = new Set<string>();
    let attempted = false;

    for (const providerId of order) {
      if (photos.length >= limit) {
        break;
      }

      const provider = (() => {
        try {
          return this.getProvider(providerId);
        } catch (error) {
          diagnostics.push({
            provider: providerId,
            outcome: 'error',
            detail: error instanceof Error ? error.message : 'unknown provider'
          });
          return undefined;
        }
      })();
      if (!provider) {
        continue;
      }

      if (!this.isProviderAllowed(providerId)) {
        diagnostics.push({ provider: providerId, outcome: 'skipped_not_allowed' });
        continue;
      }

      if (!provider.isConfigured()) {
        diagnostics.push({ provider: providerId, outcome: 'skipped_unconfigured' });
        quota.push(await this.quotaSnapshot(providerId, provider));
        continue;
      }

      if (!(await this.store.canRequest(providerId, this.reserve))) {
        diagnostics.push({ provider: providerId, outcome: 'skipped_quota' });
        quota.push(await this.quotaSnapshot(providerId, provider));
        continue;
      }

      attempted = true;
      try {
        const result = await provider.searchPhotos({
          query,
          orientation: request.orientation,
          perPage: request.perPage ?? limit
        });
        await this.store.recordRequest(providerId, result.rateLimit);

        if (result.photos.length === 0) {
          diagnostics.push({ provider: providerId, outcome: 'empty', detail: 'no candidate photos' });
        } else {
          for (const photo of result.photos) {
            const key = `${photo.provider}:${photo.photoId}`;
            if (seen.has(key)) {
              continue;
            }
            seen.add(key);
            photos.push(photo);
            if (photos.length >= limit) {
              break;
            }
          }
          diagnostics.push({ provider: providerId, outcome: 'selected', detail: `${result.photos.length} results` });
        }
      } catch (error) {
        await this.recordSearchFailure(providerId, error, diagnostics);
      }

      quota.push(await this.quotaSnapshot(providerId, provider));
    }

    if (!attempted && photos.length === 0) {
      throw new StockRoutingError('No stock provider could satisfy the search.', 'NO_PROVIDER_AVAILABLE', diagnostics);
    }

    return { photos, diagnostics, quota };
  }

  private async recordSearchFailure(
    providerId: StockProviderId,
    error: unknown,
    diagnostics: StockRouterDiagnostic[]
  ): Promise<void> {
    if (error instanceof StockProviderError) {
      if (error.code === 'RATE_LIMITED') {
        await this.store.recordRateLimited(providerId, error.rateLimit);
        diagnostics.push({ provider: providerId, outcome: 'rate_limited', detail: error.message });
        return;
      }
      if (error.code === 'AUTH_FAILED') {
        diagnostics.push({ provider: providerId, outcome: 'auth_failed', detail: error.message });
        return;
      }
      if (error.code === 'NOT_CONFIGURED') {
        diagnostics.push({ provider: providerId, outcome: 'skipped_unconfigured' });
        return;
      }
      await this.store.recordRequest(providerId, error.rateLimit);
      diagnostics.push({ provider: providerId, outcome: error.code === 'EMPTY_RESULT' ? 'empty' : 'error', detail: error.message });
      return;
    }
    await this.store.recordRequest(providerId);
    diagnostics.push({
      provider: providerId,
      outcome: 'error',
      detail: error instanceof Error ? error.message : 'unknown provider error'
    });
  }

  private async quotaSnapshot(providerId: StockProviderId, provider: StockProvider): Promise<StockProviderQuota> {
    const status = await this.store.quotaStatus(providerId, { reserve: this.reserve });
    return {
      provider: providerId,
      configured: provider.isConfigured(),
      allowed: status.allowed,
      windowSeconds: status.windowSeconds,
      windowLimit: status.windowLimit,
      windowRemaining: status.windowRemaining,
      resetAt: status.resetAt,
      reserve: status.reserve,
      monthlyLimit: status.monthlyLimit,
      monthlyRemaining: status.monthlyRemaining
    };
  }

  private buildSelection(
    provider: StockProvider,
    photos: StockPhoto[],
    request: StockRouterRequest,
    query: string,
    key: string
  ): StockSelection {
    const seed = request.selectionSeed ?? `${provider.providerId}:${query}`;
    const photo = photos[deterministicIndex(seed, photos.length)];

    return {
      provider: photo.provider,
      photoId: photo.photoId,
      query,
      orientation: request.orientation,
      usagePolicy: photo.usagePolicy,
      attribution: photo.attribution,
      sourceUrl: photo.sourceUrl,
      imageUrl: photo.imageUrl,
      downloadUrl: photo.downloadUrl,
      downloadTrackingUrl: photo.downloadTrackingUrl,
      width: photo.width,
      height: photo.height,
      selectedAt: new Date(this.now()).toISOString(),
      selectionKey: key
    };
  }
}
