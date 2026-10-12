import type { AspectRatio } from '@/lib/types/render';

import {
  VideoGenerationProviderError,
  type VideoGenerationCapabilities,
  type VideoGenerationDownload,
  type VideoGenerationProvider,
  type VideoGenerationRequest,
  type VideoGenerationStatusResult,
  type VideoGenerationSubmission
} from './provider';

// Official FAL.ai queue contract (verified against
// https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max-turbo/text-to-video
// and https://fal.ai/docs/documentation/model-apis/inference/queue):
//   - auth header `Authorization: Key $FAL_KEY`
//   - submit   POST  {base}/{endpoint}                         -> { request_id, status? , ... }
//   - status   GET   {base}/{endpoint}/requests/{id}/status?logs=1 -> { status, ... }
//   - result   GET   {base}/{endpoint}/requests/{id}           -> model output ({ video: { url } })
//   - cancel   PUT   {base}/{endpoint}/requests/{id}/cancel
// Media URLs returned by FAL are public but expire, so the result is downloaded
// immediately during the `generated` poll (see video-generation-service).
export const DEFAULT_FAL_VIDEO_ENDPOINT = 'minimax/h3-max-turbo/text-to-video';
export const DEFAULT_FAL_VIDEO_BASE_URL = 'https://queue.fal.run';
export const DEFAULT_FAL_VIDEO_PROMPT_EXPANSION_MODE = 'disabled';

const DEFAULT_TIMEOUT_MS = 120_000;
const JOB_ID_PREFIX = 'fal';

// The application only models 16:9 / 1:1 / 9:16. FAL accepts a wider set, but a
// value outside the app's model can never legitimately reach the adapter.
const SUPPORTED_ASPECT_RATIOS: AspectRatio[] = ['16:9', '1:1', '9:16'];

// FAL `duration` is a float bounded to ~0.92..15 s by the model schema. The
// service always rounds to whole seconds, so accept integers in [1, 15].
const MIN_DURATION_SECONDS = 1;
const MAX_DURATION_SECONDS = 15;

// Model/endpoint ids are `<owner>/<model>[/<variant>...]`. Anchored and
// restricted to path-safe characters so a stored value can never smuggle a
// query string, protocol, or path traversal into a request URL.
const ENDPOINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/;

const PROMPT_EXPANSION_MODES = new Set(['disabled', 'balanced', 'quality']);
const RESOLUTIONS = new Set(['480P', '768P', '1080P']);

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FalVideoProviderOptions {
  apiKey?: string;
  endpoint?: string;
  baseUrl?: string;
  timeoutMs?: number;
  promptExpansionMode?: string;
  resolution?: string;
  enableSafetyChecker?: boolean;
  // Injected for tests; never required in production (uses global fetch).
  fetchImpl?: FetchLike;
}

interface FalJobIdentity {
  endpoint: string;
  requestId: string;
}

function parseEnvTimeout(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveEndpoint(value: string | undefined): string {
  const candidate = (value || DEFAULT_FAL_VIDEO_ENDPOINT).trim();
  if (!ENDPOINT_PATTERN.test(candidate)) {
    throw new VideoGenerationProviderError(`Unsupported FAL video endpoint: ${value}.`, 400, 'INVALID_REQUEST');
  }
  return candidate;
}

function resolvePromptExpansionMode(value: string | undefined): string {
  const candidate = (value || DEFAULT_FAL_VIDEO_PROMPT_EXPANSION_MODE).trim().toLowerCase();
  if (!PROMPT_EXPANSION_MODES.has(candidate)) {
    throw new VideoGenerationProviderError(`Unsupported FAL prompt expansion mode: ${value}.`, 400, 'INVALID_REQUEST');
  }
  return candidate;
}

function resolveResolution(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const candidate = value.trim();
  if (!candidate) {
    return undefined;
  }
  if (!RESOLUTIONS.has(candidate)) {
    throw new VideoGenerationProviderError(`Unsupported FAL video resolution: ${value}.`, 400, 'INVALID_REQUEST');
  }
  return candidate;
}

function resolveAspectRatio(value: AspectRatio | undefined): AspectRatio | undefined {
  if (!value) {
    return undefined;
  }
  if (!SUPPORTED_ASPECT_RATIOS.includes(value)) {
    throw new VideoGenerationProviderError(`Unsupported aspect ratio: ${value}`, 422, 'UNSUPPORTED');
  }
  return value;
}

function resolveDuration(value: number | undefined): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded) || rounded < MIN_DURATION_SECONDS || rounded > MAX_DURATION_SECONDS) {
    throw new VideoGenerationProviderError(
      `Unsupported video duration: ${value}. FAL accepts ${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS} seconds.`,
      422,
      'UNSUPPORTED'
    );
  }
  return rounded;
}

