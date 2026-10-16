import type { StockProviderId, StockUsagePolicy } from '@/lib/types/stock';

// Documented, per-provider defaults (verified against official API docs on
// 2026-10-16, see p27-stock-image-router.md). Live response headers always take
// precedence over these values; they are only the fail-safe fallback used before
// a provider has reported its own limits.
export interface StockProviderCatalogEntry {
  providerId: StockProviderId;
  displayName: string;
  usagePolicy: StockUsagePolicy;
  envVar: string;
  license: string;
  // Primary rolling window used for quota gating.
  windowSeconds: number;
  // Documented default for the primary window.
  windowLimit: number;
  // Documented monthly cap, when the provider has one.
  monthlyLimit?: number;
  defaultPerPage: number;
  maxPerPage: number;
  // Provider docs page, surfaced in reports/MCP.
  docsUrl: string;
}

export const STOCK_PROVIDER_CATALOG: Record<StockProviderId, StockProviderCatalogEntry> = {
  unsplash: {
    providerId: 'unsplash',
    displayName: 'Unsplash',
    usagePolicy: 'hotlink',
    envVar: 'UNSPLASH_ACCESS_KEY',
    license: 'Unsplash License',
    windowSeconds: 3600,
    windowLimit: 50,
    defaultPerPage: 10,
    maxPerPage: 30,
    docsUrl: 'https://unsplash.com/documentation'
  },
  pexels: {
    providerId: 'pexels',
    displayName: 'Pexels',
    usagePolicy: 'download',
    envVar: 'PEXELS_API_KEY',
    license: 'Pexels License',
    windowSeconds: 3600,
    windowLimit: 200,
    monthlyLimit: 20000,
    defaultPerPage: 10,
    maxPerPage: 80,
    docsUrl: 'https://www.pexels.com/api/documentation/'
  },
  pixabay: {
    providerId: 'pixabay',
    displayName: 'Pixabay',
    usagePolicy: 'download',
    envVar: 'PIXABAY_API_KEY',
    license: 'Pixabay Content License',
    // Pixabay reports 100 requests / 60 seconds, associated with the API key.
    windowSeconds: 60,
    windowLimit: 100,
    defaultPerPage: 10,
    maxPerPage: 200,
    docsUrl: 'https://pixabay.com/api/docs/'
  },
  fake: {
    providerId: 'fake',
    displayName: 'Fake (local)',
    usagePolicy: 'download',
    envVar: '',
    license: 'Synthetic fixture',
    windowSeconds: 3600,
    windowLimit: 100000,
    defaultPerPage: 10,
    maxPerPage: 50,
    docsUrl: ''
  }
};

export const STOCK_PROVIDER_IDS: StockProviderId[] = ['unsplash', 'pexels', 'pixabay'];

export function isStockProviderId(value: string): value is StockProviderId {
  return Object.prototype.hasOwnProperty.call(STOCK_PROVIDER_CATALOG, value);
}

export function resolveStockProviderOrder(raw?: string): StockProviderId[] {
  const configured = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is StockProviderId => isStockProviderId(entry));

  const seen = new Set<StockProviderId>();
  const order: StockProviderId[] = [];
  for (const id of [...configured, ...STOCK_PROVIDER_IDS]) {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  return order;
}
