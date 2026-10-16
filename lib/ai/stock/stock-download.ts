import type { StockProviderId } from '@/lib/types/stock';

import {
  createRequestSignal,
  StockProviderError,
  type StockPhotoBytes,
  type StockProviderContext
} from './stock-provider';

// Provider image CDNs (e.g. `pixabay.com/get/...`) apply their own throttling
// that is entirely separate from the search API quota. A burst of downloads can
// return HTTP 429 even while the API reports plenty of remaining quota, so a
// download failure must never be recorded against the API quota and must be
// retried with a bounded back-off rather than hammered.
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 400;
const DEFAULT_MAX_DELAY_MS = 8000;

// Concurrent fetches of the same URL are shared so a burst of scenes requesting
// the same image issues exactly one CDN request. `globalThis` keeps the map
// shared across separate route/module instances within the process.
interface InFlightDownloads {
  pending: Map<string, Promise<StockPhotoBytes>>;
}

const DOWNLOAD_GLOBAL_KEY = '__explainerStockDownloads__';

function inFlightDownloads(): InFlightDownloads {
  const globalRef = globalThis as typeof globalThis & {
    [DOWNLOAD_GLOBAL_KEY]?: InFlightDownloads;
  };
  globalRef[DOWNLOAD_GLOBAL_KEY] ??= { pending: new Map<string, Promise<StockPhotoBytes>>() };
  return globalRef[DOWNLOAD_GLOBAL_KEY];
}

export interface StockDownloadRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function resolveStockDownloadRetryPolicy(env: NodeJS.ProcessEnv = process.env): StockDownloadRetryPolicy {
  return {
    maxRetries: clampInt(env.STOCK_DOWNLOAD_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0, 6),
    baseDelayMs: clampInt(env.STOCK_DOWNLOAD_BASE_DELAY_MS, DEFAULT_BASE_DELAY_MS, 0, 60_000),
    maxDelayMs: clampInt(env.STOCK_DOWNLOAD_MAX_DELAY_MS, DEFAULT_MAX_DELAY_MS, 0, 120_000)
  };
}

export interface DownloadStockImageOptions {
  provider: StockProviderId;
  url: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  // Human-readable provider name for messages, e.g. "Pixabay".
  providerName: string;
  context?: StockProviderContext;
  policy?: StockDownloadRetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// Internal error shape: carries whether a retry may help and, for HTTP 429/503,
// the server-suggested `Retry-After` delay. Never exposed to callers.
interface RetryableStockProviderError extends StockProviderError {
  retryable?: boolean;
  retryAfterMs?: number;
}

function markRetryable(error: StockProviderError, retryAfterMs?: number): StockProviderError {
  const enriched = error as RetryableStockProviderError;
  enriched.retryable = true;
  if (retryAfterMs !== undefined) {
    enriched.retryAfterMs = retryAfterMs;
  }
  return error;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

// Parses a `Retry-After` header (delta-seconds or HTTP-date). Returns undefined
// when the header is absent or unparseable.
function parseRetryAfter(headers: Headers, now: number): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.max(0, date - now);
  }
  return undefined;
}

async function fetchOnce(options: DownloadStockImageOptions): Promise<StockPhotoBytes> {
  const { signal, cleanup, timedOut } = createRequestSignal(options.context, options.timeoutMs);
  let response: Response;
  try {
    response = await options.fetchImpl(options.url, { signal });
  } catch (error) {
    cleanup();
    if (options.context?.signal?.aborted) {
      throw error;
    }
    // Timeouts and transport resets are retryable: CDNs commonly drop the first
    // connection of a burst. The caller loop bounds the total attempts.
    throw markRetryable(
      new StockProviderError(
        timedOut() ? `${options.providerName} image download timed out.` : `${options.providerName} image download failed.`,
        'PROVIDER_ERROR',
        502,
        { provider: options.provider }
      )
    );
  }
  cleanup();

  if (response.status === 429) {
    throw markRetryable(
      new StockProviderError(`${options.providerName} image CDN rate limited the download.`, 'RATE_LIMITED', 429, {
        provider: options.provider
      }),
      parseRetryAfter(response.headers, Date.now())
    );
  }
  if (isRetryableStatus(response.status)) {
    throw markRetryable(
      new StockProviderError(`${options.providerName} image CDN returned ${response.status}.`, 'PROVIDER_ERROR', response.status, {
        provider: options.provider
      }),
      parseRetryAfter(response.headers, Date.now())
    );
  }
  if (!response.ok) {
    throw new StockProviderError(`${options.providerName} image download failed (${response.status}).`, 'PROVIDER_ERROR', response.status, {
      provider: options.provider
    });
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    mimeType: response.headers.get('content-type') ?? 'image/jpeg',
    data: Buffer.from(arrayBuffer)
  };
}

function isRetryableError(error: unknown): boolean {
  return error instanceof StockProviderError && (error as RetryableStockProviderError).retryable === true;
}

function retryDelay(error: unknown, policy: StockDownloadRetryPolicy, attempt: number, random: () => number): number {
  const hinted = error instanceof StockProviderError ? (error as RetryableStockProviderError).retryAfterMs : undefined;
  // A `Retry-After: 0` (several CDNs emit this on 429) is not a useful hint and
  // must not collapse into an immediate re-request: fall back to the computed
  // back-off so retries stay spaced out and within the provider's window.
  if (hinted !== undefined && hinted > 0) {
    return Math.min(policy.maxDelayMs, hinted);
  }
  // Exponential back-off with jitter so concurrent retries do not re-synchronise.
  const exponential = policy.baseDelayMs * 2 ** attempt;
  const jitter = 0.5 + random() * 0.5;
  return Math.min(policy.maxDelayMs, Math.round(exponential * jitter));
}

async function downloadWithRetry(options: DownloadStockImageOptions): Promise<StockPhotoBytes> {
  const policy = options.policy ?? resolveStockDownloadRetryPolicy();
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
    try {
      return await fetchOnce(options);
    } catch (error) {
      lastError = error;
      if (options.context?.signal?.aborted || attempt >= policy.maxRetries || !isRetryableError(error)) {
        throw error;
      }
      const delay = retryDelay(error, policy, attempt, random);
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new StockProviderError(`${options.providerName} image download failed.`, 'PROVIDER_ERROR', 502, { provider: options.provider });
}

// Downloads image bytes for a `download`-policy provider with bounded retry and
// in-flight de-duplication. The same URL is never fetched concurrently twice.
export async function downloadStockImageBytes(options: DownloadStockImageOptions): Promise<StockPhotoBytes> {
  const state = inFlightDownloads();
  const key = `${options.provider}:${options.url}`;
  const existing = state.pending.get(key);
  if (existing) {
    return existing;
  }

  const promise = downloadWithRetry(options).finally(() => {
    state.pending.delete(key);
  });
  state.pending.set(key, promise);
  return promise;
}

// Test-only: clears the in-flight download registry.
export function resetStockDownloadsForTests(): void {
  const globalRef = globalThis as typeof globalThis & {
    [DOWNLOAD_GLOBAL_KEY]?: InFlightDownloads;
  };
  delete globalRef[DOWNLOAD_GLOBAL_KEY];
}
