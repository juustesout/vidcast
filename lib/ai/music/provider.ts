export interface MusicGenerationRequest {
  prompt: string;
  durationMs: number;
  model?: string;
  instrumental?: boolean;
  seed?: number;
  outputFormat?: string;
}

export interface MusicGenerationResult {
  provider: string;
  model?: string;
  mimeType: string;
  format: string;
  data: Buffer;
  duration?: number;
  providerRequestId?: string;
  metadata?: Record<string, unknown>;
}

export interface MusicProvider {
  readonly providerId: string;
  generate(request: MusicGenerationRequest, options?: { signal?: AbortSignal }): Promise<MusicGenerationResult>;
}

export type MusicProviderErrorCode =
  | 'NOT_CONFIGURED'
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_FAILED';

export class MusicProviderError extends Error {
  readonly status: number;
  readonly code: MusicProviderErrorCode;

  constructor(message: string, status: number, code: MusicProviderErrorCode) {
    super(message);
    this.name = 'MusicProviderError';
    this.status = status;
    this.code = code;
  }
}
