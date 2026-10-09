import { TextToSpeechProviderError, type TextToSpeechProvider, type TextToSpeechRequest, type TextToSpeechResult } from './provider';

const SILENCE_WAV_BASE64 =
  'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

export class FakeTextToSpeechProvider implements TextToSpeechProvider {
  readonly providerId = 'fake';

  async synthesize(request: TextToSpeechRequest): Promise<TextToSpeechResult> {
    if (!request.text.trim()) {
      throw new TextToSpeechProviderError('Narration text is required.', 400, 'INVALID_REQUEST');
    }

    if (!request.voiceId.trim()) {
      throw new TextToSpeechProviderError('Voice id is required.', 400, 'INVALID_REQUEST');
    }

    const data = Buffer.from(SILENCE_WAV_BASE64, 'base64');
    return {
      provider: this.providerId,
      model: request.model || 'fake-tts',
      mimeType: request.format === 'wav' ? 'audio/wav' : request.format === 'm4a' ? 'audio/mp4' : 'audio/mpeg',
      format: request.format,
      data,
      duration: 0.25,
      providerRequestId: 'fake-request-id'
    };
  }
}
