import { describe, expect, it, vi } from 'vitest';

import { InMemoryStockStateStore } from '@/lib/ai/stock/stock-state-store';
import { StockProviderError, type StockProvider } from '@/lib/ai/stock/stock-provider';
import { StockRouter, StockRoutingError, stockPhotoKey } from '@/lib/ai/stock/stock-router';
import type { StockPhoto, StockProviderId, StockSearchResult } from '@/lib/types/stock';

function photo(provider: StockProviderId, index: number): StockPhoto {
  const photoId = `${provider}-${index}`;
  return {
    provider,
    photoId,
    width: 1000,
    height: 1000,
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
      license: 'Test'
    }
  };
}

function stubProvider(
  providerId: StockProviderId,
  behavior: { photos?: StockPhoto[]; configured?: boolean; fail?: StockProviderError }
): { provider: StockProvider; searchPhotos: ReturnType<typeof vi.fn> } {
  const searchPhotos = vi.fn(async (): Promise<StockSearchResult> => {
    if (behavior.fail) {
      throw behavior.fail;
    }
    const photos = behavior.photos ?? [photo(providerId, 0)];
    return { provider: providerId, query: 'x', photos };
  });

  const provider: StockProvider = {
    providerId,
    displayName: providerId,
    usagePolicy: 'download',
    license: 'Test',
    isConfigured: () => behavior.configured ?? true,
    searchPhotos,
    fetchPhoto: async () => ({ mimeType: 'image/jpeg', data: Buffer.from('x') })
  };
  return { provider, searchPhotos };
}

function buildRouter(options: {
  providers: Record<string, ReturnType<typeof stubProvider>>;
  order?: StockProviderId[];
  allowedProviders?: StockProviderId[];
  store?: InMemoryStockStateStore;
}) {
  const store = options.store ?? new InMemoryStockStateStore({ now: () => 1000 });
  const router = new StockRouter({
    store,
    getProvider: (id) => {
      const entry = options.providers[id];
      if (!entry) throw new Error(`no stub for ${id}`);
      return entry.provider;
    },
    order: options.order,
    allowedProviders: options.allowedProviders
  });
  return { router, store };
}

