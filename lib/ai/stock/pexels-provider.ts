import type {
  StockPhoto,
  StockSearchQuery,
  StockSearchResult,
  StockUsagePolicy
} from '@/lib/types/stock';

import { STOCK_PROVIDER_CATALOG } from './catalog';
import { downloadStockImageBytes } from './stock-download';
import {
  StockProviderError,
  createRequestSignal,
  rateLimitFromHeaders,
  readJsonResponse,
  stockProviderFetch,
  type StockImageRef,
  type StockPhotoBytes,
  type StockProvider,
  type StockProviderContext,
  type StockProviderRequestOptions
} from './stock-provider';

const DEFAULT_BASE_URL = 'https://api.pexels.com';

type PexelsPhoto = NonNullable<PexelsSearchResponse['photos']>[number];

interface PexelsSearchResponse {
  photos?: Array<{
    id?: number;
    width?: number;
    height?: number;
    url?: string;
    photographer?: string;
    photographer_url?: string;
    avg_color?: string;
    alt?: string;
    src?: { original?: string; large2x?: string; large?: string; medium?: string; small?: string };
  }>;
}

export class PexelsStockProvider implements StockProvider {
  readonly providerId = 'pexels' as const;
  readonly displayName = STOCK_PROVIDER_CATALOG.pexels.displayName;
  readonly usagePolicy: StockUsagePolicy = STOCK_PROVIDER_CATALOG.pexels.usagePolicy;
  readonly license = STOCK_PROVIDER_CATALOG.pexels.license;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: StockProviderRequestOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.PEXELS_API_KEY;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const { fetchImpl, timeoutMs } = stockProviderFetch(options);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async searchPhotos(query: StockSearchQuery, context?: StockProviderContext): Promise<StockSearchResult> {
    if (!this.apiKey) {
      throw new StockProviderError('Pexels API key is not configured.', 'NOT_CONFIGURED', 409, { provider: 'pexels' });
    }

    const params = new URLSearchParams({
      query: query.query,
      per_page: String(query.perPage ?? STOCK_PROVIDER_CATALOG.pexels.defaultPerPage)
    });
    if (query.orientation) {
      params.set('orientation', query.orientation);
    }

    const { signal, cleanup, timedOut } = createRequestSignal(context, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/search?${params.toString()}`, {
        headers: { Authorization: this.apiKey, 'User-Agent': 'local-explainer-video-studio' },
        signal
      });
    } catch {
      cleanup();
      throw new StockProviderError(
        timedOut() ? 'Pexels request timed out.' : 'Pexels request failed.',
        'PROVIDER_ERROR',
        502,
        { provider: 'pexels' }
      );
    }
    cleanup();

    const rateLimit = rateLimitFromHeaders(response.headers);

    if (response.status === 429) {
      throw new StockProviderError('Pexels rate limit exceeded.', 'RATE_LIMITED', 429, { provider: 'pexels', rateLimit });
    }
    if (response.status === 401 || response.status === 403) {
      throw new StockProviderError('Pexels rejected the API key.', 'AUTH_FAILED', response.status, { provider: 'pexels' });
    }
    if (!response.ok) {
      throw new StockProviderError(`Pexels search failed (${response.status}).`, 'PROVIDER_ERROR', response.status, {
        provider: 'pexels',
        rateLimit
      });
    }

    const payload = (await readJsonResponse(response)) as PexelsSearchResponse;
    const photos = (payload.photos ?? [])
      .map((entry) => this.mapPhoto(entry))
      .filter((photo): photo is StockPhoto => photo !== undefined);

    if (photos.length === 0) {
      throw new StockProviderError('Pexels returned no results.', 'EMPTY_RESULT', 404, { provider: 'pexels', rateLimit });
    }

    return { provider: 'pexels', query: query.query, photos, rateLimit };
  }

  async fetchPhoto(photo: StockImageRef, context?: StockProviderContext): Promise<StockPhotoBytes> {
    const url = photo.downloadUrl ?? photo.imageUrl;
    // Pexels CDNs can throttle burst downloads independently of the API quota;
    // the shared download path applies bounded back-off and de-duplicates.
    return downloadStockImageBytes({
      provider: 'pexels',
      url,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      providerName: 'Pexels',
      context
    });
  }

  private mapPhoto(entry: PexelsPhoto): StockPhoto | undefined {
    const id = entry?.id;
    const imageUrl = entry?.src?.large ?? entry?.src?.large2x ?? entry?.src?.original;
    if (id === undefined || !imageUrl) {
      return undefined;
    }

    const photoId = String(id);
    const sourceUrl = entry?.url ?? `https://www.pexels.com/photo/${photoId}`;
    const photographerName = entry?.photographer ?? 'Unknown photographer';

    return {
      provider: 'pexels',
      photoId,
      width: entry?.width ?? 0,
      height: entry?.height ?? 0,
      imageUrl,
      downloadUrl: entry?.src?.original ?? imageUrl,
      sourceUrl,
      photographerName,
      photographerUrl: entry?.photographer_url,
      color: entry?.avg_color,
      description: entry?.alt,
      usagePolicy: this.usagePolicy,
      attribution: {
        provider: 'pexels',
        providerName: this.displayName,
        photoId,
        photographerName,
        photographerUrl: entry?.photographer_url,
        sourceUrl,
        license: this.license
      }
    };
  }
}
