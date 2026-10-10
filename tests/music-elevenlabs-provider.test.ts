import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ELEVENLABS_MUSIC_MODEL,
  DEFAULT_ELEVENLABS_MUSIC_OUTPUT_FORMAT,
  ElevenLabsMusicProvider
} from '@/lib/ai/music/elevenlabs-provider';
import { buildSilentWav } from '@/lib/ai/music/fake-provider';
import { MusicProviderError } from '@/lib/ai/music/provider';

afterEach(() => {
  vi.unstubAllGlobals();
});

function audioResponse(body: Buffer, headers: Record<string, string> = {}) {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg', ...headers }
  });
}

describe('ElevenLabs music provider adapter', () => {
  it('sends a prompt-based request and stores the binary audio result', async () => {
    const fetchMock = vi.fn(async () => audioResponse(Buffer.from('ID3fake-mp3-bytes'), { 'x-request-id': 'req-music-1', 'song-id': 'song-9' }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsMusicProvider({ apiKey: 'test-key' });
    const result = await provider.generate({ prompt: '  calm ambient  ', durationMs: 30000, instrumental: true });

    expect(result.provider).toBe('elevenlabs');
    expect(result.model).toBe(DEFAULT_ELEVENLABS_MUSIC_MODEL);
    expect(result.format).toBe('mp3');
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.providerRequestId).toBe('req-music-1');
    expect(result.metadata?.songId).toBe('song-9');
    expect(result.data.byteLength).toBeGreaterThan(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.elevenlabs.io/v1/music?output_format=${DEFAULT_ELEVENLABS_MUSIC_OUTPUT_FORMAT}`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('test-key');

    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({
      prompt: 'calm ambient',
      music_length_ms: 30000,
      model_id: DEFAULT_ELEVENLABS_MUSIC_MODEL,
      force_instrumental: true
    });
    expect('seed' in sent).toBe(false);
  });

  it('probes the audio duration from the returned file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => audioResponse(buildSilentWav(4000), { 'content-type': 'audio/wav' })));

    const provider = new ElevenLabsMusicProvider({ apiKey: 'test-key' });
    const result = await provider.generate({ prompt: 'calm', durationMs: 4000, instrumental: true });

    expect(result.mimeType).toBe('audio/wav');
    expect(result.duration).toBeCloseTo(4, 2);
  });

  it('fails with a configuration error before any request when the key is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsMusicProvider({ apiKey: '' });
    await expect(provider.generate({ prompt: 'calm', durationMs: 30000 })).rejects.toMatchObject({ code: 'NOT_CONFIGURED', status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid prompts, durations and models without calling the provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ElevenLabsMusicProvider({ apiKey: 'test-key' });

    await expect(provider.generate({ prompt: '   ', durationMs: 30000 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(provider.generate({ prompt: 'calm', durationMs: 1000 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(provider.generate({ prompt: 'calm', durationMs: 700000 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(provider.generate({ prompt: 'calm', durationMs: 30000, model: 'music_v9' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps provider auth, rate-limit and validation failures to distinct codes', async () => {
    const provider = new ElevenLabsMusicProvider({ apiKey: 'test-key' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 })));
    await expect(provider.generate({ prompt: 'calm', durationMs: 30000 })).rejects.toMatchObject({ code: 'PROVIDER_AUTH', status: 502 });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'quota' }), { status: 429 })));
    await expect(provider.generate({ prompt: 'calm', durationMs: 30000 })).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', status: 429 });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: [{ msg: 'prompt too long' }, { msg: 'bad length' }] }), { status: 422 }))
    );
    try {
      await provider.generate({ prompt: 'calm', durationMs: 30000 });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(MusicProviderError);
      expect((error as MusicProviderError).code).toBe('PROVIDER_REJECTED');
      expect((error as MusicProviderError).status).toBe(422);
      expect((error as MusicProviderError).message).toBe('prompt too long; bad length');
    }
  });

  it('rejects an empty or non-audio response body', async () => {
    const provider = new ElevenLabsMusicProvider({ apiKey: 'test-key' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.alloc(0), { status: 200, headers: { 'content-type': 'audio/mpeg' } })));
    await expect(provider.generate({ prompt: 'calm', durationMs: 30000 })).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(provider.generate({ prompt: 'calm', durationMs: 30000 })).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  });

  it('honors the caller abort signal', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
          controller.abort();
        });
      })
    );

    const provider = new ElevenLabsMusicProvider({ apiKey: 'test-key' });
    await expect(provider.generate({ prompt: 'calm', durationMs: 30000 }, { signal: controller.signal })).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
      status: 504
    });
  });
});