describe('StockRouter', () => {
  it('selects deterministically and serves subsequent calls from cache', async () => {
    const fake = stubProvider('fake', { photos: [photo('fake', 0), photo('fake', 1), photo('fake', 2), photo('fake', 3)] });
    const { router } = buildRouter({ providers: { fake }, order: ['fake'] });

    const first = await router.resolve({ query: 'forest' });
    const second = await router.resolve({ query: 'forest' });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.selection.photoId).toBe(first.selection.photoId);
    expect(fake.searchPhotos).toHaveBeenCalledTimes(1);
  });

  it('skips an excluded cached selection and picks another candidate', async () => {
    const fake = stubProvider('fake', {
      photos: [photo('fake', 0), photo('fake', 1), photo('fake', 2), photo('fake', 3)]
    });
    const { router } = buildRouter({ providers: { fake }, order: ['fake'] });

    const first = await router.resolve({ query: 'transient failure' });
    const second = await router.resolve({
      query: 'transient failure',
      excludePhotoKeys: [stockPhotoKey(first.selection)]
    });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(false);
    expect(second.selection.photoId).not.toBe(first.selection.photoId);
    expect(fake.searchPhotos).toHaveBeenCalledTimes(2);
  });

  it('falls back to the next provider on a rate limit', async () => {
    const unsplash = stubProvider('unsplash', {
      fail: new StockProviderError('rate limited', 'RATE_LIMITED', 429, { provider: 'unsplash', rateLimit: { remaining: 0, resetAt: 2000 } })
    });
    const pexels = stubProvider('pexels', { photos: [photo('pexels', 0)] });
    const { router, store } = buildRouter({ providers: { unsplash, pexels }, order: ['unsplash', 'pexels'] });

    const result = await router.resolve({ query: 'ocean' });

    expect(result.selection.provider).toBe('pexels');
    expect(result.diagnostics.map((d) => d.outcome)).toEqual(['rate_limited', 'selected']);
    // The 429 is remembered so the provider is skipped (not retried) next time.
    expect(await store.canRequest('unsplash', 0)).toBe(false);
  });

  it('skips providers that are over quota without contacting them', async () => {
    const unsplash = stubProvider('unsplash', { photos: [photo('unsplash', 0)] });
    const pexels = stubProvider('pexels', { photos: [photo('pexels', 0)] });
    const store = new InMemoryStockStateStore({ now: () => 1000 });
    const { router } = buildRouter({ providers: { unsplash, pexels }, order: ['unsplash', 'pexels'], store });
    await store.recordRateLimited('unsplash', { resetAt: 999999 });

    const result = await router.resolve({ query: 'desert' });

    expect(result.selection.provider).toBe('pexels');
    expect(unsplash.searchPhotos).not.toHaveBeenCalled();
    expect(result.diagnostics[0]).toMatchObject({ provider: 'unsplash', outcome: 'skipped_quota' });
  });

  it('never contacts providers outside the allowed set (mock lockdown)', async () => {
    const unsplash = stubProvider('unsplash', { photos: [photo('unsplash', 0)] });
    const pexels = stubProvider('pexels', { photos: [photo('pexels', 0)] });
    const fake = stubProvider('fake', { photos: [photo('fake', 0)] });
    const { router } = buildRouter({
      providers: { unsplash, pexels, fake },
      order: ['unsplash', 'pexels', 'fake'],
      allowedProviders: ['fake']
    });

    const result = await router.resolve({ query: 'city' });

    expect(result.selection.provider).toBe('fake');
    expect(unsplash.searchPhotos).not.toHaveBeenCalled();
    expect(pexels.searchPhotos).not.toHaveBeenCalled();
    expect(result.diagnostics.filter((d) => d.outcome === 'skipped_not_allowed')).toHaveLength(2);
  });

  it('skips unconfigured providers', async () => {
    const unsplash = stubProvider('unsplash', { configured: false });
    const pexels = stubProvider('pexels', { photos: [photo('pexels', 0)] });
    const { router } = buildRouter({ providers: { unsplash, pexels }, order: ['unsplash', 'pexels'] });

    const result = await router.resolve({ query: 'space' });

    expect(result.selection.provider).toBe('pexels');
    expect(unsplash.searchPhotos).not.toHaveBeenCalled();
    expect(result.diagnostics[0].outcome).toBe('skipped_unconfigured');
  });

  it('honours a preferred provider order', async () => {
    const unsplash = stubProvider('unsplash', { photos: [photo('unsplash', 0)] });
    const pexels = stubProvider('pexels', { photos: [photo('pexels', 0)] });
    const { router } = buildRouter({ providers: { unsplash, pexels }, order: ['unsplash', 'pexels'] });

    const result = await router.resolve({ query: 'mountains', preferredProviders: ['pexels'] });

    expect(result.selection.provider).toBe('pexels');
    expect(unsplash.searchPhotos).not.toHaveBeenCalled();
  });

  it('throws NO_PROVIDER_AVAILABLE when nothing can be contacted', async () => {
    const unsplash = stubProvider('unsplash', { configured: false });
    const { router } = buildRouter({ providers: { unsplash }, order: ['unsplash'] });

    await expect(router.resolve({ query: 'x' })).rejects.toMatchObject({
      code: 'NO_PROVIDER_AVAILABLE'
    });
  });

  it('rejects an empty query', async () => {
    const fake = stubProvider('fake', { photos: [photo('fake', 0)] });
    const { router } = buildRouter({ providers: { fake }, order: ['fake'] });
    await expect(router.resolve({ query: '   ' })).rejects.toBeInstanceOf(StockRoutingError);
  });
});
