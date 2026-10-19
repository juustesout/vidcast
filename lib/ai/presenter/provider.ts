import type { AspectRatio } from '@/lib/types/render';
import type { PresenterOutputFormat } from '@/lib/types/presenter';

export type PresenterProviderErrorCode =
  | 'NOT_CONFIGURED'
  | 'UNSUPPORTED'
  | 'INVALID_REQUEST'
  | 'PROVIDER_ERROR';

export class PresenterProviderError extends Error {
  readonly code: PresenterProviderErrorCode;
  readonly status?: number;

  constructor(message: string, code: PresenterProviderErrorCode, status?: number) {
    super(message);
    this.name = 'PresenterProviderError';
    this.code = code;
    this.status = status;
  }
}

export interface PresenterAudioInput {
  data: Buffer;
  mimeType: string;
  duration: number;
  filename: string;
}

export interface PresenterSubmitRequest {
  avatarId: string;
  audio: PresenterAudioInput;
  outputFormat: PresenterOutputFormat;
  aspectRatio: AspectRatio;
  width: number;
  height: number;
  title?: string;
}

export interface PresenterSubmitResult {
  providerJobId: string;
  providerStatus?: string;
}

export type PresenterJobState = 'queued' | 'generating' | 'generated' | 'failed';

export interface PresenterJobStatus {
  status: PresenterJobState;
  providerStatus: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  error?: string;
}

export interface PresenterDownloadResult {
  data: Buffer;
  mimeType: string;
  durationSeconds?: number;
}

export interface PresenterProviderCapabilities {
  // The provider accepts an existing narration audio track instead of a script.
  supportsAudioInput: boolean;
  // Transparent (alpha) output is available for PiP-style composition.
  supportsTransparency: boolean;
  supportsWebm: boolean;
}

export interface PresenterProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly capabilities: PresenterProviderCapabilities;
  submit(request: PresenterSubmitRequest): Promise<PresenterSubmitResult>;
  getStatus(providerJobId: string): Promise<PresenterJobStatus>;
  download(status: PresenterJobStatus): Promise<PresenterDownloadResult>;
  // Optional because not every provider exposes a billing balance. Used only
  // to record the measured delta around a paid request.
  getBillingBalanceUsd?(): Promise<number | undefined>;
}