// Composite, durable job identity. The registry constructs a fresh provider per
// call and `getStatus`/`download` receive only the provider job id, so the
// endpoint must travel with the request id or a restart could poll the wrong
// model. Format: `fal:{endpoint}:{request_id}`.
export function encodeFalJobId(endpoint: string, requestId: string): string {
  return `${JOB_ID_PREFIX}:${endpoint}:${requestId}`;
}

export function decodeFalJobId(jobId: string, fallbackEndpoint?: string): FalJobIdentity {
  const trimmed = (jobId || '').trim();
  if (!trimmed) {
    throw new VideoGenerationProviderError('A FAL video job id is required.', 400, 'INVALID_REQUEST');
  }

  if (trimmed.startsWith(`${JOB_ID_PREFIX}:`)) {
    const rest = trimmed.slice(JOB_ID_PREFIX.length + 1);
    const separator = rest.lastIndexOf(':');
    if (separator > 0 && separator < rest.length - 1) {
      const endpoint = rest.slice(0, separator);
      const requestId = rest.slice(separator + 1);
      if (ENDPOINT_PATTERN.test(endpoint) && requestId) {
        return { endpoint, requestId };
      }
    }
    throw new VideoGenerationProviderError('Malformed FAL video job id.', 400, 'INVALID_REQUEST');
  }

  // Legacy/raw request id: fall back to the configured endpoint.
  const endpoint = fallbackEndpoint ? resolveEndpoint(fallbackEndpoint) : DEFAULT_FAL_VIDEO_ENDPOINT;
  return { endpoint, requestId: trimmed };
}

function mapFalStatus(status: unknown): VideoGenerationStatusResult {
  const value = typeof status === 'string' ? status.trim().toUpperCase() : '';

  if (value === 'IN_QUEUE') {
    return { status: 'queued', providerStatus: 'IN_QUEUE' };
  }
  if (value === 'IN_PROGRESS') {
    return { status: 'generating', providerStatus: 'IN_PROGRESS' };
  }
  if (value === 'COMPLETED') {
    return { status: 'generated', providerStatus: 'COMPLETED' };
  }

  // An unknown status is treated as still-processing rather than failed: a
  // live (and possibly paid) job must never be abandoned by a transient or
  // forward-compatible status value. The poll limit bounds the wait.
  return { status: 'generating', providerStatus: value || 'UNKNOWN' };
}

function parseFalErrorMessage(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const maybe = payload as {
      error?: string | { message?: string };
      error_type?: string;
      detail?: string | Array<{ msg?: string }>;
      message?: string;
    };
    if (typeof maybe.error === 'string' && maybe.error) {
      return maybe.error;
    }
    if (maybe.error && typeof maybe.error === 'object' && typeof maybe.error.message === 'string') {
      return maybe.error.message;
    }
    if (typeof maybe.detail === 'string' && maybe.detail) {
      return maybe.detail;
    }
    if (Array.isArray(maybe.detail)) {
      const messages = maybe.detail.map((entry) => entry?.msg).filter((msg): msg is string => Boolean(msg));
      if (messages.length > 0) {
        return messages.join('; ');
      }
    }
    if (typeof maybe.message === 'string' && maybe.message) {
      return maybe.message;
    }
  }
  return 'FAL video generation request failed.';
}

function hasFalError(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const maybe = payload as { error?: unknown; error_type?: unknown };
  return typeof maybe.error === 'string' || typeof maybe.error_type === 'string';
}

function mapHttpError(status: number, payload: unknown): VideoGenerationProviderError {
  if (status === 401 || status === 403) {
    return new VideoGenerationProviderError(parseFalErrorMessage(payload), 502, 'PROVIDER_AUTH');
  }
  if (status === 429) {
    return new VideoGenerationProviderError(parseFalErrorMessage(payload), 429, 'PROVIDER_RATE_LIMIT');
  }
  if (status >= 400 && status < 500) {
    return new VideoGenerationProviderError(parseFalErrorMessage(payload), 422, 'PROVIDER_REJECTED');
  }
  return new VideoGenerationProviderError(parseFalErrorMessage(payload), 502, 'PROVIDER_FAILED');
}

