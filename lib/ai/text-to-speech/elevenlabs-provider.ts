import { mediaMetadataReader } from '@/lib/media/metadata-reader';
import { resolveProviderConcurrencyLimit, withKeyedLimit } from '@/lib/concurrency/keyed-limiter';
import { logProviderError, publicMessageForProviderCode } from '@/lib/security/safe-error';
import { buildPersistedNarrationAlignment, parseCharacterAlignment } from './alignment';
import { TextToSpeechProviderError, type TextToSpeechFormat, type TextToSpeechProvider, type TextToSpeechRequest, type TextToSpeechResult } from './provider';

const DEFAULT_TIMEOUT_MS = 60_000;
// ElevenLabs rejects requests beyond its account concurrency (3 on the standard
// plan). Cap our own fan-out well below any per-request limit so parallel scenes
// can never jointly exceed it.
const DEFAULT_MAX_CONCURRENCY = 3;

interface ElevenLabsTextToSpeechProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
}

interface ResolvedOutputFormat {
  outputFormat: string;
  mimeType: string;
  format: TextToSpeechFormat;
}

// ElevenLabs exposes no WAV-container or AAC/M4A output format: `pcm_*` is
// headerless PCM and there is no wav container. Non-MP3 requests are therefore
// served as MP3 and reported truthfully instead of mislabeling raw PCM/MP3
// bytes as another container.
function resolveOutputFormat(): ResolvedOutputFormat {
  return { outputFormat: 'mp3_44100_128', mimeType: 'audio/mpeg', format: 'mp3' };
}

function classifyHttpError(status: number, payload: unknown): TextToSpeechProviderError {
  let code: TextToSpeechProviderError['code'];
  let mappedStatus: number;
  if (status === 401 || status === 403) {
    code = 'PROVIDER_AUTH';
    mappedStatus = 502;
  } else if (status === 429) {
    code = 'PROVIDER_RATE_LIMIT';
    mappedStatus = 429;
  } else if (status >= 400 && status < 500) {
    code = 'PROVIDER_REJECTED';
    mappedStatus = 422;
  } else {
    code = 'PROVIDER_FAILED';
    mappedStatus = 502;
  }
  logProviderError('elevenlabs-tts', { code, status, body: payload });
  return new TextToSpeechProviderError(publicMessageForProviderCode(code), mappedStatus, code);
}

function mapTransportError(error: unknown): TextToSpeechProviderError {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new TextToSpeechProviderError('ElevenLabs narration timed out or was aborted.', 504, 'PROVIDER_FAILED');
  }
  return new TextToSpeechProviderError('Could not reach the ElevenLabs narration service.', 502, 'PROVIDER_FAILED');
}

// Binds the caller supplied abort signal together with a hard request deadline
// so a stalled paid call cannot hang a request indefinitely.
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

  const timer = setTimeout(() => controller.abort(new Error('Narration request timed out.')), timeoutMs);
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

export class ElevenLabsTextToSpeechProvider implements TextToSpeechProvider {
  readonly providerId = 'elevenlabs';

  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly concurrencyLimit: number;

  constructor(options: ElevenLabsTextToSpeechProviderOptions = {}) {
    this.apiKey = options.apiKey || process.env.ELEVENLABS_API_KEY;
    this.model = options.model || process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2';
    this.baseUrl = options.baseUrl || 'https://api.elevenlabs.io/v1';
    const envTimeout = Number(process.env.ELEVENLABS_TTS_TIMEOUT_MS);
    this.timeoutMs = options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
    this.concurrencyLimit = options.maxConcurrency
      ?? resolveProviderConcurrencyLimit(process.env.ELEVENLABS_TTS_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY);
  }

  async synthesize(request: TextToSpeechRequest, options?: { signal?: AbortSignal }): Promise<TextToSpeechResult> {
    if (!this.apiKey) {
      throw new TextToSpeechProviderError('ElevenLabs text-to-speech is not configured. Set ELEVENLABS_API_KEY on the server.', 409, 'NOT_CONFIGURED');
    }

    if (!request.text.trim()) {
      throw new TextToSpeechProviderError('Narration text is required.', 400, 'INVALID_REQUEST');
    }

    if (!request.voiceId.trim()) {
      throw new TextToSpeechProviderError('Voice id is required.', 400, 'INVALID_REQUEST');
    }

    const resolved = resolveOutputFormat();
    // Captured as a local so the guarded non-undefined key type flows into the
    // concurrency-limited closure below.
    const apiKey = this.apiKey;

    let response: Response;
    try {
      // The provider-wide semaphore caps simultaneous ElevenLabs requests across
      // every scene and run in this process. The request deadline only starts
      // once a slot is acquired, so queueing never counts as a timeout.
      response = await withKeyedLimit(`tts:${this.providerId}`, this.concurrencyLimit, async () => {
        const { signal, cleanup } = createRequestSignal(options?.signal, this.timeoutMs);
        try {
          return await fetch(`${this.baseUrl}/text-to-speech/${encodeURIComponent(request.voiceId)}/with-timestamps?output_format=${encodeURIComponent(resolved.outputFormat)}`, {
            method: 'POST',
            headers: {
              'xi-api-key': apiKey,
              'Content-Type': 'application/json',
              Accept: 'application/json'
            },
            body: JSON.stringify({
              text: request.text,
              model_id: request.model || this.model,
              output_format: resolved.outputFormat,
              voice_settings: {
                stability: request.settings?.stability,
                similarity_boost: request.settings?.similarityBoost,
                style: request.settings?.style,
                use_speaker_boost: request.settings?.speakerBoost
              }
            }),
            signal
          });
        } finally {
          cleanup();
        }
      });
    } catch (error) {
      throw mapTransportError(error);
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as unknown;
      throw classifyHttpError(response.status, payload);
    }

    const providerRequestId = response.headers.get('request-id') || response.headers.get('x-request-id') || undefined;
    const payload = (await response.json().catch(() => null)) as unknown;
    const parsed = parseTimestampedSpeechPayload(payload);
    if (!parsed) {
      throw new TextToSpeechProviderError('ElevenLabs timestamped speech response was missing audio.', 502, 'PROVIDER_FAILED');
    }

    const mimeType = resolved.mimeType;
    const metadata = await mediaMetadataReader.read(parsed.data, `narration.${resolved.format}`, mimeType, 'audio');
    const alignment = buildPersistedNarrationAlignment(parsed.alignment);

    return {
      provider: this.providerId,
      model: request.model || this.model,
      mimeType,
      format: resolved.format,
      data: parsed.data,
      duration: metadata.duration,
      providerRequestId,
      alignment,
      characterAlignment: parseCharacterAlignment(parsed.alignment),
      metadata: {
        outputFormat: resolved.outputFormat,
        requestedFormat: request.format,
        alignmentPresent: Boolean(alignment)
      }
    };
  }
}

function parseTimestampedSpeechPayload(payload: unknown): { data: Buffer; alignment?: unknown } | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }

  const body = payload as { audio_base64?: unknown; audio?: unknown; alignment?: unknown; normalized_alignment?: unknown };
  const encoded = typeof body.audio_base64 === 'string'
    ? body.audio_base64
    : typeof body.audio === 'string'
      ? body.audio
      : undefined;
  if (!encoded) {
    return undefined;
  }

  const data = Buffer.from(encoded, 'base64');
  if (data.byteLength === 0) {
    return undefined;
  }

  return { data, alignment: body.alignment ?? body.normalized_alignment };
}
