import type { AspectRatio } from '@/lib/types/render';

import {
  VideoGenerationProviderError,
  type VideoGenerationCapabilities,
  type VideoGenerationDownload,
  type VideoGenerationProvider,
  type VideoGenerationRequest,
  type VideoGenerationStatusResult,
  type VideoGenerationSubmission,
  type VideoReferenceInput
} from './provider';

// Official FAL.ai queue contract (verified against
// https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max-turbo/text-to-video
// and https://fal.ai/docs/documentation/model-apis/inference/queue):
//   - auth header `Authorization: Key $FAL_KEY`
//   - submit   POST  {base}/{endpoint}                         -> { request_id, status?, response_url, status_url, cancel_url, ... }
//   - status   GET   {base}/{queuePath}/requests/{id}/status?logs=1 -> { status, ... }
//   - result   GET   {base}/{queuePath}/requests/{id}          -> model output ({ video: { url } })
//   - cancel   PUT   {base}/{queuePath}/requests/{id}/cancel
//
// The submit model id and the queue resource path are NOT always the same. For a
// multi-segment model id such as `minimax/h3-max-turbo/text-to-video`, the queue
// lives under `minimax/h3-max-turbo` (the endpoint sub-path is dropped), so
// polling the full model id returns HTTP 405. The authoritative queue path is the
// one FAL returns in `response_url`/`status_url`/`cancel_url`, so submit derives
// and persists it (see `resolveQueuePath`) and all later calls rebuild the URL from
// it. Returned URLs are only used to learn the path; they are validated to be on
// the configured queue host, and the API key is never sent to any other host.
//
// Media URLs returned by FAL are public but expire, so the result is downloaded
// immediately during the `generated` poll (see video-generation-service).
export const DEFAULT_FAL_VIDEO_ENDPOINT = 'minimax/h3-max-turbo/text-to-video';
export const DEFAULT_FAL_VIDEO_BASE_URL = 'https://queue.fal.run';
export const DEFAULT_FAL_VIDEO_PROMPT_EXPANSION_MODE = 'disabled';

// Image-to-video variant. Same queue transport and job lifecycle as text-to-video;
// only the input contract differs (keyframe image fields instead of aspect_ratio).
export const FAL_IMAGE_TO_VIDEO_ENDPOINT_SUFFIX = 'image-to-video';

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
  // The queue resource path (the segment(s) before `/requests/{id}`), e.g.
  // `minimax/h3-max-turbo` for the model `minimax/h3-max-turbo/text-to-video`.
  queuePath: string;
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

// The selected endpoint decides whether the adapter speaks text-to-video or
// image-to-video. Kept private and derived from the resolved endpoint so the
// configured default (env) and a per-request model override share one rule.
function isImageToVideoEndpoint(endpoint: string): boolean {
  const segments = endpoint.split('/');
  return segments[segments.length - 1] === FAL_IMAGE_TO_VIDEO_ENDPOINT_SUFFIX;
}

// Maps the explicit frame roles to the two i2v image fields. Exactly the
// designated keyframes are accepted; a plain `reference` (or a duplicate frame)
// is rejected so unsupported inputs are never silently dropped.
function resolveFrameReferences(references: VideoReferenceInput[]): {
  startFrame?: VideoReferenceInput;
  endFrame?: VideoReferenceInput;
} {
  let startFrame: VideoReferenceInput | undefined;
  let endFrame: VideoReferenceInput | undefined;

  for (const reference of references) {
    if (reference.role === 'start_frame') {
      if (startFrame) {
        throw new VideoGenerationProviderError('FAL image-to-video accepts at most one start frame.', 422, 'REFERENCE_ERROR');
      }
      startFrame = reference;
    } else if (reference.role === 'end_frame') {
      if (endFrame) {
        throw new VideoGenerationProviderError('FAL image-to-video accepts at most one end frame.', 422, 'REFERENCE_ERROR');
      }
      endFrame = reference;
    } else {
      throw new VideoGenerationProviderError(
        'FAL image-to-video only accepts start/end frame images, not plain references.',
        422,
        'REFERENCE_ERROR'
      );
    }
  }

  if (!startFrame && !endFrame) {
    throw new VideoGenerationProviderError('FAL image-to-video requires a start and/or end frame image.', 400, 'INVALID_REQUEST');
  }

  return { startFrame, endFrame };
}

