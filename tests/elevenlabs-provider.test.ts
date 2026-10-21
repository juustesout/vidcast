import { afterEach, describe, expect, it, vi } from 'vitest';

import { ElevenLabsTextToSpeechProvider } from '@/lib/ai/text-to-speech/elevenlabs-provider';
import { TextToSpeechProviderError } from '@/lib/ai/text-to-speech/provider';

const HELLO_ALIGNMENT = {
  characters: ['H', 'e', 'l', 'l', 'o', ' ', 'w', 'o', 'r', 'l', 'd'],
  character_start_times_seconds: [0, 0.05, 0.1, 0.15, 0.2, 0.28, 0.32, 0.4, 0.48, 0.54, 0.6],
  character_end_times_seconds: [0.05, 0.1, 0.15, 0.2, 0.28, 0.32, 0.4, 0.48, 0.54, 0.6, 0.75]
};

function timestampedSpeechResponse(audio: Buffer | string, extras?: { alignment?: unknown; requestId?: string }): Response {
  const bytes = typeof audio === 'string' ? Buffer.from(audio, 'utf8') : audio;
  return new Response(JSON.stringify({
    audio_base64: bytes.toString('base64'),
    alignment: extras?.alignment ?? null
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(extras?.requestId ? { 'x-request-id': extras.requestId } : {})
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ElevenLabs TTS provider adapter', () => {
  it('maps synthesis request and normalizes response', async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => timestampedSpeechResponse('ID3fakemp3', { requestId: 'req-tts-123', alignment: HELLO_ALIGNMENT })
    );

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
    expect(result.alignment?.words.map((word) => word.word)).toEqual(['Hello', 'world']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/text-to-speech/voice-1/with-timestamps');
    expect(String(fetchMock.mock.calls[0][0])).toContain('output_format=mp3_44100_128');
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Accept).toBe('application/json');
  });

  it.each(['m4a', 'wav'] as const)(
    'normalizes a %s request to a genuinely supported MP3 output and reports the emitted format',
    async (requested) => {
      const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
        async () => timestampedSpeechResponse('ID3fakemp3', { requestId: 'req-tts-normalized' })
      );

      vi.stubGlobal('fetch', fetchMock);

      const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key' });
      const result = await provider.synthesize({ text: 'Hello world', voiceId: 'voice-1', format: requested });

      const init = fetchMock.mock.calls[0][1];
      const body = JSON.parse(String(init?.body)) as { output_format: string };
      expect(body.output_format).toBe('mp3_44100_128');
      expect((init?.headers as Record<string, string>).Accept).toBe('application/json');
      expect(result.format).toBe('mp3');
      expect(result.mimeType).toBe('audio/mpeg');
      expect(result.metadata?.outputFormat).toBe('mp3_44100_128');
      expect(result.metadata?.requestedFormat).toBe(requested);
    }
  );

  it('keeps audio when alignment is missing and does not invent timings', async () => {
    const fetchMock = vi.fn(async () => timestampedSpeechResponse('ID3fakemp3'));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key' });
    const result = await provider.synthesize({ text: 'Hello world', voiceId: 'voice-1', format: 'mp3' });

    expect(result.data.byteLength).toBeGreaterThan(0);
    expect(result.alignment).toBeUndefined();
    expect(result.characterAlignment).toBeUndefined();
  });

  it('drops invalid alignment instead of inventing word timings', async () => {
    const fetchMock = vi.fn(async () => timestampedSpeechResponse('ID3fakemp3', {
      alignment: {
        characters: ['H', 'i'],
        character_start_times_seconds: [0.2, 0.1],
        character_end_times_seconds: [0.3, 0.4]
      }
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key' });
    const result = await provider.synthesize({ text: 'Hi', voiceId: 'voice-1', format: 'mp3' });

    expect(result.data.byteLength).toBeGreaterThan(0);
    expect(result.alignment).toBeUndefined();
  });

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
