import { mediaMetadataReader } from '@/lib/media/metadata-reader';
import { TextToSpeechProviderError, type TextToSpeechFormat, type TextToSpeechProvider, type TextToSpeechRequest, type TextToSpeechResult } from './provider';

const DEFAULT_TIMEOUT_MS = 120_000;

interface ElevenLabsTextToSpeechProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
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

function parseErrorMessage(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const maybe = payload as { detail?: { message?: string } | string; error?: { message?: string } };
    if (typeof maybe.detail === 'string') {
      return maybe.detail;
    }
    if (maybe.detail && typeof maybe.detail === 'object' && maybe.detail.message) {
      return maybe.detail.message;
    }
    if (maybe.error?.message) {
      return maybe.error.message;
    }
  }
  return 'Text-to-speech provider request failed.';
}

// Classifies non-2xx HTTP responses without ever echoing credentials. Auth and
// rate-limit failures are surfaced distinctly so callers can react (and so a
// retry is never issued automatically by this adapter).
function classifyHttpError(status: number, message: string): TextToSpeechProviderError {
  if (status === 401 || status === 403) {
    return new TextToSpeechProviderError(message, 502, 'PROVIDER_AUTH');
  }
  if (status === 429) {
    return new TextToSpeechProviderError(message, 429, 'PROVIDER_RATE_LIMIT');
  }
  if (status >= 400 && status < 500) {
    return new TextToSpeechProviderError(message, 422, 'PROVIDER_REJECTED');
  }
  return new TextToSpeechProviderError(message, 502, 'PROVIDER_FAILED');
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

  constructor(options: ElevenLabsTextToSpeechProviderOptions = {}) {
    this.apiKey = options.apiKey || process.env.ELEVENLABS_API_KEY;
    this.model = options.model || process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2';
    this.baseUrl = options.baseUrl || 'https://api.elevenlabs.io/v1';
    const envTimeout = Number(process.env.ELEVENLABS_TTS_TIMEOUT_MS);
    this.timeoutMs = options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
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
    const { signal, cleanup } = createRequestSignal(options?.signal, this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/text-to-speech/${encodeURIComponent(request.voiceId)}`, {
          method: 'POST',
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
            Accept: resolved.mimeType
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
      } catch (error) {
        throw mapTransportError(error);
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as unknown;
        throw classifyHttpError(response.status, parseErrorMessage(payload));
      }

      const mimeType = response.headers.get('content-type') || resolved.mimeType;
      const providerRequestId = response.headers.get('request-id') || response.headers.get('x-request-id') || undefined;
      const data = Buffer.from(await response.arrayBuffer());
      const metadata = await mediaMetadataReader.read(data, `narration.${resolved.format}`, mimeType, 'audio');

      return {
        provider: this.providerId,
        model: request.model || this.model,
        mimeType,
        format: resolved.format,
        data,
        duration: metadata.duration,
        providerRequestId,
        metadata: {
          outputFormat: resolved.outputFormat,
          requestedFormat: request.format
        }
      };
    } finally {
      cleanup();
    }
  }
}