// Encodes a local frame as a base64 data URI so the only authenticated request is
// the queue submit; no public asset URL is created and the key never leaves the
// queue host. Never logged or returned in error messages.
function toImageDataUri(reference: VideoReferenceInput, label: 'start' | 'end'): string {
  const mimeType = (reference.mimeType || '').trim().toLowerCase();
  if (!mimeType.startsWith('image/')) {
    throw new VideoGenerationProviderError(`FAL image-to-video ${label} frame must be an image.`, 422, 'REFERENCE_ERROR');
  }
  if (!reference.data || reference.data.byteLength === 0) {
    throw new VideoGenerationProviderError(`FAL image-to-video ${label} frame is empty.`, 422, 'REFERENCE_ERROR');
  }
  return `data:${mimeType};base64,${reference.data.toString('base64')}`;
}

// Resolves the queue resource path from the URLs FAL returns on submit. The
// model id used for `submit` is not necessarily the queue path (see the header
// comment), so the response is the authoritative source. Only URLs that are
// absolute, match the configured queue origin (protocol + host) and contain this
// request's `/requests/{id}` marker are trusted; anything else is ignored so a
// tampered/foreign URL can never influence where the API key is sent. Returns
// `undefined` when no candidate is usable, letting the caller fall back.
function resolveQueuePath(requestId: string, candidates: unknown[], baseUrl: string): string | undefined {
  let expected: URL;
  try {
    expected = new URL(baseUrl);
  } catch {
    return undefined;
  }

  const marker = `/requests/${requestId}`;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }

    if (parsed.protocol !== expected.protocol || parsed.host !== expected.host) {
      continue;
    }

    const index = parsed.pathname.indexOf(marker);
    if (index <= 0) {
      continue;
    }

    const queuePath = parsed.pathname.slice(0, index).replace(/^\/+/, '').replace(/\/+$/, '');
    if (!queuePath || !ENDPOINT_PATTERN.test(queuePath)) {
      continue;
    }
    return queuePath;
  }

  return undefined;
}

// Composite, durable job identity. The registry constructs a fresh provider per
// call and `getStatus`/`download` receive only the provider job id, so the queue
// resource path must travel with the request id or a restart could poll the wrong
// location. Format: `fal:{queuePath}:{request_id}`. The format is unchanged from
// the original `fal:{endpoint}:{request_id}`; only the meaning of the middle
// segment is now "queue path" (for a two-segment app id it is identical to the
// model id). Legacy ids still decode and behave exactly as before the fix.
export function encodeFalJobId(queuePath: string, requestId: string): string {
  return `${JOB_ID_PREFIX}:${queuePath}:${requestId}`;
}

