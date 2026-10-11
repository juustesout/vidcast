import { imageSize } from 'image-size';

import { ImageGenerationProviderError, type ImageGenerationProvider, type ImageGenerationRequest, type ImageGenerationResult } from './provider';

const DEFAULT_TIMEOUT_MS = 120_000;

// The 8-byte magic number starting every PNG file. Used to reject non-PNG or
// truncated provider output before it can be persisted as a scene asset.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface OpenAiProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

function mapAspectRatioToSize(aspectRatio?: string): string | undefined {
  if (!aspectRatio) {
    return undefined;
  }

  if (aspectRatio === '16:9') {
    return '1536x1024';
  }
  if (aspectRatio === '9:16') {
    return '1024x1536';
  }
  if (aspectRatio === '1:1') {
    return '1024x1024';
  }

  throw new ImageGenerationProviderError(`Unsupported aspect ratio: ${aspectRatio}`, 422, 'provider.aspectRatio.unsupported');
}

function decodeBase64Image(payload: unknown): Buffer {
  if (!payload || typeof payload !== 'object') {
    throw new ImageGenerationProviderError('Provider response was missing image data.', 502, 'provider.response.invalid');
  }

  const data = (payload as { data?: Array<{ b64_json?: string }> }).data;
  const encoded = data?.[0]?.b64_json;
  if (!encoded) {
    throw new ImageGenerationProviderError('Provider response did not include b64 image content.', 502, 'provider.response.missingImage');
  }

  return Buffer.from(encoded, 'base64');
}

function parseErrorMessage(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const maybe = payload as { error?: { message?: string } };
    if (maybe.error?.message) {
      return maybe.error.message;
    }
  }
  return 'Image generation provider call failed.';
}

// `gpt-image-*` models always return base64 and reject the legacy
// `response_format` parameter, while dall-e models default to a URL response and
// still need it to be asked for base64.
function supportsResponseFormat(model: string): boolean {
  return !model.startsWith('gpt-image');
}

// Rejects empty, truncated or non-PNG provider bytes. This runs before the
// asset is written so an invalid paid response can never be persisted as a
// successfully generated scene image.
function validatePngBytes(data: Buffer): { width: number; height: number } {
  if (data.byteLength < PNG_SIGNATURE.byteLength || !data.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new ImageGenerationProviderError('Provider response was not a valid PNG image.', 502, 'provider.response.invalidImage');
  }

  let dimensions: ReturnType<typeof imageSize>;
  try {
    dimensions = imageSize(data);
  } catch {
    throw new ImageGenerationProviderError('Provider response was not a decodable PNG image.', 502, 'provider.response.invalidImage');
  }

  const width = dimensions.width;
  const height = dimensions.height;
  if (!width || !height || width <= 0 || height <= 0) {
    throw new ImageGenerationProviderError('Provider response PNG had no usable dimensions.', 502, 'provider.response.invalidImage');
  }

  return { width, height };
}

// Classifies non-2xx HTTP responses without ever echoing credentials. Auth and
// rate-limit failures are surfaced distinctly so callers can react (and so a
// retry is never issued automatically by this adapter).
function classifyHttpError(status: number, message: string): ImageGenerationProviderError {
  if (status === 401 || status === 403) {
    return new ImageGenerationProviderError(message, 502, 'provider.request.unauthorized');
  }
  if (status === 429) {
    return new ImageGenerationProviderError(message, 429, 'provider.request.rateLimited');
  }
  if (status >= 400 && status < 500) {
    return new ImageGenerationProviderError(message, 422, 'provider.request.rejected');
  }
  return new ImageGenerationProviderError(message, 502, 'provider.request.failed');
}

function mapTransportError(error: unknown): ImageGenerationProviderError {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new ImageGenerationProviderError('OpenAI image generation timed out or was aborted.', 504, 'provider.request.timeout');
  }
  return new ImageGenerationProviderError('Could not reach the OpenAI image generation service.', 502, 'provider.request.unreachable');
}

// Binds the caller supplied abort signal together with a hard request deadline
// so a stalled paid call cannot hang a request indefinitely.
function createRequestSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(callerSignal?.reason);

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const timer = setTimeout(() => controller.abort(new Error('Image generation request timed out.')), timeoutMs);
  if (typeof timer === 'object' && typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (callerSignal) {
        callerSignal.removeEventListener('abort', onAbort);
      }
    }
  };
}

export class OpenAiImageGenerationProvider implements ImageGenerationProvider {
  readonly providerId = 'openai';

  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAiProviderOptions = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    this.model = options.model || process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';
    const envTimeout = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS);
    this.timeoutMs = options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  }

  async generateImage(request: ImageGenerationRequest, options?: { signal?: AbortSignal }): Promise<ImageGenerationResult> {
    if (!this.apiKey) {
      throw new ImageGenerationProviderError('OpenAI image generation is not configured. Set OPENAI_API_KEY on the server.', 409, 'provider.notConfigured');
    }

    const size = request.width && request.height ? `${request.width}x${request.height}` : mapAspectRatioToSize(request.aspectRatio);
    const prompt = request.negativePrompt ? `${request.prompt}\n\nNegative prompt: ${request.negativePrompt}` : request.prompt;
    const model = request.model || this.model;

    const { signal, cleanup } = createRequestSignal(options?.signal, this.timeoutMs);

    try {
      let response: Response;

      try {
        if (request.referenceImages && request.referenceImages.length > 0) {
          const form = new FormData();
          form.set('model', model);
          form.set('prompt', prompt);
          if (size) {
            form.set('size', size);
          }
          if (supportsResponseFormat(model)) {
            form.set('response_format', 'b64_json');
          }
          for (const reference of request.referenceImages) {
            const arrayBuffer = reference.data.buffer.slice(reference.data.byteOffset, reference.data.byteOffset + reference.data.byteLength) as ArrayBuffer;
            form.append('image[]', new Blob([arrayBuffer], { type: reference.mimeType }), reference.filename || `${reference.id}.png`);
          }

          response = await fetch(`${this.baseUrl}/images/edits`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiKey}`
            },
            body: form,
            signal
          });
        } else {
          const body: Record<string, unknown> = {
            model,
            prompt,
            size
          };
          if (supportsResponseFormat(model)) {
            body.response_format = 'b64_json';
          }

          response = await fetch(`${this.baseUrl}/images/generations`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(body),
            signal
          });
        }
      } catch (error) {
        throw mapTransportError(error);
      }

      const requestId = response.headers.get('x-request-id') || undefined;

      let json: unknown = {};
      try {
        json = await response.json();
      } catch (error) {
        if (response.ok) {
          throw mapTransportError(error);
        }
      }

      if (!response.ok) {
        throw classifyHttpError(response.status, parseErrorMessage(json));
      }

      const data = decodeBase64Image(json);
      const { width, height } = validatePngBytes(data);

      return {
        provider: this.providerId,
        model,
        mimeType: 'image/png',
        data,
        width,
        height,
        providerRequestId: requestId,
        metadata: {
          size
        }
      };
    } finally {
      cleanup();
    }
  }
}
