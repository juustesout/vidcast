import type { AspectRatio } from '@/lib/types/render';

export interface ReferenceInput {
  id: string;
  mimeType: string;
  data: Buffer;
  filename?: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  model?: string;
  aspectRatio?: AspectRatio;
  width?: number;
  height?: number;
  referenceImages?: ReferenceInput[];
  metadata?: Record<string, unknown>;
}

export interface ImageGenerationResult {
  provider: string;
  model: string;
  mimeType: string;
  data: Buffer;
  width?: number;
  height?: number;
  providerRequestId?: string;
  metadata?: Record<string, unknown>;
}

export interface ImageGenerationProvider {
  readonly providerId: string;
  generateImage(request: ImageGenerationRequest, options?: { signal?: AbortSignal }): Promise<ImageGenerationResult>;
}

export class ImageGenerationProviderError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ImageGenerationProviderError';
    this.status = status;
    this.code = code;
  }
}
