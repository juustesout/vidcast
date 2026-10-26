import { HumanApprovalError } from '@/lib/explainer/human-approval';
import { resolveStockMode, StockImageSelectionError } from '@/lib/generation/stock-image-service';
import type { RunMode } from '@/lib/production/run-types';
import { AccessControlError } from '@/lib/security/access-control';
import { assertRealExecutionAuthorized } from '@/lib/security/real-actor';
import type { RequestIdentity } from '@/lib/security/auth';
import { PaidSubmitCapError, requireEnabledPaidSubmitCapForRealMode } from '@/lib/spend/paid-submit-cap';
import type { Project } from '@/lib/types/render';
import type { StockOrientation, StockPhoto, StockProviderId, StockUsagePolicy } from '@/lib/types/stock';
import { createId } from '@/lib/utils/ids';

import { createStockProviderRegistry, type StockProviderRegistry } from './registry';
import type { StockProvider } from './stock-provider';
import { StockRouter, StockRoutingError, type StockProviderQuota, type StockRouterDiagnostic } from './stock-router';
import { FileStockStateStore, resolveStockQuotaReserve, type StockStateStore } from './stock-state-store';

const DEFAULT_RESULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_PHOTO_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;
const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 180;

// Sanitized, browser-facing view of a search candidate. Never contains provider
// API keys; only public CDN URLs, attribution and quota-safe metadata.
export interface StockSearchPhoto {
  id: string;
  provider: StockProviderId;
  photoId: string;
  width: number;
  height: number;
  description?: string;
  color?: string;
  previewUrl: string;
  imageUrl: string;
  sourceUrl: string;
  photographerName: string;
  photographerUrl?: string;
  license: string;
  usagePolicy: StockUsagePolicy;
}

export interface StockSearchResponse {
  searchId: string;
  query: string;
  orientation?: StockOrientation;
  cached: boolean;
  results: StockSearchPhoto[];
  diagnostics: StockRouterDiagnostic[];
  quota: StockProviderQuota[];
}

export interface StockSearchRequest {
  query: string;
  orientation?: StockOrientation;
  providers?: StockProviderId[];
  limit?: number;
  mode?: RunMode;
  project?: Project;
  identity?: RequestIdentity;
}

export interface StockPhotoResolution {
  query: string;
  orientation?: StockOrientation;
  photo: StockPhoto;
}

export class StockSearchError extends Error {
  readonly status: number;
  readonly code: string;
  readonly diagnostics?: StockRouterDiagnostic[];

