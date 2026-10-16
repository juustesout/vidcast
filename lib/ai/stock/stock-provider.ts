import type {
  StockPhoto,
  StockProviderId,
  StockRateLimitSnapshot,
  StockSearchQuery,
  StockSearchResult,
  StockUsagePolicy
} from '@/lib/types/stock';

export interface StockProviderContext {
  signal?: AbortSignal;
}

export interface StockPhotoBytes {
  mimeType: string;
  data: Buffer;
}

// Minimal shape needed to fetch an image's bytes. A persisted `StockSelection`
// structurally satisfies this, so the service can pass it directly.
export interface StockImageRef {
  provider: StockProviderId;
  photoId: string;
  imageUrl: string;
  downloadUrl?: string;
  width: number;
  height: number;
}

export interface StockProvider {
  readonly providerId: StockProviderId;
  readonly displayName: string;
  readonly usagePolicy: StockUsagePolicy;
  readonly license: string;
  // True when the server has the credentials required to call the real API.
  isConfigured(): boolean;
  searchPhotos(query: StockSearchQuery, context?: StockProviderContext): Promise<StockSearchResult>;
  // Fetches the raw bytes for a selected photo. Only used for `download`-policy
  // providers; `hotlink` providers are referenced by URL at render time instead.
  fetchPhoto(photo: StockImageRef, context?: StockProviderContext): Promise<StockPhotoBytes>;
  // Accounting event some providers require on an actual download (Unsplash).
  trackDownload?(photo: StockPhoto, context?: StockProviderContext): Promise<void>;
}

export type StockProviderErrorCode =
  | 'NOT_CONFIGURED'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'EMPTY_RESULT';

export class StockProviderError extends Error {
  readonly code: StockProviderErrorCode;
  readonly status: number;
  readonly provider?: StockProviderId;
  readonly rateLimit?: StockRateLimitSnapshot;

  constructor(
    message: string,
    code: StockProviderErrorCode,
    status: number,
    options: { provider?: StockProviderId; rateLimit?: StockRateLimitSnapshot } = {}
  ) {
    super(message);
    this.name = 'StockProviderError';
    this.code = code;
    this.status = status;
    this.provider = options.provider;
    this.rateLimit = options.rateLimit;
  }
}

export interface StockProviderRequestOptions {
  apiKey?: string;
  baseUrl?: string;
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function stockProviderFetch(
  options: StockProviderRequestOptions
): { fetchImpl: typeof fetch; timeoutMs: number } {
  return {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? 15000
  };
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new StockProviderError('Stock provider returned malformed JSON.', 'PROVIDER_ERROR', response.status);
  }
}

export function rateLimitFromHeaders(
  headers: Headers,
  options: { resetIsSecondsRemaining?: boolean } = {}
): StockRateLimitSnapshot | undefined {
  const limit = parseHeaderInt(headers.get('x-ratelimit-limit'));
  const remaining = parseHeaderInt(headers.get('x-ratelimit-remaining'));
  const resetRaw = headers.get('x-ratelimit-reset');

  if (limit === undefined && remaining === undefined && resetRaw === null) {
    return undefined;
  }

  let resetAt: number | undefined;
  const resetValue = resetRaw === null ? undefined : Number(resetRaw);
  if (resetValue !== undefined && Number.isFinite(resetValue)) {
    // Pexels reports a UNIX epoch (seconds); Pixabay reports seconds remaining.
    resetAt = options.resetIsSecondsRemaining ? Date.now() + resetValue * 1000 : resetValue * 1000;
  }

  return { limit, remaining, resetAt };
}

function parseHeaderInt(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Combines the caller's abort signal with a hard timeout so a stuck provider
// request can never hang a run.
export function createRequestSignal(
  context: StockProviderContext | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onAbort = () => controller.abort();
  if (context?.signal) {
    if (context.signal.aborted) {
      controller.abort();
    } else {
      context.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      context?.signal?.removeEventListener('abort', onAbort);
    },
    timedOut: () => timedOut
  };
}
