import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchRemoteSourceToFile, SceneRenderError } from '@/lib/render/renderer';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchRemoteSourceToFile', () => {
  it('fetches an allowlisted Unsplash CDN URL with redirect error', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-source-'));

    const written = await fetchRemoteSourceToFile('https://images.unsplash.com/abc?w=1200', tempDir, 'scene-remote');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://images.unsplash.com/abc?w=1200');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
    expect(written.endsWith('.jpg')).toBe(true);
    expect((await fs.readFile(written)).length).toBe(4);
  });

  it.each(['http://127.0.0.1/secret', 'https://evil.example/photo.jpg', 'file:///etc/passwd'])(
    'does not fetch untrusted URL %s',
    async (url) => {
      const fetchMock = vi.fn(async () => new Response('nope', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-source-deny-'));

      await expect(fetchRemoteSourceToFile(url, tempDir, 'scene-remote')).rejects.toBeInstanceOf(SceneRenderError);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});
