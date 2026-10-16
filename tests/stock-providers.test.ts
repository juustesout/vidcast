import { describe, expect, it, vi } from 'vitest';

import { FakeStockProvider } from '@/lib/ai/stock/fake-provider';
import { PexelsStockProvider } from '@/lib/ai/stock/pexels-provider';
import { PixabayStockProvider } from '@/lib/ai/stock/pixabay-provider';
import { StockProviderError } from '@/lib/ai/stock/stock-provider';
import { UnsplashStockProvider } from '@/lib/ai/stock/unsplash-provider';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
  });
}

describe('UnsplashStockProvider', () => {
  it('maps results as hotlink photos and reports rate limits', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          results: [
            {
              id: 'abc123',
              width: 4000,
              height: 3000,
              color: '#aabbcc',
              description: 'A cat',
              urls: { regular: 'https://images.unsplash.com/photo-1' },
              links: {
                html: 'https://unsplash.com/photos/abc123',
                download: 'https://unsplash.com/photos/abc123/download',
                download_location: 'https://api.unsplash.com/photos/abc123/download'
              },
              user: { name: 'Jane Doe', links: { html: 'https://unsplash.com/@jane' } }
            }
          ]
        },
        { headers: { 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '49' } }
      )
    );

    const provider = new UnsplashStockProvider({ apiKey: 'key', fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await provider.searchPhotos({ query: 'cats' });

    expect(result.photos).toHaveLength(1);
    const photo = result.photos[0];
    expect(photo.provider).toBe('unsplash');
    expect(photo.usagePolicy).toBe('hotlink');
    expect(photo.imageUrl).toBe('https://images.unsplash.com/photo-1');
    expect(photo.attribution.photographerName).toBe('Jane Doe');
    expect(photo.downloadTrackingUrl).toBe('https://api.unsplash.com/photos/abc123/download');
    expect(result.rateLimit).toEqual({ limit: 50, remaining: 49, resetAt: undefined });
  });

  it('refuses to download hotlink-only files', async () => {
    const provider = new UnsplashStockProvider({ apiKey: 'key', fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch });
    await expect(provider.fetchPhoto()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('maps HTTP 429 to a RATE_LIMITED error', async () => {
    const provider = new UnsplashStockProvider({
      apiKey: 'key',
      fetchImpl: (async () => new Response('nope', { status: 429, headers: { 'x-ratelimit-remaining': '0' } })) as unknown as typeof fetch
    });
    await expect(provider.searchPhotos({ query: 'cats' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('rejects when not configured', async () => {
    const provider = new UnsplashStockProvider({ apiKey: '', fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch });
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.searchPhotos({ query: 'cats' })).rejects.toBeInstanceOf(StockProviderError);
  });
});

describe('PexelsStockProvider', () => {
  it('maps a download-policy photo and parses epoch reset', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          photos: [
            {
              id: 42,
              width: 5000,
              height: 3000,
              url: 'https://www.pexels.com/photo/42',
              photographer: 'Alex',
              photographer_url: 'https://www.pexels.com/@alex',
              avg_color: '#123456',
              alt: 'sea',
              src: { original: 'https://images.pexels.com/photos/42/original.jpg', large: 'https://images.pexels.com/photos/42/large.jpg' }
            }
          ]
        },
        { headers: { 'x-ratelimit-limit': '20000', 'x-ratelimit-remaining': '19999', 'x-ratelimit-reset': '1700000000' } }
      )
    );

    const provider = new PexelsStockProvider({ apiKey: 'key', fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await provider.searchPhotos({ query: 'sea' });

    expect(result.photos[0].provider).toBe('pexels');
    expect(result.photos[0].usagePolicy).toBe('download');
    expect(result.photos[0].imageUrl).toBe('https://images.pexels.com/photos/42/large.jpg');
    expect(result.rateLimit).toEqual({ limit: 20000, remaining: 19999, resetAt: 1700000000 * 1000 });
  });
});

describe('PixabayStockProvider', () => {
  it('maps hits and treats reset as seconds remaining', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          hits: [
            {
              id: 7,
              pageURL: 'https://pixabay.com/photos/7',
              tags: 'sky, blue, clouds',
              largeImageURL: 'https://pixabay.com/get/7_1920.jpg',
              imageWidth: 1920,
              imageHeight: 1080,
              user: 'Kim'
            }
          ]
        },
        { headers: { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '99', 'x-ratelimit-reset': '30' } }
      )
    );

    const now = Date.now();
    const provider = new PixabayStockProvider({ apiKey: 'key', fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await provider.searchPhotos({ query: 'sky' });

    expect(result.photos[0].provider).toBe('pixabay');
    expect(result.photos[0].usagePolicy).toBe('download');
    expect(result.photos[0].sourceUrl).toBe('https://pixabay.com/photos/7');
    expect(result.rateLimit?.limit).toBe(100);
    expect(result.rateLimit?.remaining).toBe(99);
    expect(result.rateLimit?.resetAt).toBeGreaterThanOrEqual(now + 29_000);
  });

  it('maps HTTP 429 to RATE_LIMITED', async () => {
    const provider = new PixabayStockProvider({
      apiKey: 'key',
      fetchImpl: (async () => new Response('API rate limit exceeded', { status: 429 })) as unknown as typeof fetch
    });
    await expect(provider.searchPhotos({ query: 'sky' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('FakeStockProvider', () => {
  it('is deterministic and produces decodable PNG bytes', async () => {
    const provider = new FakeStockProvider();
    const first = await provider.searchPhotos({ query: 'city', orientation: 'landscape' });
    const second = await provider.searchPhotos({ query: 'city', orientation: 'landscape' });

    expect(first.photos.map((p) => p.photoId)).toEqual(second.photos.map((p) => p.photoId));
    expect(first.photos[0].usagePolicy).toBe('download');

    const bytes = await provider.fetchPhoto(first.photos[0]);
    expect(bytes.mimeType).toBe('image/png');
    // PNG magic number.
    expect(bytes.data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});
