import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { SESSION_COOKIE_NAME } from './constants';
import { getServiceToken, getSessionSecret } from './config';

export { SESSION_COOKIE_NAME };

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface RequestIdentity {
  kind: 'user' | 'service';
  subject: string;
  authType: 'session' | 'service_token';
}

interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string | null {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function signPayload(payload: string): string {
  return createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
}

function parseCookieHeader(value: string | null): Map<string, string> {
  const values = new Map<string, string>();
  if (!value) {
    return values;
  }

  for (const part of value.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) {
      continue;
    }
    values.set(rawKey, rawValue.join('='));
  }

  return values;
}

function parseAuthorizationHeader(value: string | null): { scheme: string; token: string } | null {
  if (!value) {
    return null;
  }

  const [scheme, token] = value.split(/\s+/, 2);
  if (!scheme || !token) {
    return null;
  }

  return {
    scheme: scheme.toLowerCase(),
    token
  };
}

export function generateUserSubject(): string {
  return `user_${randomUUID()}`;
}

export function createUserSessionCookie(subject = generateUserSubject(), nowMs = Date.now()): string {
  const ttlMs = Number.isFinite(Number(process.env.EXPLAINER_SESSION_TTL_MS))
    ? Math.max(60_000, Number(process.env.EXPLAINER_SESSION_TTL_MS))
    : DEFAULT_SESSION_TTL_MS;

  const payload: SessionPayload = {
    sub: subject,
    iat: nowMs,
    exp: nowMs + ttlMs
  };

  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(encoded);
  return `${encoded}.${signature}`;
}

function parseSessionCookieValue(value: string | undefined, nowMs = Date.now()): RequestIdentity | null {
  if (!value) {
    return null;
  }

  const [encodedPayload, signature] = value.split('.', 2);
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signPayload(encodedPayload);
  const providedBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  const decodedPayload = base64UrlDecode(encodedPayload);
  if (!decodedPayload) {
    return null;
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(decodedPayload) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload.sub !== 'string' || !payload.sub.trim()) {
    return null;
  }
  if (!Number.isFinite(payload.exp) || payload.exp <= nowMs) {
    return null;
  }

  return {
    kind: 'user',
    subject: payload.sub,
    authType: 'session'
  };
}

/**
 * Resolves the request identity from raw header values. The service token is
 * only accepted from the `Authorization: Bearer` header; browser subjects can
 * never be supplied directly and only come from a server-signed session cookie.
 */
export function getIdentityFromHeaders(cookieHeader: string | null, authorizationHeader: string | null): RequestIdentity | null {
  const serviceToken = getServiceToken();
  const authorization = parseAuthorizationHeader(authorizationHeader);
  if (serviceToken && authorization && authorization.scheme === 'bearer' && authorization.token === serviceToken) {
    return {
      kind: 'service',
      subject: 'service:api_token',
      authType: 'service_token'
    };
  }

  const cookies = parseCookieHeader(cookieHeader);
  return parseSessionCookieValue(cookies.get(SESSION_COOKIE_NAME));
}

export function getRequestIdentity(request: Request): RequestIdentity | null {
  return getIdentityFromHeaders(request.headers.get('cookie'), request.headers.get('authorization'));
}
