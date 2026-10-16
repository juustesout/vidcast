import type { StockProviderId, StockUsagePolicy } from '@/lib/types/stock';

import { STOCK_PROVIDER_IDS } from './catalog';
import { FakeStockProvider } from './fake-provider';
import { PexelsStockProvider } from './pexels-provider';
import { PixabayStockProvider } from './pixabay-provider';
import { StockProviderError, type StockProvider } from './stock-provider';
import { UnsplashStockProvider } from './unsplash-provider';

export interface StockProviderConfiguration {
  providerId: StockProviderId;
  configured: boolean;
  usagePolicy: StockUsagePolicy;
  envVar: string;
}

export interface StockProviderRegistry {
  getProvider(id: StockProviderId): StockProvider;
  listProviders(): StockProvider[];
  configurationStatus(): StockProviderConfiguration[];
}

class DefaultStockProviderRegistry implements StockProviderRegistry {
  getProvider(id: StockProviderId): StockProvider {
    if (id === 'unsplash') return new UnsplashStockProvider();
    if (id === 'pexels') return new PexelsStockProvider();
    if (id === 'pixabay') return new PixabayStockProvider();
    if (id === 'fake') return new FakeStockProvider();
    throw new StockProviderError(`Unknown stock provider: ${id}`, 'NOT_CONFIGURED', 400, { provider: id });
  }

  listProviders(): StockProvider[] {
    return [...STOCK_PROVIDER_IDS, 'fake' as StockProviderId].map((id) => this.getProvider(id));
  }

  configurationStatus(): StockProviderConfiguration[] {
    return this.listProviders().map((provider) => ({
      providerId: provider.providerId,
      configured: provider.isConfigured(),
      usagePolicy: provider.usagePolicy,
      envVar:
        provider.providerId === 'unsplash'
          ? 'UNSPLASH_ACCESS_KEY'
          : provider.providerId === 'pexels'
            ? 'PEXELS_API_KEY'
            : provider.providerId === 'pixabay'
              ? 'PIXABAY_API_KEY'
              : ''
    }));
  }
}

export function createStockProviderRegistry(): StockProviderRegistry {
  return new DefaultStockProviderRegistry();
}
