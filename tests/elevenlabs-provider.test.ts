import { afterEach, describe, expect, it, vi } from 'vitest';

import { ElevenLabsTextToSpeechProvider } from '@/lib/ai/text-to-speech/elevenlabs-provider';
import { TextToSpeechProviderError } from '@/lib/ai/text-to-speech/provider';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ElevenLabs TTS provider adapter', () => {
  it('maps synthesis request and normalizes response', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(Buffer.from('ID3fakemp3', 'utf8'), {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg',
          'x-request-id': 'req-tts-123'
        }
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key', model: 'eleven_turbo_v2' });
    const result = await provider.synthesize({
      text: 'Hello world',
      voiceId: 'voice-1',
      format: 'mp3'
    });

    expect(result.provider).toBe('elevenlabs');
    expect(result.model).toBe('eleven_turbo_v2');
    expect(result.format).toBe('mp3');
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.providerRequestId).toBe('req-tts-123');
    expect(result.data.byteLength).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['m4a', 'wav'] as const)(
    'normalizes a %s request to a genuinely supported MP3 output and reports the emitted format',
    async (requested) => {
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
        return new Response(Buffer.from('ID3fakemp3', 'utf8'), {
          status: 200,
          headers: {
            'content-type': 'audio/mpeg',
            'x-request-id': 'req-tts-normalized'
          }
        });
      });

      vi.stubGlobal('fetch', fetchMock);

      const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key' });
      const result = await provider.synthesize({ text: 'Hello world', voiceId: 'voice-1', format: requested });

      const init = fetchMock.mock.calls[0][1];
      const body = JSON.parse(String(init?.body)) as { output_format: string };
      expect(body.output_format).toBe('mp3_44100_128');
      expect((init?.headers as Record<string, string>).Accept).toBe('audio/mpeg');
      expect(result.format).toBe('mp3');
      expect(result.mimeType).toBe('audio/mpeg');
      expect(result.metadata?.outputFormat).toBe('mp3_44100_128');
      expect(result.metadata?.requestedFormat).toBe(requested);
    }
  );

  it('fails with configuration error when key is missing', async () => {
    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: '' });
    await expect(
      provider.synthesize({ text: 'test', voiceId: 'voice-1', format: 'mp3' })
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('returns controlled provider error on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(JSON.stringify({ detail: { message: 'Invalid voice' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      })
    );

    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key' });
    await expect(
      provider.synthesize({ text: 'test', voiceId: 'voice-invalid', format: 'mp3' })
    ).rejects.toMatchObject({ code: 'PROVIDER_REJECTED', status: 422 });
  });

  it.each([
    [401, 'PROVIDER_AUTH'],
    [403, 'PROVIDER_AUTH'],
    [429, 'PROVIDER_RATE_LIMIT'],
    [500, 'PROVIDER_FAILED']
  ] as const)('classifies HTTP %i as %s without retrying', async (status, code) => {
    const fetchMock = vi.fn(async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key' });
    await expect(
      provider.synthesize({ text: 'test', voiceId: 'voice-1', format: 'mp3' })
    ).rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a transport failure to a provider error without leaking details', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key' });
    await expect(
      provider.synthesize({ text: 'test', voiceId: 'voice-1', format: 'mp3' })
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED', status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts a stalled request after the bounded timeout and does not retry', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key', timeoutMs: 10 });
    await expect(
      provider.synthesize({ text: 'test', voiceId: 'voice-1', format: 'mp3' })
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED', status: 504 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a caller abort signal', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key', timeoutMs: 10_000 });
    const promise = provider.synthesize({ text: 'test', voiceId: 'voice-1', format: 'mp3' }, { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(TextToSpeechProviderError);
  });
});
