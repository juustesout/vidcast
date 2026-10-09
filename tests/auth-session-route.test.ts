import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/storage/project-store', () => ({
  projectStore: {
    claimUnownedProjects: vi.fn(async () => 0)
  }
}));

import { POST, GET } from '@/app/api/auth/session/route';
import { createUserSessionCookie, getIdentityFromHeaders, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { projectStore } from '@/lib/storage/project-store';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('EXPLAINER_API_TOKEN', undefined);
  vi.stubEnv('EXPLAINER_SESSION_SECRET', undefined);
  vi.mocked(projectStore.claimUnownedProjects).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function readSessionCookie(response: Response): string | null {
  const header = response.headers.get('set-cookie');
  if (!header) {
    return null;
  }
  const match = header.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

describe('session issuance', () => {
  it('issues a server-generated anonymous session in local mode', async () => {
    const response = await POST(new Request('http://localhost/api/auth/session', { method: 'POST' }));

    expect(response.status).toBe(201);
    const cookie = readSessionCookie(response);
    expect(cookie).toBeTruthy();

    const identity = getIdentityFromHeaders(`${SESSION_COOKIE_NAME}=${cookie}`, null);
    expect(identity?.kind).toBe('user');
    expect(identity?.subject).toMatch(/^user_/);
    expect(projectStore.claimUnownedProjects).toHaveBeenCalledWith(identity?.subject);
  });

  it('ignores a client-supplied subject', async () => {
    const response = await POST(
      new Request('http://localhost/api/auth/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sub: 'attacker-controlled', subject: 'attacker-controlled' })
      })
    );

    const cookie = readSessionCookie(response);
    const identity = getIdentityFromHeaders(`${SESSION_COOKIE_NAME}=${cookie}`, null);

    expect(identity?.subject).not.toBe('attacker-controlled');
    expect(identity?.subject).toMatch(/^user_/);
  });

  it('returns the existing identity without reissuing a cookie', async () => {
    const cookie = createUserSessionCookie('user-existing');
    const response = await POST(
      new Request('http://localhost/api/auth/session', {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ authenticated: true, subject: 'user-existing' });
  });

  it('refuses to mint anonymous sessions in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const response = await POST(new Request('http://localhost/api/auth/session', { method: 'POST' }));

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(projectStore.claimUnownedProjects).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: 'AUTH_SESSION_DISABLED' });
  });

  it('reports unauthenticated status on GET', async () => {
    const response = await GET(new Request('http://localhost/api/auth/session'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ authenticated: false });
  });
});
