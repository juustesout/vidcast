import { mediaMetadataReader } from '@/lib/media/metadata-reader';

import { MusicProviderError, type MusicGenerationRequest, type MusicGenerationResult, type MusicProvider } from './provider';

interface ElevenLabsMusicProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  outputFormat?: string;
  timeoutMs?: number;
}

// ElevenLabs Music generation bounds, mirrored from the API reference so the
// adapter rejects impossible requests before any paid call is constructed.
export const MIN_MUSIC_DURATION_MS = 3000;
export const MAX_MUSIC_DURATION_MS = 600000;

export const ELEVENLABS_MUSIC_MODELS = ['music_v1', 'music_v2', 'music_v2_5'] as const;
export const DEFAULT_ELEVENLABS_MUSIC_MODEL = 'music_v2_5';

// Starter plans only expose lossless/high-bitrate downloads behind higher tiers,
// so we default to the standard 128 kbps MP3 and only accept MP3 codes (which
// also keep the stored asset extension/mime mapping unambiguous).
export const DEFAULT_ELEVENLABS_MUSIC_OUTPUT_FORMAT = 'mp3_44100_128';
const ALLOWED_MP3_OUTPUT_FORMATS = new Set([
  'mp3_48000_128',
  'mp3_48000_192',
  'mp3_48000_240',
  'mp3_48000_320',
  'mp3_22050_32',
  'mp3_24000_48',
  'mp3_44100_32',
  'mp3_44100_64',
  'mp3_44100_96',
  'mp3_44100_128',
  'mp3_44100_192'
]);

// The API does not publish a numeric prompt length cap. We enforce a
// conservative bound so an unbounded prompt can never reach the provider.
export const MAX_MUSIC_PROMPT_LENGTH = 2000;

const DEFAULT_TIMEOUT_MS = 300000;

function resolveOutputFormat(value?: string): string {
  const candidate = (value || process.env.ELEVENLABS_MUSIC_OUTPUT_FORMAT || DEFAULT_ELEVENLABS_MUSIC_OUTPUT_FORMAT).trim().toLowerCase();
  if (candidate === 'mp3' || candidate === 'auto') {
    return DEFAULT_ELEVENLABS_MUSIC_OUTPUT_FORMAT;
  }
  if (ALLOWED_MP3_OUTPUT_FORMATS.has(candidate)) {
    return candidate;
  }
  throw new MusicProviderError(`Unsupported output format: ${value}.`, 400, 'INVALID_REQUEST');
}

function resolveModel(value?: string): string {
  const candidate = (value || process.env.ELEVENLABS_MUSIC_MODEL || DEFAULT_ELEVENLABS_MUSIC_MODEL).trim();
  if ((ELEVENLABS_MUSIC_MODELS as readonly string[]).includes(candidate)) {
    return candidate;
  }
  throw new MusicProviderError(`Unsupported music model: ${value}.`, 400, 'INVALID_REQUEST');
}

// ElevenLabs returns validation problems as `detail: [{ msg }]`, while other
// errors use `detail: string` or `detail.message`. Normalize all shapes.
function parseErrorMessage(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const maybe = payload as {
      detail?: string | { message?: string } | Array<{ msg?: string }>;
      error?: { message?: string };
    };
    if (typeof maybe.detail === 'string' && maybe.detail) {
      return maybe.detail;
    }
    if (Array.isArray(maybe.detail)) {
      const messages = maybe.detail.map((entry) => entry?.msg).filter((msg): msg is string => Boolean(msg));
      if (messages.length > 0) {
        return messages.join('; ');
      }
    }
    if (maybe.detail && typeof maybe.detail === 'object' && !Array.isArray(maybe.detail) && maybe.detail.message) {
      return maybe.detail.message;
    }
    if (maybe.error?.message) {
      return maybe.error.message;
    }
  }
  return 'ElevenLabs music generation request failed.';
}

function mapHttpError(status: number, payload: unknown): MusicProviderError {
  if (status === 401 || status === 403) {
    return new MusicProviderError(parseErrorMessage(payload), 502, 'PROVIDER_AUTH');
  }
  if (status === 429) {
    return new MusicProviderError(parseErrorMessage(payload), 429, 'PROVIDER_RATE_LIMIT');
  }
  if (status >= 400 && status < 500) {
    return new MusicProviderError(parseErrorMessage(payload), 422, 'PROVIDER_REJECTED');
  }
  return new MusicProviderError(parseErrorMessage(payload), 502, 'PROVIDER_FAILED');
}

