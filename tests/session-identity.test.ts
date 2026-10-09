import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUserSessionCookie, getIdentityFromHeaders, SESSION_COOKIE_NAME } from '@/lib/security/auth';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('EXPLAINER_API_TOKEN', undefined);
  vi.stubEnv('EXPLAINER_SESSION_SECRET', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('session cookie integrity', () => {
  it('accepts a server-signed session cookie', () => {
    const cookie = createUserSessionCookie('user-a');

    const identity = getIdentityFromHeaders(`${SESSION_COOKIE_NAME}=${cookie}`, null);

    expect(identity).toMatchObject({ kind: 'user', subject: 'user-a', authType: 'session' });
  });

  it('rejects a cookie with a forged signature', () => {
    const cookie = createUserSessionCookie('user-a');
    const [payload] = cookie.split('.');

    expect(getIdentityFromHeaders(`${SESSION_COOKIE_NAME}=${payload}.deadbeefdeadbeef`, null)).toBeNull();
  });

  it('rejects a tampered payload even when the signature format is valid', () => {
    const cookie = createUserSessionCookie('user-a');
    const signature = cookie.split('.')[1];
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'user-b', iat: Date.now(), exp: Date.now() + 60_000 }),
      'utf8'
    ).toString('base64url');

    expect(getIdentityFromHeaders(`${SESSION_COOKIE_NAME}=${forgedPayload}.${signature}`, null)).toBeNull();
  });

  it('rejects an expired cookie', () => {
    const expiredAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const cookie = createUserSessionCookie('user-a', expiredAt);

    expect(getIdentityFromHeaders(`${SESSION_COOKIE_NAME}=${cookie}`, null)).toBeNull();
  });

  it('accepts the configured service token and ignores a user cookie', () => {
    vi.stubEnv('EXPLAINER_API_TOKEN', 'service-token-123');
    const cookie = createUserSessionCookie('user-a');

    const identity = getIdentityFromHeaders(`${SESSION_COOKIE_NAME}=${cookie}`, 'Bearer service-token-123');

    expect(identity).toMatchObject({ kind: 'service', authType: 'service_token' });
  });

  it('does not treat an arbitrary bearer token as a service identity', () => {
    vi.stubEnv('EXPLAINER_API_TOKEN', 'service-token-123');

    expect(getIdentityFromHeaders(null, 'Bearer other-token')).toBeNull();
  });
});
