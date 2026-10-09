import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SecurityConfigurationError,
  assertSecurityConfiguration,
  getSecurityMode,
  getSessionSecret,
  isAnonymousSessionAllowed
} from '@/lib/security/config';

afterEach(() => {
  vi.unstubAllEnvs();
});

function clearSecurityEnv() {
  vi.stubEnv('EXPLAINER_SECURITY_MODE', undefined);
  vi.stubEnv('EXPLAINER_SESSION_SECRET', undefined);
  vi.stubEnv('EXPLAINER_API_TOKEN', undefined);
}

describe('security configuration', () => {
  it('defaults to local mode outside production', () => {
    clearSecurityEnv();
    vi.stubEnv('NODE_ENV', 'development');

    expect(getSecurityMode()).toBe('local');
    expect(isAnonymousSessionAllowed()).toBe(true);
  });

  it('forces production mode when NODE_ENV is production, even if local mode is requested', () => {
    clearSecurityEnv();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EXPLAINER_SECURITY_MODE', 'local');

    expect(getSecurityMode()).toBe('production');
    expect(isAnonymousSessionAllowed()).toBe(false);
  });

  it('honors an explicit local mode outside production', () => {
    clearSecurityEnv();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('EXPLAINER_SECURITY_MODE', 'local');

    expect(getSecurityMode()).toBe('local');
  });

  it('uses the explicit development secret outside production', () => {
    clearSecurityEnv();
    vi.stubEnv('NODE_ENV', 'test');

    expect(getSessionSecret()).toBe('explainer-local-dev-session-secret');
  });

  it('rejects a missing session secret in production', () => {
    clearSecurityEnv();
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => getSessionSecret()).toThrow(SecurityConfigurationError);
  });

  it('rejects the development default secret in production', () => {
    clearSecurityEnv();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EXPLAINER_SESSION_SECRET', 'explainer-local-dev-session-secret');

    expect(() => getSessionSecret()).toThrow(SecurityConfigurationError);
  });

  it('rejects a weak session secret in production', () => {
    clearSecurityEnv();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EXPLAINER_SESSION_SECRET', 'short');

    expect(() => getSessionSecret()).toThrow(SecurityConfigurationError);
  });

  it('accepts a strong session secret in production', () => {
    clearSecurityEnv();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EXPLAINER_SESSION_SECRET', 'a'.repeat(48));

    expect(getSessionSecret()).toBe('a'.repeat(48));
  });

  it('fails startup validation when the service token is missing or weak in production', () => {
    clearSecurityEnv();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EXPLAINER_SESSION_SECRET', 'a'.repeat(48));

    expect(() => assertSecurityConfiguration()).toThrow(SecurityConfigurationError);

    vi.stubEnv('EXPLAINER_API_TOKEN', 'short');
    expect(() => assertSecurityConfiguration()).toThrow(SecurityConfigurationError);
  });

  it('passes startup validation with strong secrets in production', () => {
    clearSecurityEnv();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EXPLAINER_SESSION_SECRET', 'a'.repeat(48));
    vi.stubEnv('EXPLAINER_API_TOKEN', 'b'.repeat(48));

    expect(() => assertSecurityConfiguration()).not.toThrow();
  });
});