  constructor(message: string, status: number, code: string, diagnostics?: StockRouterDiagnostic[]) {
    super(message);
    this.name = 'StockSearchError';
    this.status = status;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

interface ResultCacheEntry {
  expiresAt: number;
  searchId: string;
  response: StockSearchResponse;
  photos: StockPhoto[];
}

interface PhotoCacheEntry {
  expiresAt: number;
  query: string;
  orientation?: StockOrientation;
  photo: StockPhoto;
}

interface StockSearchDependencies {
  registry: StockProviderRegistry;
  stateStore: StockStateStore;
  now: () => number;
}

let defaultStateStore: StockStateStore | undefined;

function getDefaultStateStore(): StockStateStore {
  defaultStateStore ??= new FileStockStateStore();
  return defaultStateStore;
}

// The search-result and candidate caches must be visible across independent
// module instances. In `next dev` (and potentially split server bundles) the
// `stock/search` route and the `scenes/[sceneId]/select-stock-image` route load
// this module separately, so a module-local `Map` written by the search route is
// invisible to the select route. Backing the caches with a process-global object
// keeps a search's candidates resolvable from a different route while preserving
// the existing TTL and server-side validation.
interface StockSearchCacheState {
  resultCache: Map<string, ResultCacheEntry>;
  photoCache: Map<string, PhotoCacheEntry>;
}

const STOCK_SEARCH_CACHE_GLOBAL_KEY = '__explainerStockSearchCache__';

function cacheState(): StockSearchCacheState {
  const globalRef = globalThis as typeof globalThis & {
    [STOCK_SEARCH_CACHE_GLOBAL_KEY]?: StockSearchCacheState;
  };
  globalRef[STOCK_SEARCH_CACHE_GLOBAL_KEY] ??= {
    resultCache: new Map<string, ResultCacheEntry>(),
    photoCache: new Map<string, PhotoCacheEntry>()
  };
  return globalRef[STOCK_SEARCH_CACHE_GLOBAL_KEY];
}

const defaultDependencies: StockSearchDependencies = {
  registry: createStockProviderRegistry(),
  get stateStore() {
    return getDefaultStateStore();
  },
  now: () => Date.now()
};

export function buildStockSearchDependencies(overrides: Partial<StockSearchDependencies>): StockSearchDependencies {
  return { ...defaultDependencies, ...overrides };
}

export function resetStockSearchCacheForTests(): void {
  cacheState().resultCache.clear();
  cacheState().photoCache.clear();
}

export function resolveStockSearchTtls(env: NodeJS.ProcessEnv = process.env): { resultTtlMs: number; photoTtlMs: number } {
  const parse = (raw: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    resultTtlMs: parse(env.STOCK_SEARCH_CACHE_TTL_MS, DEFAULT_RESULT_TTL_MS),
    photoTtlMs: parse(env.STOCK_SEARCH_PHOTO_TTL_MS, DEFAULT_PHOTO_TTL_MS)
  };
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

function prune(now: number): void {
  const { resultCache, photoCache } = cacheState();
  for (const [key, entry] of resultCache) {
    if (entry.expiresAt <= now) {
      resultCache.delete(key);
    }
  }
  for (const [key, entry] of photoCache) {
    if (entry.expiresAt <= now) {
      photoCache.delete(key);
    }
  }
}

async function buildPreviewUrl(provider: StockProvider, photo: StockPhoto): Promise<string> {
  // The local fake provider has no CDN; serve a small deterministic PNG as an
  // inline data URL so the mock UI (and mock browser checks) can render previews
  // without any network access. Real providers use their own CDN URL.
  if (photo.provider !== 'fake') {
    return photo.imageUrl;
  }
  try {
    const bytes = await provider.fetchPhoto({
      provider: photo.provider,
      photoId: photo.photoId,
      imageUrl: photo.imageUrl,
      downloadUrl: photo.downloadUrl,
      width: Math.min(photo.width || PREVIEW_WIDTH, PREVIEW_WIDTH),
      height: Math.min(photo.height || PREVIEW_HEIGHT, PREVIEW_HEIGHT)
    });
    return `data:${bytes.mimeType};base64,${bytes.data.toString('base64')}`;
  } catch {
    return photo.imageUrl;
  }
}

function photoId(photo: StockPhoto): string {
  return `${photo.provider}:${photo.photoId}`;
}

export async function searchStockPhotos(
  request: StockSearchRequest,
  dependencies: StockSearchDependencies = defaultDependencies
): Promise<StockSearchResponse> {
  const query = request.query?.trim() ?? '';
  if (!query) {
    throw new StockSearchError('A stock search query is required.', 400, 'stock.search.missingQuery');
  }

  let mode;
  try {
    mode = resolveStockMode({ mode: request.mode });
  } catch (error) {
    if (error instanceof StockImageSelectionError) {
      throw new StockSearchError(error.message, error.status, error.code);
    }
    throw error;
  }

  try {
    if (mode.mode === 'real' && !request.project) {
      throw new HumanApprovalError(
        'A human must approve the current project snapshot before real or paid execution.'
      );
    }
    if (request.project) {
      await assertRealExecutionAuthorized(request.project, mode.mode, request.identity);
    }
  } catch (error) {
    if (error instanceof HumanApprovalError) {
      throw new StockSearchError(
        error.message,
        error.status,
        `stock.approval.${error.code === 'HUMAN_APPROVAL_STALE' ? 'stale' : 'required'}`
      );
    }
    if (error instanceof AccessControlError) {
      throw new StockSearchError(error.message, error.status, 'stock.policy.denied');
    }
    throw error;
  }

  const allowed = new Set(mode.allowedProviders);
  const requestedProviders = (request.providers ?? []).filter((provider) => allowed.has(provider));
  if ((request.providers?.length ?? 0) > 0 && requestedProviders.length === 0) {
    throw new StockSearchError('None of the requested stock providers are available.', 400, 'stock.search.noProviders');
  }

  const limit = Math.min(Math.max(Math.floor(request.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const now = dependencies.now();
  prune(now);

  const cacheKey = [
    normalizeQuery(query),
    request.orientation ?? 'any',
    requestedProviders.join(','),
    String(limit),
    mode.allowedProviders.join(',')
  ].join('|');

  const cached = cacheState().resultCache.get(cacheKey);
  if (cached) {
    const { photoCache } = cacheState();
    cached.expiresAt = now + resolveStockSearchTtls().resultTtlMs;
    for (const photo of cached.photos) {
      photoCache.set(`${cached.searchId}:${photoId(photo)}`, {
        expiresAt: now + resolveStockSearchTtls().photoTtlMs,
        query,
        orientation: request.orientation,
        photo
      });
    }
    return { ...cached.response, cached: true };
  }

  try {
    requireEnabledPaidSubmitCapForRealMode(mode.mode);
  } catch (error) {
    if (error instanceof PaidSubmitCapError) {
      throw new StockSearchError(error.message, error.status, error.code);
    }
    throw error;
  }

  const router = new StockRouter({
    store: dependencies.stateStore,
    getProvider: (id) => dependencies.registry.getProvider(id),
    order: mode.order,
    allowedProviders: mode.allowedProviders,
    reserve: resolveStockQuotaReserve(),
    now: dependencies.now
  });

  let outcome;
  try {
    outcome = await router.searchPhotos({
      query,
      orientation: request.orientation,
      preferredProviders: requestedProviders,
      limit
    });
  } catch (error) {
    if (error instanceof StockRoutingError) {
      throw new StockSearchError(error.message, error.status, 'stock.search.noProvider', error.diagnostics);
    }
    throw error;
  }

  const searchId = createId('stocksearch');
  const results: StockSearchPhoto[] = [];
  for (const photo of outcome.photos) {
    const provider = dependencies.registry.getProvider(photo.provider);
    results.push({
      id: photoId(photo),
      provider: photo.provider,
      photoId: photo.photoId,
      width: photo.width,
      height: photo.height,
      description: photo.description,
      color: photo.color,
      previewUrl: await buildPreviewUrl(provider, photo),
      imageUrl: photo.imageUrl,
      sourceUrl: photo.sourceUrl,
      photographerName: photo.photographerName,
      photographerUrl: photo.photographerUrl,
      license: photo.attribution.license,
      usagePolicy: photo.usagePolicy
    });
  }

  const response: StockSearchResponse = {
    searchId,
    query,
    orientation: request.orientation,
    cached: false,
    results,
    diagnostics: outcome.diagnostics,
    quota: outcome.quota
  };

  const { resultCache, photoCache } = cacheState();
  for (const photo of outcome.photos) {
    photoCache.set(`${searchId}:${photoId(photo)}`, {
      expiresAt: now + resolveStockSearchTtls().photoTtlMs,
      query,
      orientation: request.orientation,
      photo
    });
  }

  resultCache.set(cacheKey, {
    expiresAt: now + resolveStockSearchTtls().resultTtlMs,
    searchId,
    response,
    photos: outcome.photos
  });

  return response;
}

// Resolves a specific candidate chosen from a prior search. The photo is read
// from the server-side cache (never from client-supplied URLs), which both
// prevents SSRF via a tampered image URL and avoids a second provider search.
export function resolveStockPhoto(
  searchId: string,
  photoIdValue: string,
  dependencies: StockSearchDependencies = defaultDependencies
): StockPhotoResolution {
  const now = dependencies.now();
  const entry = cacheState().photoCache.get(`${searchId}:${photoIdValue}`);
  if (!entry || entry.expiresAt <= now) {
    throw new StockSearchError('The stock search results have expired. Run the search again.', 409, 'stock.search.expired');
  }
  return { query: entry.query, orientation: entry.orientation, photo: entry.photo };
}
