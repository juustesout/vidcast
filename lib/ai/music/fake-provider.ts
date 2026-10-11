import { buildSilentWav, silentWavDurationSeconds } from '@/lib/ai/audio/silent-wav';

import { MusicProviderError, type MusicGenerationRequest, type MusicGenerationResult, type MusicProvider } from './provider';

export { buildSilentWav } from '@/lib/ai/audio/silent-wav';

export class FakeMusicProvider implements MusicProvider {
  readonly providerId = 'fake';

  async generate(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
    if (!request.prompt.trim()) {
      throw new MusicProviderError('Music prompt is required.', 400, 'INVALID_REQUEST');
    }

    if (!Number.isFinite(request.durationMs) || request.durationMs <= 0) {
      throw new MusicProviderError('Music duration must be greater than zero.', 400, 'INVALID_REQUEST');
    }

    const data = buildSilentWav(request.durationMs);
    const duration = silentWavDurationSeconds(data);

    return {
      provider: this.providerId,
      model: request.model || 'fake-music',
      mimeType: 'audio/wav',
      format: 'wav',
      data,
      duration,
      providerRequestId: 'fake-music-request-id',
      metadata: {
        outputFormat: request.outputFormat ?? 'wav',
        instrumental: request.instrumental ?? true
      }
    };
  }
}
