import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearProjectMusicRequest, generateProjectMusicRequest, selectProjectMusicRequest } from '@/lib/client/music-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('music client', () => {
  it('sends an explicit generate request with the form payload', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'generated', assetId: 'asset-1', generationAttemptId: 'attempt-1', duration: 30 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateProjectMusicRequest('project-1', { prompt: 'calm', musicLengthMs: 30000, instrumental: true });

    expect(result.ok).toBe(true);
    expect(result.assetId).toBe('asset-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/projects/project-1/music');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'generate',
      prompt: 'calm',
      musicLengthMs: 30000,
      instrumental: true
    });
  });

  it('uses the regenerate action when replacing an existing track', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'generated', assetId: 'asset-2' }));
    vi.stubGlobal('fetch', fetchMock);

    await generateProjectMusicRequest('project-1', { prompt: 'calm', musicLengthMs: 30000, instrumental: false, regenerate: true });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).action).toBe('regenerate');
  });

  it('maps failures to friendly messages and never retries', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'server detail', code: 'music.alreadyGenerated' }, 409));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateProjectMusicRequest('project-1', { prompt: 'calm', musicLengthMs: 30000, instrumental: true });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('music.alreadyGenerated');
    expect(result.message).toContain('Regenerate');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('selects an existing asset without deleting anything', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'generated', assetId: 'asset-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await selectProjectMusicRequest('project-1', 'asset-1');

    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ action: 'select', assetId: 'asset-1' });
    expect(init.method).toBe('POST');
  });

  it('clears the selection via the clear action and keeps the file', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'cleared' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await clearProjectMusicRequest('project-1');

    expect(result.ok).toBe(true);
    expect(result.message).toContain('kept');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ action: 'clear' });
    expect(init.method).toBe('POST');
  });
});