function mapTransportError(error: unknown): VideoGenerationProviderError {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new VideoGenerationProviderError('FAL video generation timed out or was aborted.', 504, 'PROVIDER_FAILED');
  }
  return new VideoGenerationProviderError('Could not reach the FAL video generation service.', 502, 'PROVIDER_FAILED');
}

// Hard per-request deadline. Mirrors the ElevenLabs music adapter so a stalled
// paid call can never hang the submit/poll path indefinitely.
function createRequestSignal(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('FAL video request timed out.')), timeoutMs);
  if (typeof timer === 'object' && typeof timer.unref === 'function') {
    timer.unref();
  }
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer)
  };
}

export class FalVideoGenerationProvider implements VideoGenerationProvider {
  readonly providerId = 'fal';

  private readonly apiKey?: string;
  private readonly endpoint: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly promptExpansionMode: string;
  private readonly resolution?: string;
  private readonly enableSafetyChecker?: boolean;
  private readonly fetchImpl: FetchLike;

  constructor(options: FalVideoProviderOptions = {}) {
    this.apiKey = options.apiKey || process.env.FAL_KEY;
    this.endpoint = resolveEndpoint(options.endpoint || process.env.FAL_VIDEO_ENDPOINT);
    this.baseUrl = (options.baseUrl || process.env.FAL_VIDEO_BASE_URL || DEFAULT_FAL_VIDEO_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs =
      options.timeoutMs ?? parseEnvTimeout(process.env.FAL_VIDEO_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
    this.promptExpansionMode = resolvePromptExpansionMode(
      options.promptExpansionMode || process.env.FAL_VIDEO_PROMPT_EXPANSION_MODE
    );
    this.resolution = resolveResolution(options.resolution ?? process.env.FAL_VIDEO_RESOLUTION);
    this.enableSafetyChecker = options.enableSafetyChecker;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  getCapabilities(): VideoGenerationCapabilities {
    return {
      supportsTextToVideo: true,
      supportsImageToVideo: false,
      supportsReferences: false,
      supportedAspectRatios: SUPPORTED_ASPECT_RATIOS,
      supportsCancellation: true
    };
  }

  async submit(request: VideoGenerationRequest): Promise<VideoGenerationSubmission> {
    this.assertConfigured();

    const prompt = request.prompt?.trim() ?? '';
    if (!prompt) {
      throw new VideoGenerationProviderError('Prompt is required.', 400, 'INVALID_REQUEST');
    }

    // Phase 1 is text-to-video only. An unsupported input combination is
    // rejected explicitly rather than silently dropped.
    if (request.references && request.references.length > 0) {
      throw new VideoGenerationProviderError(
        'FAL text-to-video does not support reference images.',
        422,
        'REFERENCE_ERROR'
      );
    }

    const endpoint = resolveEndpoint(request.model?.trim() || this.endpoint);
    const aspectRatio = resolveAspectRatio(request.aspectRatio);
    const duration = resolveDuration(request.durationSeconds);

    const payload: Record<string, unknown> = {
      prompt,
      prompt_expansion_mode: this.promptExpansionMode
    };
    if (aspectRatio) {
      payload.aspect_ratio = aspectRatio;
    }
    if (duration !== undefined) {
      payload.duration = duration;
    }
    if (this.resolution) {
      payload.resolution = this.resolution;
    }
    if (typeof this.enableSafetyChecker === 'boolean') {
      payload.enable_safety_checker = this.enableSafetyChecker;
    }

    const { signal, cleanup } = createRequestSignal(this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/${endpoint}`, {
          method: 'POST',
          headers: {
            Authorization: `Key ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal
        });
      } catch (error) {
        throw mapTransportError(error);
      }

      const body = (await response.json().catch(() => ({}))) as {
        request_id?: unknown;
        status?: unknown;
      };

      if (!response.ok) {
        throw mapHttpError(response.status, body);
      }

      const requestId = typeof body.request_id === 'string' ? body.request_id.trim() : '';
      if (!requestId) {
        throw new VideoGenerationProviderError('FAL did not return a request id.', 502, 'PROVIDER_FAILED');
      }

      const mapped = mapFalStatus(body.status);
      return {
        providerJobId: encodeFalJobId(endpoint, requestId),
        status: mapped.status === 'generating' ? 'generating' : 'queued',
        providerStatus: mapped.providerStatus
      };
    } finally {
      cleanup();
    }
  }

