import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PixabayStockProvider } from '@/lib/ai/stock/pixabay-provider';
import {
  downloadStockImageBytes,
  resetStockDownloadsForTests,
  resolveStockDownloadRetryPolicy
} from '@/lib/ai/stock/stock-download';

function imageResponse(status = 200, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]), {
    status,
    headers: { 'content-type': 'image/jpeg', ...headers }
  });
}

function baseOptions(fetchImpl: typeof fetch) {
  return {
    provider: 'pixabay' as const,
    url: 'https://cdn.pixabay.example/get/abc_1280.jpg',
    fetchImpl,
    timeoutMs: 1000,
    providerName: 'Pixabay',
    policy: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 },
    sleep: vi.fn(async () => {}),
    random: () => 0.5
  };
}

describe('stock CDN download resilience', () => {
  beforeEach(() => {
    resetStockDownloadsForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('retries a rate-limited CDN download and then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(imageResponse(429))
      .mockResolvedValueOnce(imageResponse(429))
      .mockResolvedValueOnce(imageResponse(200));
    const options = baseOptions(fetchImpl as unknown as typeof fetch);

    const bytes = await downloadStockImageBytes(options);

    expect(bytes.mimeType).toBe('image/jpeg');
    expect(bytes.data.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(options.sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after the bounded number of retries with a clear RATE_LIMITED error', async () => {
    const fetchImpl = vi.fn(async () => imageResponse(429));
    const options = baseOptions(fetchImpl as unknown as typeof fetch);

    await expect(downloadStockImageBytes(options)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429
    });
    // 3 retries => 4 total attempts, then stop (never unbounded).
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('honours a Retry-After header for the back-off delay', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(imageResponse(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(imageResponse(200));
    const options = {
      ...baseOptions(fetchImpl as unknown as typeof fetch),
      policy: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 5000 }
    };

    await downloadStockImageBytes(options);

    expect(options.sleep).toHaveBeenCalledWith(2000);
  });

  it('does not collapse a Retry-After of 0 into an immediate re-request', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(imageResponse(429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(imageResponse(200));
    const options = baseOptions(fetchImpl as unknown as typeof fetch);

    await downloadStockImageBytes(options);

    // Falls back to exponential back-off (base 10ms * jitter 0.75 = 8ms), not 0.
    expect(options.sleep).toHaveBeenCalledWith(8);
  });

  it('does not retry a non-retryable client error', async () => {
    const fetchImpl = vi.fn(async () => imageResponse(404));
    const options = baseOptions(fetchImpl as unknown as typeof fetch);

    await expect(downloadStockImageBytes(options)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      status: 404
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never issues two concurrent downloads for the same URL', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return imageResponse(200);
    });
    const options = baseOptions(fetchImpl as unknown as typeof fetch);

    const first = downloadStockImageBytes(options);
    const second = downloadStockImageBytes(options);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a.data.equals(b.data)).toBe(true);
  });

  it('treats different URLs as separate downloads', async () => {
    const fetchImpl = vi.fn(async () => imageResponse(200));
    await Promise.all([
      downloadStockImageBytes({ ...baseOptions(fetchImpl as unknown as typeof fetch), url: 'https://cdn.example/a.jpg' }),
      downloadStockImageBytes({ ...baseOptions(fetchImpl as unknown as typeof fetch), url: 'https://cdn.example/b.jpg' })
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('wires bounded retries into the Pixabay provider download path', async () => {
    vi.stubEnv('STOCK_DOWNLOAD_MAX_RETRIES', '2');
    vi.stubEnv('STOCK_DOWNLOAD_BASE_DELAY_MS', '0');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(imageResponse(429))
      .mockResolvedValueOnce(imageResponse(429))
      .mockResolvedValueOnce(imageResponse(200));

    const provider = new PixabayStockProvider({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    const bytes = await provider.fetchPhoto({
      provider: 'pixabay',
      photoId: '1',
      imageUrl: 'https://cdn.example/p.jpg',
      downloadUrl: 'https://cdn.example/p.jpg',
      width: 100,
      height: 100
    });

    expect(bytes.data.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('reads the retry policy from the environment with safe clamps', () => {
    expect(resolveStockDownloadRetryPolicy({} as NodeJS.ProcessEnv)).toEqual({
      maxRetries: 3,
      baseDelayMs: 400,
      maxDelayMs: 8000
    });
    expect(resolveStockDownloadRetryPolicy({ STOCK_DOWNLOAD_MAX_RETRIES: '99', STOCK_DOWNLOAD_BASE_DELAY_MS: 'not-a-number' } as unknown as NodeJS.ProcessEnv))
      .toMatchObject({ maxRetries: 6, baseDelayMs: 400 });
  });
});
