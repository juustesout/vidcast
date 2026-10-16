import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StockProviderRegistry } from '@/lib/ai/stock/registry';
import type { StockProvider } from '@/lib/ai/stock/stock-provider';
import {
  buildStockSearchDependencies,
  resetStockSearchCacheForTests,
  resolveStockPhoto,
  searchStockPhotos,
  StockSearchError
} from '@/lib/ai/stock/stock-search-service';
import { InMemoryStockStateStore } from '@/lib/ai/stock/stock-state-store';
import type { StockPhoto, StockProviderId, StockSearchResult } from '@/lib/types/stock';

function photo(provider: StockProviderId, index: number): StockPhoto {
  const photoId = `${provider}-${index}`;
  return {
    provider,
    photoId,
    width: 1200,
    height: 800,
    imageUrl: `https://cdn.local/${photoId}.jpg`,
    downloadUrl: `https://cdn.local/${photoId}.jpg`,
    sourceUrl: `https://${provider}.local/${photoId}`,
    photographerName: 'Photographer',
    usagePolicy: provider === 'unsplash' ? 'hotlink' : 'download',
    attribution: {
      provider,
      providerName: provider,
      photoId,
      photographerName: 'Photographer',
      sourceUrl: `https://${provider}.local/${photoId}`,
      license: 'Test License'
    }
  };
}

function stubProvider(
  providerId: StockProviderId,
  behavior: { photos?: StockPhoto[]; configured?: boolean; fail?: Error } = {}
): { provider: StockProvider; searchPhotos: ReturnType<typeof vi.fn> } {
  const searchPhotos = vi.fn(async (): Promise<StockSearchResult> => {
    if (behavior.fail) {
      throw behavior.fail;
    }
    return { provider: providerId, query: 'x', photos: behavior.photos ?? [photo(providerId, 0)] };
  });
  const provider: StockProvider = {
    providerId,
    displayName: providerId,
    usagePolicy: 'download',
    license: 'Test License',
    isConfigured: () => behavior.configured ?? true,
    searchPhotos,
    fetchPhoto: async () => ({ mimeType: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex') })
  };
  return { provider, searchPhotos };
}

function registry(providers: Record<string, StockProvider>): StockProviderRegistry {
  return {
    getProvider: (id) => {
      const provider = providers[id];
      if (!provider) {
        throw new Error(`no stub provider for ${id}`);
      }
      return provider;
    },
    listProviders: () => Object.values(providers),
    configurationStatus: () => []
  };
}

function deps(providers: Record<string, { provider: StockProvider }>) {
  const byId: Record<string, StockProvider> = {};
  for (const [id, entry] of Object.entries(providers)) {
    byId[id] = entry.provider;
  }
  return buildStockSearchDependencies({
    registry: registry(byId),
    stateStore: new InMemoryStockStateStore({ now: () => 1000 }),
    now: () => 1000
  });
}

describe('searchStockPhotos', () => {
  beforeEach(() => {
    resetStockSearchCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns fake candidates in mock mode and builds inline previews', async () => {
    const fake = stubProvider('fake', { photos: [photo('fake', 0), photo('fake', 1)] });

    const result = await searchStockPhotos({ query: 'mountains' }, deps({ fake }));

    expect(result.searchId).toBeTruthy();
    expect(result.cached).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].provider).toBe('fake');
    expect(result.results[0].previewUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(result.quota.some((entry) => entry.provider === 'fake')).toBe(true);
  });

  it('deduplicates an identical search instead of calling the provider twice', async () => {
    const fake = stubProvider('fake', { photos: [photo('fake', 0)] });
    const dependencies = deps({ fake });

    const first = await searchStockPhotos({ query: 'ocean  blue' }, dependencies);
    const second = await searchStockPhotos({ query: 'Ocean Blue' }, dependencies);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.searchId).toBe(first.searchId);
    expect(fake.searchPhotos).toHaveBeenCalledTimes(1);
  });

  it('resolves a cached photo by search id for a later selection', async () => {
    const fake = stubProvider('fake', { photos: [photo('fake', 0), photo('fake', 1)] });
    const dependencies = deps({ fake });
    const result = await searchStockPhotos({ query: 'city' }, dependencies);

    const resolution = resolveStockPhoto(result.searchId, result.results[1].id, dependencies);
    expect(resolution.photo.photoId).toBe(result.results[1].photoId);
    expect(resolution.query).toBe('city');
  });

  it('rejects an unknown/expired search id', async () => {
    expect(() => resolveStockPhoto('missing', 'fake-0')).toThrowError(/expired/i);
  });

  it('rejects an empty query', async () => {
    await expect(searchStockPhotos({ query: '   ' }, deps({}))).rejects.toMatchObject({
      code: 'stock.search.missingQuery'
    });
  });

  it('rejects a provider filter that is not available in the current mode', async () => {
    const fake = stubProvider('fake');
    await expect(
      searchStockPhotos({ query: 'x', providers: ['unsplash' as StockProviderId] }, deps({ fake }))
    ).rejects.toMatchObject({ code: 'stock.search.noProviders' });
  });

  it('refuses real mode when the server disallows real providers', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'false');
    const fake = stubProvider('fake');
    await expect(searchStockPhotos({ query: 'x', mode: 'real' }, deps({ fake }))).rejects.toMatchObject({
      status: 403,
      code: 'stock.policy.denied'
    });
  });

  it('searches real providers when explicitly allowed', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('PRODUCTION_RUN_DEFAULT_MODE', 'real');
    const pexels = stubProvider('pexels', { photos: [photo('pexels', 0)] });

    const result = await searchStockPhotos({ query: 'sunset', mode: 'real' }, deps({ pexels }));

    expect(result.results[0].provider).toBe('pexels');
    expect(result.results[0].previewUrl).toBe('https://cdn.local/pexels-0.jpg');
    expect(pexels.searchPhotos).toHaveBeenCalledTimes(1);
  });

  it('exposes quota feedback without leaking configuration secrets', async () => {
    const unsplash = stubProvider('unsplash', { configured: false });
    const fake = stubProvider('fake');
    const result = await searchStockPhotos({ query: 'x' }, deps({ unsplash, fake }));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/key|secret|token/i);
    expect(result.diagnostics.some((entry) => entry.provider === 'unsplash')).toBe(true);
  });
});
