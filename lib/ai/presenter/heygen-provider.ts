import { logProviderError, publicMessageForProviderCode } from '@/lib/security/safe-error';

import {
  PresenterProviderError,
  type PresenterDownloadResult,
  type PresenterJobStatus,
  type PresenterProvider,
  type PresenterSubmitRequest,
  type PresenterSubmitResult
} from './provider';

const DEFAULT_BASE_URL = 'https://api.heygen.com';
const REQUEST_TIMEOUT_MS = 120_000;

export type HeyGenPresenterEngine = 'avatar_iii' | 'avatar_iv' | 'avatar_v';
const HEYGEN_PRESENTER_ENGINES: readonly HeyGenPresenterEngine[] = ['avatar_iii', 'avatar_iv', 'avatar_v'];

// Engine selection is operational configuration, not project content. The
// default matches the proven P40.2 Avatar III photo-avatar route.
export function resolveHeyGenPresenterEngine(env: Record<string, string | undefined> = process.env): HeyGenPresenterEngine {
  const raw = env.HEYGEN_PRESENTER_ENGINE?.trim().toLowerCase();
  if (!raw) {
    return 'avatar_iii';
  }
  if ((HEYGEN_PRESENTER_ENGINES as readonly string[]).includes(raw)) {
    return raw as HeyGenPresenterEngine;
  }
  throw new PresenterProviderError(
    `Unsupported HEYGEN_PRESENTER_ENGINE: ${raw}. Use avatar_iii, avatar_iv, or avatar_v.`,
    'NOT_CONFIGURED'
  );
}

export function resolveHeyGenResolution(height: number): '720p' | '1080p' {
  return Number.isFinite(height) && height >= 1080 ? '1080p' : '720p';
}

export function buildHeyGenVideoPayload(
  request: PresenterSubmitRequest,
  audioAssetId: string,
  engine: HeyGenPresenterEngine
) {
  return {
    type: 'avatar' as const,
    avatar_id: request.avatarId,
    audio_asset_id: audioAssetId,
    title: request.title,
    output_format: request.outputFormat,
    aspect_ratio: request.aspectRatio,
    resolution: resolveHeyGenResolution(request.height),
    engine: { type: engine }
  };
}

