import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadEnsureAnonymousSession() {
  return (await import('@/components/session/session-bootstrap')).ensureAnonymousSession;
}

describe('SessionBootstrap single-flight initialization', () => {
  it('issues one request for concurrent callers', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const ensureAnonymousSession = await loadEnsureAnonymousSession();
    const [first, second] = await Promise.all([ensureAnonymousSession(), ensureAnonymousSession()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(201);
    expect(second).toBe(201);
  });

  it('does not re-request after a definitive session response', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const ensureAnonymousSession = await loadEnsureAnonymousSession();
    await ensureAnonymousSession();
    await ensureAnonymousSession();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries after a network failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const ensureAnonymousSession = await loadEnsureAnonymousSession();

    expect(await ensureAnonymousSession()).toBe(0);
    expect(await ensureAnonymousSession()).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('session initialization ownership', () => {
  it('keeps SessionBootstrap as the only caller of /api/auth/session', () => {
    const workspace = fs.readFileSync(path.join(process.cwd(), 'components/project/project-workspace.tsx'), 'utf8');
    const bootstrap = fs.readFileSync(path.join(process.cwd(), 'components/session/session-bootstrap.tsx'), 'utf8');

    expect(workspace).not.toContain("fetch('/api/auth/session'");
    expect(workspace).not.toContain('api/auth/session');
    expect(bootstrap).toContain("fetch('/api/auth/session'");
  });
});
