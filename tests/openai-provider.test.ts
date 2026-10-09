import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAiImageGenerationProvider } from '@/lib/ai/image-generation/openai-provider';
import { ImageGenerationProviderError } from '@/lib/ai/image-generation/provider';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9nM7kSEAAAAASUVORK5CYII=';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI provider adapter', () => {
  it('maps generation request and normalizes response', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
        status: 200,
        headers: {
          'x-request-id': 'req-123'
        }
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAiImageGenerationProvider({ apiKey: 'test-key', model: 'gpt-image-1' });
    const result = await provider.generateImage({
      prompt: 'A woman in a warm bathroom',
      aspectRatio: '16:9'
    });

    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-image-1');
    expect(result.mimeType).toBe('image/png');
    expect(result.providerRequestId).toBe('req-123');
    expect(result.data.byteLength).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails with configuration error when key is missing', async () => {
    const provider = new OpenAiImageGenerationProvider({ apiKey: '' });
    await expect(provider.generateImage({ prompt: 'test' })).rejects.toThrow(ImageGenerationProviderError);
  });

  it('returns controlled provider error on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: { message: 'Bad request to provider' } }), { status: 400 });
      })
    );

    const provider = new OpenAiImageGenerationProvider({ apiKey: 'test-key' });
    await expect(provider.generateImage({ prompt: 'test', aspectRatio: '16:9' })).rejects.toThrow(ImageGenerationProviderError);
  });
});
