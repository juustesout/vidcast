import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as getImageGenerationStatus } from '@/app/api/image-generation/status/route';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'sk-live-should-not-leak');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/image-generation/status', () => {
  it('returns 401 without authentication and does not disclose credential presence', async () => {
    const response = await getImageGenerationStatus(new Request('http://localhost/api/image-generation/status'));
    const payload = (await response.json()) as { code?: string; openaiConfigured?: unknown };

    expect(response.status).toBe(401);
    expect(payload.code).toBe('UNAUTHENTICATED');
    expect(payload).not.toHaveProperty('openaiConfigured');
  });

  it('returns default provider without openaiConfigured for an authenticated caller', async () => {
    const response = await getImageGenerationStatus(
      new Request('http://localhost/api/image-generation/status', {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${createUserSessionCookie('user-a')}` }
      })
    );
    const payload = (await response.json()) as { defaultProvider?: string; openaiConfigured?: unknown };

    expect(response.status).toBe(200);
    expect(typeof payload.defaultProvider).toBe('string');
    expect(payload).not.toHaveProperty('openaiConfigured');
    expect(JSON.stringify(payload)).not.toContain('sk-live-should-not-leak');
  });
});
