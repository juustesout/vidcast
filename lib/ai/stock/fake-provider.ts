import { createHash } from 'node:crypto';
import sharp from 'sharp';

import type { StockPhoto, StockSearchQuery, StockSearchResult, StockUsagePolicy } from '@/lib/types/stock';

import { STOCK_PROVIDER_CATALOG } from './catalog';
import type { StockImageRef, StockPhotoBytes, StockProvider } from './stock-provider';

function hash(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

function channelsFromSeed(seed: string, offset: number): { r: number; g: number; b: number } {
  const slice = seed.slice(offset * 2, offset * 2 + 6).padEnd(6, '0');
  return {
    r: Number.parseInt(slice.slice(0, 2), 16) || 0,
    g: Number.parseInt(slice.slice(2, 4), 16) || 0,
    b: Number.parseInt(slice.slice(4, 6), 16) || 0
  };
}

// Deterministic, network-free stock provider used in mock mode and tests. It
// produces decodable PNG bytes so the full render pipeline can run end-to-end
// without any paid or external request.
export class FakeStockProvider implements StockProvider {
  readonly providerId = 'fake' as const;
  readonly displayName = STOCK_PROVIDER_CATALOG.fake.displayName;
  readonly usagePolicy: StockUsagePolicy = 'download';
  readonly license = STOCK_PROVIDER_CATALOG.fake.license;

  isConfigured(): boolean {
    return true;
  }

  async searchPhotos(query: StockSearchQuery): Promise<StockSearchResult> {
    const seed = hash(`${query.query}|${query.orientation ?? 'any'}`);
    const count = Math.min(Math.max(query.perPage ?? 4, 1), 8);
    const width = query.orientation === 'portrait' ? 720 : 1280;
    const height = query.orientation === 'portrait' ? 1280 : 720;
    const photos: StockPhoto[] = [];

    for (let index = 0; index < count; index += 1) {
      const photoId = `fake-${seed.slice(0, 10)}-${index}`;
      const sourceUrl = `https://fake.stock.local/photos/${photoId}`;
      photos.push({
        provider: 'fake',
        photoId,
        width,
        height,
        imageUrl: `fake-stock://${photoId}`,
        downloadUrl: `fake-stock://${photoId}`,
        sourceUrl,
        photographerName: 'Fake Photographer',
        color: channelsFromSeed(seed, index)
          .toString()
          .replace(/,/g, ':'),
        description: `${query.query} (synthetic result ${index + 1})`,
        usagePolicy: this.usagePolicy,
        attribution: {
          provider: 'fake',
          providerName: this.displayName,
          photoId,
          photographerName: 'Fake Photographer',
          sourceUrl,
          license: this.license
        }
      });
    }

    return { provider: 'fake', query: query.query, photos };
  }

  async fetchPhoto(photo: StockImageRef): Promise<StockPhotoBytes> {
    const color = channelsFromSeed(hash(photo.photoId), 0);
    const data = await sharp({
      create: {
        width: photo.width,
        height: photo.height,
        channels: 3,
        background: color
      }
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    return { mimeType: 'image/png', data };
  }
}