  async getStatus(providerJobId: string): Promise<VideoGenerationStatusResult> {
    this.assertConfigured();

    const { endpoint, requestId } = decodeFalJobId(providerJobId, this.endpoint);
    const { signal, cleanup } = createRequestSignal(this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `${this.baseUrl}/${endpoint}/requests/${encodeURIComponent(requestId)}/status?logs=1`,
          {
            method: 'GET',
            headers: { Authorization: `Key ${this.apiKey}` },
            signal
          }
        );
      } catch (error) {
        throw mapTransportError(error);
      }

      const body = (await response.json().catch(() => ({}))) as {
        status?: unknown;
        error?: unknown;
        error_type?: unknown;
        queue_position?: unknown;
      };

      if (!response.ok) {
        throw mapHttpError(response.status, body);
      }

      if (hasFalError(body)) {
        return {
          status: 'failed',
          providerStatus: typeof body.status === 'string' ? body.status : 'COMPLETED',
          errorCode: 'PROVIDER_FAILED',
          errorMessage: parseFalErrorMessage(body)
        };
      }

      const mapped = mapFalStatus(body.status);
      const metadata =
        typeof body.queue_position === 'number' ? { queuePosition: body.queue_position } : undefined;
      return metadata ? { ...mapped, metadata } : mapped;
    } finally {
      cleanup();
    }
  }

  async download(providerJobId: string): Promise<VideoGenerationDownload> {
    this.assertConfigured();

    const { endpoint, requestId } = decodeFalJobId(providerJobId, this.endpoint);
    const { signal, cleanup } = createRequestSignal(this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/${endpoint}/requests/${encodeURIComponent(requestId)}`, {
          method: 'GET',
          headers: { Authorization: `Key ${this.apiKey}` },
          signal
        });
      } catch (error) {
        throw mapTransportError(error);
      }

      const body = (await response.json().catch(() => ({}))) as {
        video?: { url?: unknown; content_type?: unknown };
        error?: unknown;
        error_type?: unknown;
      };

      if (!response.ok) {
        throw mapHttpError(response.status, body);
      }

      if (hasFalError(body)) {
        throw new VideoGenerationProviderError(parseFalErrorMessage(body), 502, 'PROVIDER_FAILED');
      }

      const videoUrl = body.video && typeof body.video.url === 'string' ? body.video.url : '';
      if (!videoUrl) {
        throw new VideoGenerationProviderError('FAL did not return a video URL for the completed job.', 502, 'DOWNLOAD_FAILED');
      }

      const declaredMime = body.video && typeof body.video.content_type === 'string' ? body.video.content_type : undefined;

      let mediaResponse: Response;
      try {
        // Media URLs are public; the API key is deliberately not sent here.
        mediaResponse = await this.fetchImpl(videoUrl, { method: 'GET', signal });
      } catch (error) {
        throw mapTransportError(error);
      }

      if (!mediaResponse.ok) {
        throw new VideoGenerationProviderError('Failed to download the generated video from FAL.', 502, 'DOWNLOAD_FAILED');
      }

      const bytes = Buffer.from(await mediaResponse.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new VideoGenerationProviderError('FAL returned an empty video payload.', 502, 'DOWNLOAD_FAILED');
      }

      const headerMime = (mediaResponse.headers.get('content-type') || '').split(';')[0].trim();
      const candidateMime = headerMime || declaredMime || 'video/mp4';
      const mimeType = candidateMime.startsWith('video/') ? candidateMime : 'video/mp4';

      return {
        mimeType,
        data: bytes,
        metadata: {
          providerRequestId: requestId,
          endpoint
        }
      };
    } finally {
      cleanup();
    }
  }

  async cancel(providerJobId: string): Promise<void> {
    this.assertConfigured();

    const { endpoint, requestId } = decodeFalJobId(providerJobId, this.endpoint);
    const { signal, cleanup } = createRequestSignal(this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `${this.baseUrl}/${endpoint}/requests/${encodeURIComponent(requestId)}/cancel`,
          {
            method: 'PUT',
            headers: { Authorization: `Key ${this.apiKey}` },
            signal
          }
        );
      } catch (error) {
        throw mapTransportError(error);
      }

      if (!response.ok) {
        throw mapHttpError(response.status, await response.json().catch(() => ({})));
      }
    } finally {
      cleanup();
    }
  }

  private assertConfigured(): void {
    if (!this.apiKey) {
      throw new VideoGenerationProviderError(
        'FAL video generation is not configured. Set FAL_KEY on the server.',
        409,
        'NOT_CONFIGURED'
      );
    }
  }
}