function mapTransportError(error: unknown): MusicProviderError {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new MusicProviderError('ElevenLabs music generation timed out or was aborted.', 504, 'PROVIDER_FAILED');
  }
  return new MusicProviderError('Could not reach the ElevenLabs music generation service.', 502, 'PROVIDER_FAILED');
}

// Binds the caller-supplied abort signal together with a hard request deadline
// so a stalled paid call cannot hang the request indefinitely.
function createRequestSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(callerSignal?.reason);

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const timer = setTimeout(() => controller.abort(new Error('Music generation request timed out.')), timeoutMs);
  if (typeof timer === 'object' && typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (callerSignal) {
        callerSignal.removeEventListener('abort', onAbort);
      }
    }
  };
}

export class ElevenLabsMusicProvider implements MusicProvider {
  readonly providerId = 'elevenlabs';

  private readonly apiKey?: string;
  private readonly configuredModel?: string;
  private readonly baseUrl: string;
  private readonly configuredOutputFormat?: string;
  private readonly timeoutMs: number;

  constructor(options: ElevenLabsMusicProviderOptions = {}) {
    this.apiKey = options.apiKey || process.env.ELEVENLABS_API_KEY;
    this.configuredModel = options.model || process.env.ELEVENLABS_MUSIC_MODEL;
    this.baseUrl = (options.baseUrl || process.env.ELEVENLABS_MUSIC_BASE_URL || 'https://api.elevenlabs.io/v1').replace(/\/$/, '');
    this.configuredOutputFormat = options.outputFormat;
    const envTimeout = Number(process.env.ELEVENLABS_MUSIC_TIMEOUT_MS);
    this.timeoutMs = options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  }

  async generate(request: MusicGenerationRequest, options?: { signal?: AbortSignal }): Promise<MusicGenerationResult> {
    if (!this.apiKey) {
      throw new MusicProviderError('ElevenLabs music generation is not configured. Set ELEVENLABS_API_KEY on the server.', 409, 'NOT_CONFIGURED');
    }

    const prompt = request.prompt.trim();
    if (!prompt) {
      throw new MusicProviderError('A music prompt is required.', 400, 'INVALID_REQUEST');
    }
    if (prompt.length > MAX_MUSIC_PROMPT_LENGTH) {
      throw new MusicProviderError(`Music prompt must be at most ${MAX_MUSIC_PROMPT_LENGTH} characters.`, 400, 'INVALID_REQUEST');
    }

    if (!Number.isInteger(request.durationMs) || request.durationMs < MIN_MUSIC_DURATION_MS || request.durationMs > MAX_MUSIC_DURATION_MS) {
      throw new MusicProviderError(
        `Music length must be between ${MIN_MUSIC_DURATION_MS} and ${MAX_MUSIC_DURATION_MS} milliseconds.`,
        400,
        'INVALID_REQUEST'
      );
    }

    const model = resolveModel(request.model || this.configuredModel);
    const outputFormat = resolveOutputFormat(request.outputFormat || this.configuredOutputFormat);

    // `seed` cannot be combined with `prompt` (the API only accepts seed without
    // a prompt), so it is intentionally omitted from the request body.
    const body: Record<string, unknown> = {
      prompt,
      music_length_ms: request.durationMs,
      model_id: model,
      force_instrumental: request.instrumental ?? true
    };

    const { signal, cleanup } = createRequestSignal(options?.signal, this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/music?output_format=${encodeURIComponent(outputFormat)}`, {
          method: 'POST',
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg'
          },
          body: JSON.stringify(body),
          signal
        });
      } catch (error) {
        throw mapTransportError(error);
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw mapHttpError(response.status, payload);
      }

      const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (contentType.includes('json')) {
        throw new MusicProviderError('ElevenLabs music generation returned an unexpected response.', 502, 'PROVIDER_FAILED');
      }

      let data: Buffer;
      try {
        data = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        throw mapTransportError(error);
      }

      if (data.byteLength === 0) {
        throw new MusicProviderError('ElevenLabs music generation returned an empty audio result.', 502, 'PROVIDER_FAILED');
      }

      const mimeType = contentType.startsWith('audio/') ? contentType : 'audio/mpeg';
      const providerRequestId = response.headers.get('request-id') || response.headers.get('x-request-id') || undefined;
      const songId = response.headers.get('song-id') || response.headers.get('x-song-id') || undefined;
      const metadata = await mediaMetadataReader.read(data, 'music.mp3', mimeType, 'music');

      return {
        provider: this.providerId,
        model,
        mimeType,
        format: 'mp3',
        data,
        duration: metadata.duration,
        providerRequestId,
        metadata: {
          outputFormat,
          songId
        }
      };
    } finally {
      cleanup();
    }
  }
}
