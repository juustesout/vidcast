import type {
  StockOrientation,
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

const DEFAULT_BASE_URL = 'https://pixabay.com/api';

type PixabayHit = NonNullable<PixabaySearchResponse['hits']>[number];

interface PixabaySearchResponse {
  hits?: Array<{
    id?: number;
    pageURL?: string;
    tags?: string;
    previewURL?: string;
    webformatURL?: string;
    largeImageURL?: string;
    imageWidth?: number;
    imageHeight?: number;
    user?: string;
  }>;
}

function mapOrientation(orientation: StockOrientation | undefined): string | undefined {
  if (orientation === 'landscape') return 'horizontal';
  if (orientation === 'portrait') return 'vertical';
  return undefined;
}

// Pixabay forbids permanent hotlinking; images must be downloaded to the server.
// We fetch and persist a durable asset and render from it.
export class PixabayStockProvider implements StockProvider {
  readonly providerId = 'pixabay' as const;
  readonly displayName = STOCK_PROVIDER_CATALOG.pixabay.displayName;
  readonly usagePolicy: StockUsagePolicy = STOCK_PROVIDER_CATALOG.pixabay.usagePolicy;
  readonly license = STOCK_PROVIDER_CATALOG.pixabay.license;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: StockProviderRequestOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.PIXABAY_API_KEY;
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
      throw new StockProviderError('Pixabay API key is not configured.', 'NOT_CONFIGURED', 409, { provider: 'pixabay' });
    }

    const catalog = STOCK_PROVIDER_CATALOG.pixabay;
    const requested = query.perPage ?? catalog.defaultPerPage;
    const perPage = Math.min(Math.max(requested, 3), catalog.maxPerPage);
    const params = new URLSearchParams({
      key: this.apiKey,
      q: query.query,
      image_type: 'photo',
      safesearch: 'true',
      per_page: String(perPage)
    });
    const orientation = mapOrientation(query.orientation);
    if (orientation) {
      params.set('orientation', orientation);
    }

    const { signal, cleanup, timedOut } = createRequestSignal(context, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/?${params.toString()}`, { signal });
    } catch {
      cleanup();
      throw new StockProviderError(
        timedOut() ? 'Pixabay request timed out.' : 'Pixabay request failed.',
        'PROVIDER_ERROR',
        502,
        { provider: 'pixabay' }
      );
    }
    cleanup();

    // Pixabay reports its reset as seconds remaining, not an epoch.
    const rateLimit = rateLimitFromHeaders(response.headers, { resetIsSecondsRemaining: true });

    if (response.status === 429) {
      throw new StockProviderError('Pixabay rate limit exceeded.', 'RATE_LIMITED', 429, { provider: 'pixabay', rateLimit });
    }
    if (response.status === 401 || response.status === 403) {
      throw new StockProviderError('Pixabay rejected the API key.', 'AUTH_FAILED', response.status, { provider: 'pixabay' });
    }
    if (!response.ok) {
      throw new StockProviderError(`Pixabay search failed (${response.status}).`, 'PROVIDER_ERROR', response.status, {
        provider: 'pixabay',
        rateLimit
      });
    }

    const payload = (await readJsonResponse(response)) as PixabaySearchResponse;
    const photos = (payload.hits ?? [])
      .map((entry) => this.mapPhoto(entry))
      .filter((photo): photo is StockPhoto => photo !== undefined);

    if (photos.length === 0) {
      throw new StockProviderError('Pixabay returned no results.', 'EMPTY_RESULT', 404, { provider: 'pixabay', rateLimit });
    }

    return { provider: 'pixabay', query: query.query, photos, rateLimit };
  }

  async fetchPhoto(photo: StockImageRef, context?: StockProviderContext): Promise<StockPhotoBytes> {
    const url = photo.downloadUrl ?? photo.imageUrl;
    // Pixabay's image CDN rate-limits independently of the search API quota; the
    // download path applies bounded back-off and de-duplicates concurrent calls.
    return downloadStockImageBytes({
      provider: 'pixabay',
      url,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      providerName: 'Pixabay',
      context
    });
  }

  private mapPhoto(entry: PixabayHit): StockPhoto | undefined {
    const id = entry?.id;
    const imageUrl = entry?.largeImageURL ?? entry?.webformatURL;
    if (id === undefined || !imageUrl) {
      return undefined;
    }

    const photoId = String(id);
    const sourceUrl = entry?.pageURL ?? `https://pixabay.com/photos/${photoId}`;
    const photographerName = entry?.user ?? 'Unknown contributor';

    return {
      provider: 'pixabay',
      photoId,
      width: entry?.imageWidth ?? 0,
      height: entry?.imageHeight ?? 0,
      imageUrl,
      downloadUrl: imageUrl,
      sourceUrl,
      photographerName,
      description: entry?.tags?.split(',').slice(0, 3).join(', ').trim(),
      usagePolicy: this.usagePolicy,
      attribution: {
        provider: 'pixabay',
        providerName: this.displayName,
        photoId,
        photographerName,
        sourceUrl,
        license: this.license
      }
    };
  }
}
