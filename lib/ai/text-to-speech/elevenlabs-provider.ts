import { mediaMetadataReader } from '@/lib/media/metadata-reader';
import { TextToSpeechProviderError, type TextToSpeechProvider, type TextToSpeechRequest, type TextToSpeechResult } from './provider';

interface ElevenLabsTextToSpeechProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

function outputFormatForRequest(format: TextToSpeechRequest['format']): string {
  if (format === 'wav') {
    return 'pcm_44100';
  }
  if (format === 'm4a') {
    return 'mp3_44100_128';
  }
  return 'mp3_44100_128';
}

function mimeFromFormat(format: TextToSpeechRequest['format']): string {
  if (format === 'wav') {
    return 'audio/wav';
  }
  if (format === 'm4a') {
    return 'audio/mp4';
  }
  return 'audio/mpeg';
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

export class ElevenLabsTextToSpeechProvider implements TextToSpeechProvider {
  readonly providerId = 'elevenlabs';

  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: ElevenLabsTextToSpeechProviderOptions = {}) {
    this.apiKey = options.apiKey || process.env.ELEVENLABS_API_KEY;
    this.model = options.model || process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2';
    this.baseUrl = options.baseUrl || 'https://api.elevenlabs.io/v1';
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

    const format = outputFormatForRequest(request.format);
    const response = await fetch(`${this.baseUrl}/text-to-speech/${encodeURIComponent(request.voiceId)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: mimeFromFormat(request.format)
      },
      body: JSON.stringify({
        text: request.text,
        model_id: request.model || this.model,
        output_format: format,
        voice_settings: {
          stability: request.settings?.stability,
          similarity_boost: request.settings?.similarityBoost,
          style: request.settings?.style,
          use_speaker_boost: request.settings?.speakerBoost
        }
      }),
      signal: options?.signal
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as unknown;
      const code = response.status === 401 || response.status === 403
        ? 'PROVIDER_AUTH'
        : response.status === 429
          ? 'PROVIDER_RATE_LIMIT'
          : response.status >= 400 && response.status < 500
            ? 'PROVIDER_REJECTED'
            : 'PROVIDER_FAILED';
      throw new TextToSpeechProviderError(parseErrorMessage(payload), response.status >= 400 && response.status < 500 ? 422 : 502, code);
    }

    const mimeType = response.headers.get('content-type') || mimeFromFormat(request.format);
    const providerRequestId = response.headers.get('request-id') || response.headers.get('x-request-id') || undefined;
    const data = Buffer.from(await response.arrayBuffer());
    const metadata = await mediaMetadataReader.read(data, `narration.${request.format}`, mimeType, 'audio');

    return {
      provider: this.providerId,
      model: request.model || this.model,
      mimeType,
      format: request.format,
      data,
      duration: metadata.duration,
      providerRequestId,
      metadata: {
        outputFormat: format
      }
    };
  }
}