export function decodeFalJobId(jobId: string, fallbackQueuePath?: string): FalJobIdentity {
  const trimmed = (jobId || '').trim();
  if (!trimmed) {
    throw new VideoGenerationProviderError('A FAL video job id is required.', 400, 'INVALID_REQUEST');
  }

  if (trimmed.startsWith(`${JOB_ID_PREFIX}:`)) {
    const rest = trimmed.slice(JOB_ID_PREFIX.length + 1);
    const separator = rest.lastIndexOf(':');
    if (separator > 0 && separator < rest.length - 1) {
      const queuePath = rest.slice(0, separator);
      const requestId = rest.slice(separator + 1);
      if (ENDPOINT_PATTERN.test(queuePath) && requestId) {
        return { queuePath, requestId };
      }
    }
    throw new VideoGenerationProviderError('Malformed FAL video job id.', 400, 'INVALID_REQUEST');
  }

  // Legacy/raw request id: fall back to the configured endpoint. Old multi-segment
  // model ids encoded before the queue-path fix keep their (previous) behaviour.
  const queuePath = fallbackQueuePath ? resolveEndpoint(fallbackQueuePath) : DEFAULT_FAL_VIDEO_ENDPOINT;
  return { queuePath, requestId: trimmed };
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
    const imageToVideo = isImageToVideoEndpoint(this.endpoint);
    return {
      supportsTextToVideo: true,
      // Reflects the configured default endpoint; a per-request `model` override
      // is the authority at submit time (see `submit`).
      supportsImageToVideo: imageToVideo,
      // Generic reference conditioning is not supported; image-to-video consumes
      // only the explicitly designated start/end keyframes.
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

    const endpoint = resolveEndpoint(request.model?.trim() || this.endpoint);
    const references = request.references ?? [];
    const duration = resolveDuration(request.durationSeconds);

    const payload: Record<string, unknown> = {
      prompt,
      prompt_expansion_mode: this.promptExpansionMode
    };

    if (isImageToVideoEndpoint(endpoint)) {
      const { startFrame, endFrame } = resolveFrameReferences(references);
      // The i2v endpoint has no aspect_ratio field: the output canvas follows the
      // frame image. `sync_mode` is explicitly false so the completed job exposes
      // a CDN URL the download path can fetch (true would inline base64 media).
      payload.sync_mode = false;
      if (startFrame) {
        payload.image_url = toImageDataUri(startFrame, 'start');
      }
      if (endFrame) {
        payload.end_image_url = toImageDataUri(endFrame, 'end');
      }
    } else if (references.length > 0) {
      // Text-to-video has no image input: an unsupported combination is rejected
      // explicitly rather than silently dropped.
      throw new VideoGenerationProviderError(
        'FAL text-to-video does not support reference images.',
        422,
        'REFERENCE_ERROR'
      );
    } else {
      const aspectRatio = resolveAspectRatio(request.aspectRatio);
      if (aspectRatio) {
        payload.aspect_ratio = aspectRatio;
      }
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
        response_url?: unknown;
        status_url?: unknown;
        cancel_url?: unknown;
      };

      if (!response.ok) {
        throw mapHttpError(response.status, body);
      }

      const requestId = typeof body.request_id === 'string' ? body.request_id.trim() : '';
      if (!requestId) {
        throw new VideoGenerationProviderError('FAL did not return a request id.', 502, 'PROVIDER_FAILED');
      }

      // Prefer the queue path FAL reports in its own URLs; fall back to the
      // submitted endpoint when the response omits them (older/edge responses).
      const queuePath =
        resolveQueuePath(requestId, [body.response_url, body.status_url, body.cancel_url], this.baseUrl) ??
        endpoint;

      const mapped = mapFalStatus(body.status);
      return {
        providerJobId: encodeFalJobId(queuePath, requestId),
        status: mapped.status === 'generating' ? 'generating' : 'queued',
        providerStatus: mapped.providerStatus
      };
    } finally {
      cleanup();
    }
  }

  async getStatus(providerJobId: string): Promise<VideoGenerationStatusResult> {
    this.assertConfigured();

    const { queuePath, requestId } = decodeFalJobId(providerJobId, this.endpoint);
    const { signal, cleanup } = createRequestSignal(this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `${this.baseUrl}/${queuePath}/requests/${encodeURIComponent(requestId)}/status?logs=1`,
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

    const { queuePath, requestId } = decodeFalJobId(providerJobId, this.endpoint);
    const { signal, cleanup } = createRequestSignal(this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/${queuePath}/requests/${encodeURIComponent(requestId)}`, {
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
          queuePath
        }
      };
    } finally {
      cleanup();
    }
  }

  async cancel(providerJobId: string): Promise<void> {
    this.assertConfigured();

    const { queuePath, requestId } = decodeFalJobId(providerJobId, this.endpoint);
    const { signal, cleanup } = createRequestSignal(this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `${this.baseUrl}/${queuePath}/requests/${encodeURIComponent(requestId)}/cancel`,
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
