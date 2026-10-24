import { isIP } from 'node:net';

export class OutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundUrlError';
  }
}

export const STOCK_HOTLINK_ALLOWED_HOSTS = ['images.unsplash.com'] as const;

export const OPENAI_VIDEO_API_HOST = 'api.openai.com';
export const OPENAI_VIDEO_DOWNLOAD_ALLOWED_HOSTS = ['api.openai.com', 'files.oaiusercontent.com'] as const;

function hostnameAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((entry) => host === entry.toLowerCase());
}

export function assertAllowedHttpsUrl(raw: string, allowedHosts: readonly string[]): URL {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new OutboundUrlError('Outbound URL is missing.');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OutboundUrlError('Outbound URL is invalid.');
  }

  if (parsed.protocol !== 'https:') {
    throw new OutboundUrlError('Outbound URL must use HTTPS.');
  }

  if (parsed.username || parsed.password) {
    throw new OutboundUrlError('Outbound URL must not include credentials.');
  }

  if (parsed.port !== '' && parsed.port !== '443') {
    throw new OutboundUrlError('Outbound URL must use the default HTTPS port.');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new OutboundUrlError('Outbound URL host is not allowed.');
  }

  if (isIP(hostname)) {
    throw new OutboundUrlError('Outbound URL host must not be an IP address.');
  }

  if (!hostnameAllowed(hostname, allowedHosts)) {
    throw new OutboundUrlError('Outbound URL host is not on the allowlist.');
  }

  return parsed;
}

export function isAllowedHttpsUrl(raw: string, allowedHosts: readonly string[]): boolean {
  try {
    assertAllowedHttpsUrl(raw, allowedHosts);
    return true;
  } catch (error) {
    if (error instanceof OutboundUrlError) {
      return false;
    }
    throw error;
  }
}

export async function fetchAllowedHttps(
  raw: string,
  allowedHosts: readonly string[],
  init: RequestInit = {}
): Promise<Response> {
  const parsed = assertAllowedHttpsUrl(raw, allowedHosts);
  return fetch(parsed.href, {
    ...init,
    redirect: 'error'
  });
}
