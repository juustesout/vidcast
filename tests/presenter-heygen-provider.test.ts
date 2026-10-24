import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildHeyGenVideoPayload,
  HeyGenPresenterProvider,
  resolveHeyGenPresenterEngine,
  resolveHeyGenResolution
} from '@/lib/ai/presenter/heygen-provider';
import type { PresenterSubmitRequest } from '@/lib/ai/presenter/provider';

const request: PresenterSubmitRequest = {
  avatarId: 'look-photo-1',
  audio: {
    data: Buffer.from('audio'),
    mimeType: 'audio/mpeg',
    duration: 3.58,
    filename: 'narration.mp3'
  },
  outputFormat: 'mp4',
  aspectRatio: '16:9',
  width: 1920,
  height: 1080,
  title: 'Pilot'
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('HeyGen presenter provider', () => {
  it('defaults to Avatar III and emits the v3 resolution/aspect_ratio schema', () => {
    expect(resolveHeyGenPresenterEngine({})).toBe('avatar_iii');
    expect(resolveHeyGenResolution(1080)).toBe('1080p');
    expect(resolveHeyGenResolution(720)).toBe('720p');

    const payload = buildHeyGenVideoPayload(request, 'asset-1', 'avatar_iii');
    expect(payload).toEqual({
      type: 'avatar',
      avatar_id: 'look-photo-1',
      audio_asset_id: 'asset-1',
      title: 'Pilot',
      output_format: 'mp4',
      aspect_ratio: '16:9',
      resolution: '1080p',
      engine: { type: 'avatar_iii' }
    });
    expect(payload).not.toHaveProperty('dimension');
    expect(payload).not.toHaveProperty('script');
    expect(payload).not.toHaveProperty('voice_id');
  });

  it('selects Avatar III through the environment and rejects unknown engines', () => {
    expect(resolveHeyGenPresenterEngine({ HEYGEN_PRESENTER_ENGINE: 'avatar_iii' })).toBe('avatar_iii');
    expect(resolveHeyGenPresenterEngine({ HEYGEN_PRESENTER_ENGINE: 'Avatar_III' })).toBe('avatar_iii');
    expect(resolveHeyGenPresenterEngine({ HEYGEN_PRESENTER_ENGINE: 'avatar_iv' })).toBe('avatar_iv');
    expect(() => resolveHeyGenPresenterEngine({ HEYGEN_PRESENTER_ENGINE: 'avatar_ii' })).toThrow(
      /Unsupported HEYGEN_PRESENTER_ENGINE/
    );
  });

  it('submits the existing audio asset with the selected engine and no TTS fields', async () => {
    vi.stubEnv('HEYGEN_API_KEY', 'test-key');
    vi.stubEnv('HEYGEN_PRESENTER_ENGINE', 'avatar_iii');

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ data: { id: 'audio-asset-1' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { video_id: 'video-1', status: 'waiting' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new HeyGenPresenterProvider();
    const result = await provider.submit(request);

    expect(result).toEqual({ providerJobId: 'video-1', providerStatus: 'waiting' });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://api.heygen.com/v3/assets');
    expect(calls[1].url).toBe('https://api.heygen.com/v3/videos');

    const body = JSON.parse(String(calls[1].init?.body));
    expect(body).toMatchObject({
      type: 'avatar',
      avatar_id: 'look-photo-1',
      audio_asset_id: 'audio-asset-1',
      output_format: 'mp4',
      aspect_ratio: '16:9',
      resolution: '1080p',
      engine: { type: 'avatar_iii' }
    });
    expect(body).not.toHaveProperty('script');
    expect(body).not.toHaveProperty('voice_id');
    expect(body).not.toHaveProperty('dimension');
    expect(JSON.stringify(body)).not.toContain('test-key');
  });

  it('does not echo HeyGen failure_code or failure_message to callers', async () => {
    vi.stubEnv('HEYGEN_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              id: 'video-1',
              status: 'failed',
              failure_code: 'rendering_failed',
              failure_message: 'Avatar rendering timed out'
            }
          }),
          { status: 200 }
        )
      )
    );

    const provider = new HeyGenPresenterProvider();
    await expect(provider.getStatus('video-1')).resolves.toMatchObject({
      status: 'failed',
      providerStatus: 'failed',
      error: 'Provider request failed.'
    });
  });

  it('does not echo HeyGen HTTP error bodies', async () => {
    vi.stubEnv('HEYGEN_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ message: 'invalid api key test-key' }), { status: 401 })
      )
    );

    const provider = new HeyGenPresenterProvider();
    await expect(provider.getStatus('video-1')).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'Provider request failed.'
    });
  });

  it('reads the remaining USD wallet balance for cost observation', async () => {
    vi.stubEnv('HEYGEN_API_KEY', 'test-key');
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(JSON.stringify({
          data: { wallet: { remaining_balance: 14.93, currency: 'USD' } }
        }), { status: 200 });
      })
    );

    const provider = new HeyGenPresenterProvider();
    await expect(provider.getBillingBalanceUsd()).resolves.toBe(14.93);
    expect(calls).toEqual(['https://api.heygen.com/v3/users/me']);
  });
});
