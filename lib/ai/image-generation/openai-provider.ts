import { imageSize } from 'image-size';

import { ImageGenerationProviderError, type ImageGenerationProvider, type ImageGenerationRequest, type ImageGenerationResult } from './provider';

interface OpenAiProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
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

export class OpenAiImageGenerationProvider implements ImageGenerationProvider {
  readonly providerId = 'openai';

  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: OpenAiProviderOptions = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    this.model = options.model || process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';
  }

  async generateImage(request: ImageGenerationRequest, options?: { signal?: AbortSignal }): Promise<ImageGenerationResult> {
    if (!this.apiKey) {
      throw new ImageGenerationProviderError('OpenAI image generation is not configured. Set OPENAI_API_KEY on the server.', 409, 'provider.notConfigured');
    }

    const size = request.width && request.height ? `${request.width}x${request.height}` : mapAspectRatioToSize(request.aspectRatio);
    const prompt = request.negativePrompt ? `${request.prompt}\n\nNegative prompt: ${request.negativePrompt}` : request.prompt;

    let response: Response;

    if (request.referenceImages && request.referenceImages.length > 0) {
      const form = new FormData();
      form.set('model', request.model || this.model);
      form.set('prompt', prompt);
      if (size) {
        form.set('size', size);
      }
      form.set('response_format', 'b64_json');
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
        signal: options?.signal
      });
    } else {
      response = await fetch(`${this.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: request.model || this.model,
          prompt,
          size,
          response_format: 'b64_json'
        }),
        signal: options?.signal
      });
    }

    const requestId = response.headers.get('x-request-id') || undefined;
    const json = (await response.json().catch(() => ({}))) as unknown;

    if (!response.ok) {
      throw new ImageGenerationProviderError(parseErrorMessage(json), response.status >= 400 && response.status < 500 ? 422 : 502, 'provider.request.failed');
    }

    const data = decodeBase64Image(json);
    let width: number | undefined;
    let height: number | undefined;
    try {
      const dimensions = imageSize(data);
      width = dimensions.width;
      height = dimensions.height;
    } catch {
      width = undefined;
      height = undefined;
    }

    return {
      provider: this.providerId,
      model: request.model || this.model,
      mimeType: 'image/png',
      data,
      width,
      height,
      providerRequestId: requestId,
      metadata: {
        size
      }
    };
  }
}