function resolveBaseUrl(): string {
  return (process.env.HEYGEN_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function resolveApiKey(): string {
  const key = process.env.HEYGEN_API_KEY?.trim();
  if (!key) {
    throw new PresenterProviderError('HeyGen requires HEYGEN_API_KEY.', 'NOT_CONFIGURED');
  }
  return key;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function unwrapData(body: unknown): Record<string, unknown> | undefined {
  const record = asRecord(body);
  return asRecord(record?.data) ?? record;
}

function resolveAudioExtension(mimeType: string): string {
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('m4a') || mimeType.includes('mp4')) return 'm4a';
  return 'mp3';
}

function mapStatus(raw: string | undefined): PresenterJobStatus['status'] {
  switch ((raw ?? '').toLowerCase()) {
    case 'completed':
    case 'success':
    case 'succeeded':
      return 'generated';
    case 'failed':
    case 'error':
      return 'failed';
    case 'queued':
    case 'pending':
    case 'waiting':
      return 'queued';
    default:
      return 'generating';
  }
}

async function throwHttpError(response: Response): Promise<never> {
  const text = await response.text().catch(() => '');
  logProviderError('heygen', { code: 'PROVIDER_ERROR', status: response.status, body: text || `${response.status} ${response.statusText}` });
  throw new PresenterProviderError(publicMessageForProviderCode('PROVIDER_ERROR'), 'PROVIDER_ERROR', response.status);
}

export class HeyGenPresenterProvider implements PresenterProvider {
  readonly providerId = 'heygen';
  readonly displayName = 'HeyGen';
  readonly capabilities = {
    supportsAudioInput: true,
    supportsTransparency: true,
    supportsWebm: true
  };

  private async fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(url, {
      ...init,
      headers: {
        'x-api-key': resolveApiKey(),
        accept: 'application/json',
        ...(init.headers ?? {})
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }).catch((error) => {
      logProviderError('heygen', { code: 'PROVIDER_ERROR', error });
      throw new PresenterProviderError(publicMessageForProviderCode('PROVIDER_ERROR'), 'PROVIDER_ERROR');
    });

    if (!response.ok) {
      await throwHttpError(response);
    }

    return response.json().catch(() => ({}));
  }

  private async uploadAudio(request: PresenterSubmitRequest): Promise<string> {
    const form = new FormData();
    const extension = resolveAudioExtension(request.audio.mimeType);
    const blob = new Blob([request.audio.data as unknown as BlobPart], { type: request.audio.mimeType || 'audio/mpeg' });
    form.append('file', blob, request.audio.filename || `narration.${extension}`);

    const body = await this.fetchJson(`${resolveBaseUrl()}/v3/assets`, {
      method: 'POST',
      body: form
    });
    const data = unwrapData(body);
    const assetId = readString(data, 'id') ?? readString(data, 'asset_id') ?? readString(data, 'assetId');
    if (!assetId) {
      throw new PresenterProviderError('HeyGen did not return an uploaded audio asset id.', 'PROVIDER_ERROR');
    }
    return assetId;
  }

  async submit(request: PresenterSubmitRequest): Promise<PresenterSubmitResult> {
    if (!request.avatarId.trim()) {
      throw new PresenterProviderError('HeyGen requires an avatar id.', 'INVALID_REQUEST');
    }
    if (request.audio.data.length === 0) {
      throw new PresenterProviderError('HeyGen requires narration audio.', 'INVALID_REQUEST');
    }

    const audioAssetId = await this.uploadAudio(request);

    const body = await this.fetchJson(`${resolveBaseUrl()}/v3/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildHeyGenVideoPayload(request, audioAssetId, resolveHeyGenPresenterEngine()))
    });

    const data = unwrapData(body);
    const providerJobId = readString(data, 'video_id') ?? readString(data, 'id') ?? readString(data, 'job_id');
    if (!providerJobId) {
      throw new PresenterProviderError('HeyGen did not return a video id.', 'PROVIDER_ERROR');
    }

    return {
      providerJobId,
      providerStatus: readString(data, 'status')
    };
  }

  async getStatus(providerJobId: string): Promise<PresenterJobStatus> {
    const body = await this.fetchJson(`${resolveBaseUrl()}/v3/videos/${encodeURIComponent(providerJobId)}`);
    const data = unwrapData(body);
    const providerStatus = readString(data, 'status') ?? 'unknown';
    const status = mapStatus(providerStatus);

    if (status === 'failed') {
      const failureCode = readString(data, 'failure_code');
      logProviderError('heygen', {
        code: 'PROVIDER_ERROR',
        body: {
          failure_code: failureCode,
          failure_message: readString(data, 'failure_message') ??
            readString(data, 'failure') ??
            readString(data, 'error') ??
            readString(asRecord(data?.error), 'message')
        }
      });
      return {
        status,
        providerStatus,
        error: publicMessageForProviderCode('PROVIDER_ERROR')
      };
    }

    const duration = data?.duration;
    const width = data?.width;
    const height = data?.height;

    return {
      status,
      providerStatus,
      videoUrl: readString(data, 'video_url'),
      thumbnailUrl: readString(data, 'thumbnail_url'),
      durationSeconds: typeof duration === 'number' && Number.isFinite(duration) ? duration : undefined,
      width: typeof width === 'number' ? width : undefined,
      height: typeof height === 'number' ? height : undefined
    };
  }

  async getBillingBalanceUsd(): Promise<number | undefined> {
    const body = await this.fetchJson(`${resolveBaseUrl()}/v3/users/me`);
    const data = unwrapData(body);
    const wallet = asRecord(data?.wallet);
    const remaining = wallet?.remaining_balance ?? wallet?.remainingBalance;
    return typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : undefined;
  }

  async download(status: PresenterJobStatus): Promise<PresenterDownloadResult> {
    if (!status.videoUrl) {
      throw new PresenterProviderError('HeyGen status does not contain a downloadable video.', 'PROVIDER_ERROR');
    }

    const response = await fetch(status.videoUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }).catch((error) => {
      logProviderError('heygen', { code: 'PROVIDER_ERROR', error });
      throw new PresenterProviderError(publicMessageForProviderCode('PROVIDER_ERROR'), 'PROVIDER_ERROR');
    });

    if (!response.ok) {
      logProviderError('heygen', { code: 'PROVIDER_ERROR', status: response.status, body: `${response.status} ${response.statusText}` });
      throw new PresenterProviderError(publicMessageForProviderCode('PROVIDER_ERROR'), 'PROVIDER_ERROR', response.status);
    }

    return {
      data: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type')?.split(';')[0] || 'video/mp4',
      durationSeconds: status.durationSeconds
    };
  }
}
