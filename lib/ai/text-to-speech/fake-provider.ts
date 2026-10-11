import { buildSilentWav, silentWavDurationSeconds } from '@/lib/ai/audio/silent-wav';

import { TextToSpeechProviderError, type TextToSpeechProvider, type TextToSpeechRequest, type TextToSpeechResult } from './provider';

const WORDS_PER_SECOND = 2.5;

function estimateDurationSeconds(text: string, maxDurationSeconds?: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const estimated = words / WORDS_PER_SECOND;
  const capped = typeof maxDurationSeconds === 'number' && maxDurationSeconds > 0
    ? Math.min(estimated, maxDurationSeconds)
    : estimated;
  return Math.max(0, capped);
}

export class FakeTextToSpeechProvider implements TextToSpeechProvider {
  readonly providerId = 'fake';

  async synthesize(request: TextToSpeechRequest): Promise<TextToSpeechResult> {
    if (!request.text.trim()) {
      throw new TextToSpeechProviderError('Narration text is required.', 400, 'INVALID_REQUEST');
    }

    if (!request.voiceId.trim()) {
      throw new TextToSpeechProviderError('Voice id is required.', 400, 'INVALID_REQUEST');
    }

    const durationSeconds = estimateDurationSeconds(request.text, request.maxDurationSeconds);
    const data = buildSilentWav(durationSeconds * 1000);

    return {
      provider: this.providerId,
      model: request.model || 'fake-tts',
      mimeType: 'audio/wav',
      format: 'wav',
      data,
      duration: silentWavDurationSeconds(data),
      providerRequestId: 'fake-request-id',
      metadata: {
        requestedFormat: request.format
      }
    };
  }
}
