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
    await expect(provider.generateImage({ prompt: 'test', aspectRatio: '16:9' })).rejects.toMatchObject({
      code: 'provider.request.rejected',
      message: 'Provider rejected the request.'
    });
  });

  it('rejects provider output that is not a valid PNG before it can be stored', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('this is not a png').toString('base64') }] }), { status: 200 });
      })
    );

    const provider = new OpenAiImageGenerationProvider({ apiKey: 'test-key' });
    await expect(provider.generateImage({ prompt: 'test', aspectRatio: '16:9' })).rejects.toMatchObject({
      code: 'provider.response.invalidImage'
    });
  });

  it('aborts a stalled request and surfaces a typed timeout error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
        return new Response('{}');
      })
    );

    const provider = new OpenAiImageGenerationProvider({ apiKey: 'test-key', timeoutMs: 5 });
    await expect(provider.generateImage({ prompt: 'test' })).rejects.toMatchObject({
      status: 504,
      code: 'provider.request.timeout'
    });
  });

  it('distinguishes unauthorized and rate-limited responses', async () => {
    const provider = new OpenAiImageGenerationProvider({ apiKey: 'test-key' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 401 })));
    await expect(provider.generateImage({ prompt: 'test' })).rejects.toMatchObject({
      status: 502,
      code: 'provider.request.unauthorized'
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 })));
    await expect(provider.generateImage({ prompt: 'test' })).rejects.toMatchObject({
      status: 429,
      code: 'provider.request.rateLimited'
    });
  });

  it('forwards an abort signal and issues a single request', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAiImageGenerationProvider({ apiKey: 'test-key' });
    const controller = new AbortController();
    await provider.generateImage({ prompt: 'test', aspectRatio: '16:9' }, { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('omits response_format for gpt-image models and includes it for dall-e', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), { status: 200 });
      })
    );

    await new OpenAiImageGenerationProvider({ apiKey: 'test-key', model: 'gpt-image-1' }).generateImage({ prompt: 'test', aspectRatio: '16:9' });
    await new OpenAiImageGenerationProvider({ apiKey: 'test-key', model: 'dall-e-3' }).generateImage({ prompt: 'test', aspectRatio: '16:9' });

    expect(bodies[0]).not.toHaveProperty('response_format');
    expect(bodies[1]).toHaveProperty('response_format', 'b64_json');
  });

  it('maps aspect ratios to model-specific sizes', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), { status: 200 });
      })
    );

    await new OpenAiImageGenerationProvider({ apiKey: 'k', model: 'gpt-image-1' }).generateImage({ prompt: 'test', aspectRatio: '16:9' });
    await new OpenAiImageGenerationProvider({ apiKey: 'k', model: 'dall-e-3' }).generateImage({ prompt: 'test', aspectRatio: '16:9' });
    await new OpenAiImageGenerationProvider({ apiKey: 'k', model: 'dall-e-3' }).generateImage({ prompt: 'test', aspectRatio: '9:16' });
    await new OpenAiImageGenerationProvider({ apiKey: 'k', model: 'dall-e-3' }).generateImage({ prompt: 'test', aspectRatio: '1:1' });
    await new OpenAiImageGenerationProvider({ apiKey: 'k', model: 'dall-e-2' }).generateImage({ prompt: 'test', aspectRatio: '16:9' });

    expect(bodies[0].size).toBe('1536x1024');
    expect(bodies[1].size).toBe('1792x1024');
    expect(bodies[2].size).toBe('1024x1792');
    expect(bodies[3].size).toBe('1024x1024');
    expect(bodies[4].size).toBe('1024x1024');
  });
});
