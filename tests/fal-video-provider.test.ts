import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decodeFalJobId,
  encodeFalJobId,
  FalVideoGenerationProvider
} from '@/lib/ai/video-generation/fal-provider';

const BASE_URL = 'https://queue.test';
const ENDPOINT = 'minimax/h3-max-turbo/text-to-video';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function jsonResponse(payload: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const status = init.status ?? 200;
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
  });
}

function bytesResponse(data: Buffer, contentType = 'video/mp4'): Response {
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: { 'content-type': contentType }
  });
}

// Records every request and dispatches to a caller-provided responder keyed by
// URL substrings, so each test can assert exactly what the adapter sent.
function recordingFetch(handler: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(rawHeaders)) {
      headers[key.toLowerCase()] = value;
    }
    const call: RecordedCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function provider(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, overrides: Record<string, unknown> = {}) {
  return new FalVideoGenerationProvider({
    apiKey: 'test-key',
    baseUrl: BASE_URL,
    endpoint: ENDPOINT,
    fetchImpl,
    ...overrides
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('FalVideoGenerationProvider', () => {
  it('advertises text-to-video capabilities without reference support', () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}));
    const capabilities = provider(fetchImpl).getCapabilities();

    expect(capabilities.supportsTextToVideo).toBe(true);
    expect(capabilities.supportsImageToVideo).toBe(false);
    expect(capabilities.supportsReferences).toBe(false);
    expect(capabilities.supportsCancellation).toBe(true);
    expect(capabilities.supportedAspectRatios).toEqual(['16:9', '1:1', '9:16']);
  });

  it('refuses to build a request without a configured key', async () => {
    vi.stubEnv('FAL_KEY', '');
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({}));
    const fal = new FalVideoGenerationProvider({ baseUrl: BASE_URL, fetchImpl });

    await expect(fal.submit({ prompt: 'a scene' })).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      status: 409
    });
    expect(calls).toHaveLength(0);
  });

  it('submits the official queue request and returns a composite job id', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ request_id: 'req-123', status: 'IN_QUEUE', queue_position: 0 })
    );
    const fal = provider(fetchImpl);

    const submission = await fal.submit({
      prompt: '  A calm ocean at dawn  ',
      aspectRatio: '9:16',
      durationSeconds: 6
    });

    expect(submission.providerJobId).toBe(encodeFalJobId(ENDPOINT, 'req-123'));
    expect(submission.status).toBe('queued');
    expect(submission.providerStatus).toBe('IN_QUEUE');

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${BASE_URL}/${ENDPOINT}`);
    expect(call.headers.authorization).toBe('Key test-key');
    expect(call.headers['content-type']).toBe('application/json');

    const body = JSON.parse(call.body ?? '{}');
    expect(body).toEqual({
      prompt: 'A calm ocean at dawn',
      prompt_expansion_mode: 'disabled',
      aspect_ratio: '9:16',
      duration: 6
    });
  });

  it('rejects reference images explicitly for text-to-video', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ request_id: 'x' }));
    const fal = provider(fetchImpl);

    await expect(
      fal.submit({
        prompt: 'a scene',
        references: [{ id: 'ref-1', mimeType: 'image/png', data: Buffer.from('x'), role: 'reference' }]
      })
    ).rejects.toMatchObject({ code: 'REFERENCE_ERROR' });
    expect(calls).toHaveLength(0);
  });

  it('rejects unsupported aspect ratio and duration before the request', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ request_id: 'x' }));
    const fal = provider(fetchImpl);

    await expect(fal.submit({ prompt: 'x', aspectRatio: '4:3' as never })).rejects.toMatchObject({
      code: 'UNSUPPORTED'
    });
    await expect(fal.submit({ prompt: 'x', durationSeconds: 40 })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(fal.submit({ prompt: '   ' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('maps submit HTTP failures to typed provider errors', async () => {
    const cases: Array<[number, string]> = [
      [401, 'PROVIDER_AUTH'],
      [403, 'PROVIDER_AUTH'],
      [429, 'PROVIDER_RATE_LIMIT'],
      [422, 'PROVIDER_REJECTED'],
      [500, 'PROVIDER_FAILED']
    ];

    for (const [status, code] of cases) {
      const { fetchImpl } = recordingFetch(() => jsonResponse({ detail: 'nope' }, { status }));
      const fal = provider(fetchImpl);
      await expect(fal.submit({ prompt: 'x' })).rejects.toMatchObject({ code });
    }
  });

  it('fails safely when the submit response has no request id', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ status: 'IN_QUEUE' }));
    const fal = provider(fetchImpl);

    await expect(fal.submit({ prompt: 'x' })).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  });

  it('does not leak the api key into error messages', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ error: 'generic failure' }, { status: 500 }));
    const fal = provider(fetchImpl);

    try {
      await fal.submit({ prompt: 'x' });
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as Error).message).not.toContain('test-key');
      expect((error as Error).message).not.toContain('Key test-key');
    }
  });

  it('maps queue statuses and always polls the endpoint embedded in the job id', async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith('/status?logs=1')) {
        return jsonResponse({ status: 'IN_PROGRESS', queue_position: 1 });
      }
      return jsonResponse({});
    });
    const fal = provider(fetchImpl);

    const jobId = encodeFalJobId('other/vendor/model', 'req-9');
    const status = await fal.getStatus(jobId);

    expect(status.status).toBe('generating');
    expect(status.providerStatus).toBe('IN_PROGRESS');
    expect(status.metadata).toEqual({ queuePosition: 1 });
    expect(calls[0].url).toBe(`${BASE_URL}/other/vendor/model/requests/req-9/status?logs=1`);
    expect(calls[0].headers.authorization).toBe('Key test-key');
  });

  it('treats a completed job carrying an error as failed', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ status: 'COMPLETED', error: 'content flagged', error_type: 'content_policy' })
    );
    const fal = provider(fetchImpl);

    const status = await fal.getStatus(encodeFalJobId(ENDPOINT, 'req-1'));
    expect(status.status).toBe('failed');
    expect(status.errorCode).toBe('PROVIDER_FAILED');
    expect(status.errorMessage).toBe('content flagged');
  });

  it('keeps polling on an unknown status instead of abandoning the job', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ status: 'WAITING_FOR_RUNNER' }));
    const fal = provider(fetchImpl);

    const status = await fal.getStatus(encodeFalJobId(ENDPOINT, 'req-1'));
    expect(status.status).toBe('generating');
    expect(status.providerStatus).toBe('WAITING_FOR_RUNNER');
  });

  it('downloads the result file without leaking the key to the media host', async () => {
    const media = Buffer.from('fake-mp4-bytes');
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url === `${BASE_URL}/${ENDPOINT}/requests/req-1`) {
        return jsonResponse({
          video: { url: 'https://v3.fal.media/files/clip.mp4', content_type: 'video/mp4', file_size: media.byteLength }
        });
      }
      if (call.url === 'https://v3.fal.media/files/clip.mp4') {
        return bytesResponse(media);
      }
      return jsonResponse({}, { status: 404 });
    });
    const fal = provider(fetchImpl);

    const download = await fal.download(encodeFalJobId(ENDPOINT, 'req-1'));

    expect(download.mimeType).toBe('video/mp4');
    expect(download.data.equals(media)).toBe(true);
    expect(download.metadata).toEqual({ providerRequestId: 'req-1', endpoint: ENDPOINT });

    expect(calls).toHaveLength(2);
    expect(calls[0].headers.authorization).toBe('Key test-key');
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  it('handles missing output, empty payload and result errors', async () => {
    const missingOutput = provider(recordingFetch(() => jsonResponse({})).fetchImpl);
    await expect(missingOutput.download(encodeFalJobId(ENDPOINT, 'req-1'))).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED'
    });

    const empty = provider(
      recordingFetch((call) =>
        call.url.startsWith(BASE_URL)
          ? jsonResponse({ video: { url: 'https://v3.fal.media/empty.mp4' } })
          : bytesResponse(Buffer.alloc(0))
      ).fetchImpl
    );
    await expect(empty.download(encodeFalJobId(ENDPOINT, 'req-1'))).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED'
    });

    const errored = provider(recordingFetch(() => jsonResponse({ error: 'generation failed' })).fetchImpl);
    await expect(errored.download(encodeFalJobId(ENDPOINT, 'req-1'))).rejects.toMatchObject({
      code: 'PROVIDER_FAILED'
    });
  });

  it('aborts a stalled request via its own deadline', async () => {
    const hangingFetch = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }
      });
    const fal = provider(hangingFetch, { timeoutMs: 10 });

    await expect(fal.submit({ prompt: 'x' })).rejects.toMatchObject({ code: 'PROVIDER_FAILED', status: 504 });
  });

  it('is stateless across polls so a resume re-checks the same job', async () => {
    let polls = 0;
    const { fetchImpl, calls } = recordingFetch(() => {
      polls += 1;
      return jsonResponse({ status: polls >= 2 ? 'COMPLETED' : 'IN_QUEUE' });
    });
    const fal = provider(fetchImpl);
    const jobId = encodeFalJobId(ENDPOINT, 'req-1');

    expect((await fal.getStatus(jobId)).status).toBe('queued');
    expect((await fal.getStatus(jobId)).status).toBe('generated');
    expect(calls.every((call) => call.url.includes(`/${ENDPOINT}/requests/req-1/status`))).toBe(true);
  });

  it('cancels through the official endpoint', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ success: true }));
    const fal = provider(fetchImpl);

    await fal.cancel(encodeFalJobId(ENDPOINT, 'req-1'));
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe(`${BASE_URL}/${ENDPOINT}/requests/req-1/cancel`);
  });

  it('validates composite job ids', () => {
    expect(decodeFalJobId(encodeFalJobId(ENDPOINT, 'req-1'))).toEqual({ endpoint: ENDPOINT, requestId: 'req-1' });
    expect(decodeFalJobId('req-raw', ENDPOINT)).toEqual({ endpoint: ENDPOINT, requestId: 'req-raw' });
    expect(() => decodeFalJobId('')).toThrow(/required/i);
    expect(() => decodeFalJobId('fal:bad endpoint:req-1')).toThrow(/malformed/i);
  });
});
