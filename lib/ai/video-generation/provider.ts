import type { GenerationErrorCode, GenerationStatus } from '@/lib/types/generation';
import type { AspectRatio } from '@/lib/types/render';

// Reference roles are explicit and mutually exclusive:
//  - `reference`: a general/style reference image (default; used by providers
//    that accept reference conditioning).
//  - `start_frame`: the image that seeds the first frame of an image-to-video clip.
//  - `end_frame`: an optional image that seeds the last frame of the clip.
export type VideoReferenceRole = 'reference' | 'start_frame' | 'end_frame';

export interface VideoReferenceInput {
  id: string;
  mimeType: string;
  data: Buffer;
  filename?: string;
  role?: VideoReferenceRole;
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
  // Optional model-aware capabilities. Providers whose models expose different
  // modes (for example a FAL text-to-video vs. image-to-video endpoint) implement
  // this so the central resolver can reject an incompatible model/mode pair
  // before building an external request.
  getCapabilitiesForModel?(model?: string): VideoGenerationCapabilities;
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
