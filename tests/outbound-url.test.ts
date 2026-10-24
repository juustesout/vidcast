import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertAllowedHttpsUrl,
  fetchAllowedHttps,
  isAllowedHttpsUrl,
  OPENAI_VIDEO_DOWNLOAD_ALLOWED_HOSTS,
  OutboundUrlError,
  STOCK_HOTLINK_ALLOWED_HOSTS
} from '@/lib/security/outbound-url';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assertAllowedHttpsUrl', () => {
  it('accepts an allowlisted HTTPS stock CDN host', () => {
    const parsed = assertAllowedHttpsUrl('https://images.unsplash.com/abc?w=1200', STOCK_HOTLINK_ALLOWED_HOSTS);
    expect(parsed.hostname).toBe('images.unsplash.com');
  });

  it('accepts an allowlisted HTTPS OpenAI download host', () => {
    const parsed = assertAllowedHttpsUrl(
      'https://api.openai.com/v1/videos/generations/job_1/content',
      OPENAI_VIDEO_DOWNLOAD_ALLOWED_HOSTS
    );
    expect(parsed.hostname).toBe('api.openai.com');
  });

  it.each([
    'http://127.0.0.1/secret',
    'http://localhost/secret',
    'https://localhost/secret',
    'https://127.0.0.1/secret',
    'https://10.0.0.1/secret',
    'https://192.168.1.20/secret',
    'https://169.254.1.1/secret',
    'https://[::1]/secret',
    'file:///etc/passwd',
    'ftp://images.unsplash.com/abc'
  ])('rejects %s', (url) => {
    expect(() => assertAllowedHttpsUrl(url, STOCK_HOTLINK_ALLOWED_HOSTS)).toThrow(OutboundUrlError);
    expect(isAllowedHttpsUrl(url, STOCK_HOTLINK_ALLOWED_HOSTS)).toBe(false);
  });

  it('rejects an unknown hostname even over HTTPS', () => {
    expect(() => assertAllowedHttpsUrl('https://evil.example/photo.jpg', STOCK_HOTLINK_ALLOWED_HOSTS)).toThrow(
      /allowlist/
    );
  });
});

describe('fetchAllowedHttps', () => {
  it('fetches an allowlisted URL with redirect error', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchAllowedHttps('https://images.unsplash.com/abc', STOCK_HOTLINK_ALLOWED_HOSTS, { redirect: 'follow' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://images.unsplash.com/abc');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('does not fetch an untrusted URL', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAllowedHttps('http://127.0.0.1/secret', STOCK_HOTLINK_ALLOWED_HOSTS)).rejects.toBeInstanceOf(
      OutboundUrlError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
