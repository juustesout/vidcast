import type { GenerationErrorCode, GenerationStatus } from '@/lib/types/generation';
import type { AspectRatio } from '@/lib/types/render';

export interface VideoReferenceInput {
  id: string;
  mimeType: string;
  data: Buffer;
  filename?: string;
  role?: 'reference' | 'start_frame';
}

export interface VideoGenerationRequest {
  model?: string;
  prompt: string;
  references?: VideoReferenceInput[];
  aspectRatio?: AspectRatio;
  width?: number;
  height?: number;
  durationSeconds?: number;
  metadata?: Record<string, string>;
}

export interface VideoGenerationCapabilities {
  supportsTextToVideo: boolean;
  supportsImageToVideo: boolean;
  supportsReferences: boolean;
  maxReferences?: number;
  supportedAspectRatios?: AspectRatio[];
  supportedDurationsSeconds?: number[];
  supportsCancellation: boolean;
}

export interface VideoGenerationSubmission {
  providerJobId: string;
  status: Extract<GenerationStatus, 'queued' | 'generating'>;
  providerStatus?: string;
  metadata?: Record<string, unknown>;
}

export interface VideoGenerationStatusResult {
  status: GenerationStatus;
  providerStatus?: string;
  errorCode?: GenerationErrorCode;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface VideoGenerationDownload {
  mimeType: string;
  data: Buffer;
  metadata?: Record<string, unknown>;
}

export interface VideoGenerationProvider {
  readonly providerId: string;
  getCapabilities(): VideoGenerationCapabilities;
  submit(request: VideoGenerationRequest): Promise<VideoGenerationSubmission>;
  getStatus(providerJobId: string): Promise<VideoGenerationStatusResult>;
  download(providerJobId: string): Promise<VideoGenerationDownload>;
  cancel?(providerJobId: string): Promise<void>;
}

export class VideoGenerationProviderError extends Error {
  readonly status: number;
  readonly code: GenerationErrorCode;

  constructor(message: string, status: number, code: GenerationErrorCode) {
    super(message);
    this.name = 'VideoGenerationProviderError';
    this.status = status;
    this.code = code;
  }
}
