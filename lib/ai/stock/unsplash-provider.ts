import type {
  StockOrientation,
  StockPhoto,
  StockSearchQuery,
  StockSearchResult,
  StockUsagePolicy
} from '@/lib/types/stock';

import { STOCK_PROVIDER_CATALOG } from './catalog';
import {
  StockProviderError,
  createRequestSignal,
  rateLimitFromHeaders,
  readJsonResponse,
  stockProviderFetch,
  type StockPhotoBytes,
  type StockProvider,
  type StockProviderContext,
  type StockProviderRequestOptions
} from './stock-provider';

const DEFAULT_BASE_URL = 'https://api.unsplash.com';

interface UnsplashSearchResponse {
  results?: Array<{
    id?: string;
    width?: number;
    height?: number;
    color?: string;
    description?: string | null;
    alt_description?: string | null;
    urls?: { raw?: string; full?: string; regular?: string; small?: string; thumb?: string };
    links?: { html?: string; download?: string; download_location?: string };
    user?: { name?: string; links?: { html?: string } };
  }>;
}

function mapOrientation(orientation: StockOrientation | undefined): string | undefined {
  return orientation ?? undefined;
}

type UnsplashPhoto = NonNullable<UnsplashSearchResponse['results']>[number];

// Unsplash requires hotlinking: the returned CDN URLs must be embedded/used
// directly and images must not be permanently re-hosted. We therefore never
// persist a durable copy; the render step references `imageUrl` transiently.
export class UnsplashStockProvider implements StockProvider {
  readonly providerId = 'unsplash' as const;
  readonly displayName = STOCK_PROVIDER_CATALOG.unsplash.displayName;
  readonly usagePolicy: StockUsagePolicy = STOCK_PROVIDER_CATALOG.unsplash.usagePolicy;
  readonly license = STOCK_PROVIDER_CATALOG.unsplash.license;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: StockProviderRequestOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.UNSPLASH_ACCESS_KEY;
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
      throw new StockProviderError('Unsplash access key is not configured.', 'NOT_CONFIGURED', 409, { provider: 'unsplash' });
    }

    const params = new URLSearchParams({
      query: query.query,
      per_page: String(query.perPage ?? STOCK_PROVIDER_CATALOG.unsplash.defaultPerPage)
    });
    const orientation = mapOrientation(query.orientation);
    if (orientation) {
      params.set('orientation', orientation);
    }

    const { signal, cleanup, timedOut } = createRequestSignal(context, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/search/photos?${params.toString()}`, {
        headers: {
          Authorization: `Client-ID ${this.apiKey}`,
          'Accept-Version': 'v1',
          'User-Agent': 'local-explainer-video-studio'
        },
        signal
      });
    } catch {
      throw new StockProviderError(
        timedOut() ? 'Unsplash request timed out.' : 'Unsplash request failed.',
        'PROVIDER_ERROR',
        502,
        { provider: 'unsplash' }
      );
    } finally {
      cleanup();
    }

    const rateLimit = rateLimitFromHeaders(response.headers);

    if (response.status === 429) {
      throw new StockProviderError('Unsplash rate limit exceeded.', 'RATE_LIMITED', 429, { provider: 'unsplash', rateLimit });
    }
    if (response.status === 401 || response.status === 403) {
      throw new StockProviderError('Unsplash rejected the access key.', 'AUTH_FAILED', response.status, { provider: 'unsplash' });
    }
    if (!response.ok) {
      throw new StockProviderError(`Unsplash search failed (${response.status}).`, 'PROVIDER_ERROR', response.status, {
        provider: 'unsplash',
        rateLimit
      });
    }

    const payload = (await readJsonResponse(response)) as UnsplashSearchResponse;
    const photos = (payload.results ?? [])
      .map((entry) => this.mapPhoto(entry))
      .filter((photo): photo is StockPhoto => photo !== undefined);

    if (photos.length === 0) {
      throw new StockProviderError('Unsplash returned no results.', 'EMPTY_RESULT', 404, { provider: 'unsplash', rateLimit });
    }

    return { provider: 'unsplash', query: query.query, photos, rateLimit };
  }

  async fetchPhoto(): Promise<StockPhotoBytes> {
    throw new StockProviderError(
      'Unsplash requires hotlinking; downloading the file is not permitted by the API guidelines.',
      'PROVIDER_ERROR',
      409,
      { provider: 'unsplash' }
    );
  }

  async trackDownload(photo: StockPhoto, context?: StockProviderContext): Promise<void> {
    if (!photo.downloadTrackingUrl || !this.apiKey) {
      return;
    }
    const { signal, cleanup } = createRequestSignal(context, this.timeoutMs);
    try {
      await this.fetchImpl(photo.downloadTrackingUrl, {
        headers: { Authorization: `Client-ID ${this.apiKey}`, 'Accept-Version': 'v1' },
        signal
      });
    } catch {
      // Accounting event only; a failure must never break a run.
    } finally {
      cleanup();
    }
  }

  private mapPhoto(entry: UnsplashPhoto): StockPhoto | undefined {
    const id = entry?.id;
    const imageUrl = entry?.urls?.regular ?? entry?.urls?.full ?? entry?.urls?.raw;
    if (!id || !imageUrl) {
      return undefined;
    }

    const sourceUrl = entry?.links?.html ?? `https://unsplash.com/photos/${id}`;
    const photographerName = entry?.user?.name ?? 'Unknown photographer';

    return {
      provider: 'unsplash',
      photoId: id,
      width: entry?.width ?? 0,
      height: entry?.height ?? 0,
      imageUrl,
      downloadUrl: entry?.links?.download,
      downloadTrackingUrl: entry?.links?.download_location,
      sourceUrl,
      photographerName,
      photographerUrl: entry?.user?.links?.html,
      color: entry?.color,
      description: entry?.description ?? entry?.alt_description ?? undefined,
      usagePolicy: this.usagePolicy,
      attribution: {
        provider: 'unsplash',
        providerName: this.displayName,
        photoId: id,
        photographerName,
        photographerUrl: entry?.user?.links?.html,
        sourceUrl,
        license: this.license
      }
    };
  }
}
