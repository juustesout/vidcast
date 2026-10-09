export type TextToSpeechFormat = 'mp3' | 'wav' | 'm4a';

export interface TextToSpeechRequest {
  text: string;
  voiceId: string;
  model?: string;
  format: TextToSpeechFormat;
  settings?: {
    stability?: number;
    similarityBoost?: number;
    style?: number;
    speakerBoost?: boolean;
  };
}

export interface TextToSpeechResult {
  provider: string;
  model?: string;
  mimeType: string;
  format: TextToSpeechFormat;
  data: Buffer;
  duration?: number;
  providerRequestId?: string;
  metadata?: Record<string, unknown>;
}

export interface TextToSpeechProvider {
  readonly providerId: string;
  synthesize(request: TextToSpeechRequest, options?: { signal?: AbortSignal }): Promise<TextToSpeechResult>;
}

export class TextToSpeechProviderError extends Error {
  readonly status: number;
  readonly code: 'NOT_CONFIGURED' | 'INVALID_REQUEST' | 'UNSUPPORTED' | 'PROVIDER_AUTH' | 'PROVIDER_RATE_LIMIT' | 'PROVIDER_REJECTED' | 'PROVIDER_FAILED';

  constructor(message: string, status: number, code: 'NOT_CONFIGURED' | 'INVALID_REQUEST' | 'UNSUPPORTED' | 'PROVIDER_AUTH' | 'PROVIDER_RATE_LIMIT' | 'PROVIDER_REJECTED' | 'PROVIDER_FAILED') {
    super(message);
    this.name = 'TextToSpeechProviderError';
    this.status = status;
    this.code = code;
  }
}
