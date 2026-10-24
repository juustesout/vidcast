import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAiVideoGenerationProvider } from '@/lib/ai/video-generation/openai-provider';
import { VideoGenerationProviderError } from '@/lib/ai/video-generation/provider';

afterEach(() => {
  vi.unstubAllGlobals();
});

function statusResponse(outputUrl: string): Response {
  return new Response(JSON.stringify({ status: 'completed', output: { url: outputUrl } }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

describe('OpenAI video download', () => {
  it('downloads from api.openai.com with the API key and redirect error', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const href = String(url);
      if (href.includes('/videos/generations/job_1') && !href.includes('/content')) {
        return statusResponse('https://api.openai.com/v1/videos/generations/job_1/content');
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp4' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAiVideoGenerationProvider({ apiKey: 'test-openai-key' });
    const result = await provider.download('job_1');

    expect(result.data.byteLength).toBe(3);
    const downloadCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/content'));
    expect(downloadCall?.[0]).toBe('https://api.openai.com/v1/videos/generations/job_1/content');
    expect(downloadCall?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer test-openai-key' }
    });
  });

  it('does not send the API key to a trusted media host', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const href = String(url);
      if (href.includes('files.oaiusercontent.com')) {
        return new Response(new Uint8Array([9]), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      return statusResponse('https://files.oaiusercontent.com/video.mp4');
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAiVideoGenerationProvider({ apiKey: 'test-openai-key' });
    await provider.download('job_1');

    const downloadCall = fetchMock.mock.calls.find(([url]) => String(url).includes('files.oaiusercontent.com'));
    expect(downloadCall?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect((downloadCall?.[1] as RequestInit | undefined)?.headers).toEqual({});
  });

  it.each([
    'http://127.0.0.1/steal',
    'https://localhost/steal',
    'https://evil.example/video.mp4',
    'https://10.0.0.4/video.mp4'
  ])('does not fetch or send the API key to untrusted URL %s', async (outputUrl) => {
    const fetchMock = vi.fn<typeof fetch>(async () => statusResponse(outputUrl));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAiVideoGenerationProvider({ apiKey: 'test-openai-key' });
    await expect(provider.download('job_1')).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/videos/generations/job_1');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(outputUrl);
    expect(JSON.stringify(fetchMock.mock.calls.slice(1))).not.toContain('test-openai-key');
  });

  it('fails closed when getStatus returns no output URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'completed' }), { status: 200 }))
    );

    const provider = new OpenAiVideoGenerationProvider({ apiKey: 'test-openai-key' });
    await expect(provider.download('job_1')).rejects.toBeInstanceOf(VideoGenerationProviderError);
  });
});
