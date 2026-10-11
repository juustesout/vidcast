import { afterEach, describe, expect, it, vi } from 'vitest';

import { ElevenLabsTextToSpeechProvider } from '@/lib/ai/text-to-speech/elevenlabs-provider';
import { TextToSpeechProviderError } from '@/lib/ai/text-to-speech/provider';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ElevenLabs TTS provider adapter', () => {
  it('maps synthesis request and normalizes response', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(Buffer.from('RIFFfakewav', 'utf8'), {
        status: 200,
        headers: {
          'content-type': 'audio/wav',
          'x-request-id': 'req-tts-123'
        }
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key', model: 'eleven_turbo_v2' });
    const result = await provider.synthesize({
      text: 'Hello world',
      voiceId: 'voice-1',
      format: 'wav'
    });

    expect(result.provider).toBe('elevenlabs');
    expect(result.model).toBe('eleven_turbo_v2');
    expect(result.mimeType).toBe('audio/wav');
    expect(result.providerRequestId).toBe('req-tts-123');
    expect(result.data.byteLength).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes an m4a request to a genuinely supported MP3 output and reports the emitted format', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(Buffer.from('ID3fakemp3', 'utf8'), {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg',
          'x-request-id': 'req-tts-m4a'
        }
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key' });
    const result = await provider.synthesize({ text: 'Hello world', voiceId: 'voice-1', format: 'm4a' });

    const init = fetchMock.mock.calls[0][1];
    const body = JSON.parse(String(init?.body)) as { output_format: string };
    expect(body.output_format).toBe('mp3_44100_128');
    expect((init?.headers as Record<string, string>).Accept).toBe('audio/mpeg');
    expect(result.format).toBe('mp3');
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.metadata?.outputFormat).toBe('mp3_44100_128');
    expect(result.metadata?.requestedFormat).toBe('m4a');
  });

  it('fails with configuration error when key is missing', async () => {
    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: '' });
    await expect(
      provider.synthesize({ text: 'test', voiceId: 'voice-1', format: 'mp3' })
    ).rejects.toThrow(TextToSpeechProviderError);
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
    ).rejects.toThrow(TextToSpeechProviderError);
  });
});
