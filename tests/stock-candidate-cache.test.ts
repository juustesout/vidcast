import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StockProviderRegistry } from '@/lib/ai/stock/registry';
import type { StockProvider } from '@/lib/ai/stock/stock-provider';
import { InMemoryStockStateStore } from '@/lib/ai/stock/stock-state-store';
import type { StockPhoto, StockSearchResult } from '@/lib/types/stock';

// Regression for P30/F1: the stock search route and the select-stock-image route
// load the stock-search-service module as separate instances (separate route
// bundles). A search performed by one instance must still be resolvable by
// another, otherwise the manual `choose` path fails with "expired".

function fakePhoto(index: number): StockPhoto {
  const photoId = `fake-${index}`;
  return {
    provider: 'fake',
    photoId,
    width: 1280,
    height: 720,
    imageUrl: `fake-stock://${photoId}`,
    downloadUrl: `fake-stock://${photoId}`,
    sourceUrl: `https://fake.stock.local/${photoId}`,
    photographerName: 'Fake Photographer',
    usagePolicy: 'download',
    attribution: {
      provider: 'fake',
      providerName: 'Fake (local)',
      photoId,
      photographerName: 'Fake Photographer',
      sourceUrl: `https://fake.stock.local/${photoId}`,
      license: 'Synthetic fixture'
    }
  };
}

function buildOverrides(searchPhotos: ReturnType<typeof vi.fn>) {
  const provider: StockProvider = {
    providerId: 'fake',
    displayName: 'Fake (local)',
    usagePolicy: 'download',
    license: 'Synthetic fixture',
    isConfigured: () => true,
    searchPhotos: searchPhotos as StockProvider['searchPhotos'],
    fetchPhoto: async () => ({ mimeType: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex') })
  };

  const registry: StockProviderRegistry = {
    getProvider: (id) => {
      if (id !== 'fake') {
        throw new Error(`no stub provider for ${id}`);
      }
      return provider;
    },
    listProviders: () => [provider],
    configurationStatus: () => []
  };

  return {
    registry,
    stateStore: new InMemoryStockStateStore({ now: () => 1000 }),
    now: () => 1000
  };
}

describe('stock candidate cache across module instances', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('resolves a candidate searched by a different module instance (separate route bundle)', async () => {
    const modA = await import('@/lib/ai/stock/stock-search-service');
    modA.resetStockSearchCacheForTests();

    const searchPhotos = vi.fn(async (): Promise<StockSearchResult> => ({
      provider: 'fake',
      query: 'x',
      photos: [fakePhoto(0), fakePhoto(1)]
    }));
    const deps = modA.buildStockSearchDependencies(buildOverrides(searchPhotos));

    const first = await modA.searchStockPhotos({ query: 'mountains sunset', mode: 'mock' }, deps);
    expect(first.results.length).toBe(2);

    // Simulate the select-stock-image route loading its own copy of the module.
    vi.resetModules();
    const modB = await import('@/lib/ai/stock/stock-search-service');
    expect(modB).not.toBe(modA);

    const resolved = modB.resolveStockPhoto(first.searchId, first.results[1].id, deps);
    expect(resolved.photo.photoId).toBe(first.results[1].photoId);
    expect(resolved.query).toBe('mountains sunset');
    // The provider must not be re-queried just to resolve a cached candidate.
    expect(searchPhotos).toHaveBeenCalledTimes(1);
  });

  it('shares the deduplicated result cache across module instances', async () => {
    const modA = await import('@/lib/ai/stock/stock-search-service');
    modA.resetStockSearchCacheForTests();

    const searchPhotos = vi.fn(async (): Promise<StockSearchResult> => ({
      provider: 'fake',
      query: 'x',
      photos: [fakePhoto(0)]
    }));
    const deps = modA.buildStockSearchDependencies(buildOverrides(searchPhotos));

    const first = await modA.searchStockPhotos({ query: 'ocean waves', mode: 'mock' }, deps);

    vi.resetModules();
    const modB = await import('@/lib/ai/stock/stock-search-service');
    const second = await modB.searchStockPhotos({ query: 'ocean waves', mode: 'mock' }, deps);

    expect(second.cached).toBe(true);
    expect(second.searchId).toBe(first.searchId);
    expect(searchPhotos).toHaveBeenCalledTimes(1);
  });

  it('still expires candidates after the TTL, even across module instances', async () => {
    const modA = await import('@/lib/ai/stock/stock-search-service');
    modA.resetStockSearchCacheForTests();

    const deps = modA.buildStockSearchDependencies(buildOverrides(vi.fn(async (): Promise<StockSearchResult> => ({
      provider: 'fake',
      query: 'x',
      photos: [fakePhoto(0)]
    }))));

    const first = await modA.searchStockPhotos({ query: 'expiring', mode: 'mock' }, deps);

    vi.resetModules();
    const modB = await import('@/lib/ai/stock/stock-search-service');
    const later = { ...deps, now: () => 1000 + 16 * 60 * 1000 };
    expect(() => modB.resolveStockPhoto(first.searchId, first.results[0].id, later)).toThrowError(/expired/i);
  });

  it('rejects an unknown candidate id (server-side validation)', async () => {
    const mod = await import('@/lib/ai/stock/stock-search-service');
    mod.resetStockSearchCacheForTests();
    const deps = mod.buildStockSearchDependencies(buildOverrides(vi.fn(async (): Promise<StockSearchResult> => ({
      provider: 'fake',
      query: 'x',
      photos: [fakePhoto(0)]
    }))));

    const first = await mod.searchStockPhotos({ query: 'anything', mode: 'mock' }, deps);
    expect(() => mod.resolveStockPhoto(first.searchId, 'fake:does-not-exist', deps)).toThrowError(/expired/i);
  });
});
