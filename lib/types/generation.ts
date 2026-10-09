import type { AspectRatio } from './render';

export type GenerationProvider = 'openai' | 'gemini' | 'local' | 'other';

export type GenerationKind = 'image' | 'video';

export type GenerationStatus = 'planned' | 'queued' | 'generating' | 'generated' | 'failed' | 'rejected';

export type GenerationErrorCode =
  | 'NOT_CONFIGURED'
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED'
  | 'REFERENCE_ERROR'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'MEDIA_INVALID'
  | 'INTERNAL';

export interface GenerationSpec {
  provider?: GenerationProvider;
  model?: string;
  prompt: string;
  negativePrompt?: string;
  referenceIds?: string[];
  aspectRatio?: AspectRatio;
  duration?: number;
  metadata?: Record<string, unknown>;
}

export interface GenerationRecord extends GenerationSpec {
  id: string;
  kind: GenerationKind;
  status: GenerationStatus;
  assetId?: string;
  providerRequestId?: string;
  providerJobId?: string;
  providerStatus?: string;
  submittedAt?: string;
  lastPolledAt?: string;
  errorCode?: GenerationErrorCode;
  errorMessage?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export type GenerationAttempt = GenerationRecord;

export interface GenerationResult {
  generationId: string;
  status: GenerationStatus;
  assetId?: string;
  message?: string;
}

export interface ImageGenerationProvider {
  generate(request: GenerationSpec): Promise<GenerationResult>;
}

export interface VideoGenerationProvider {
  generate(request: GenerationSpec): Promise<GenerationResult>;
}
