import { MusicProviderError, type MusicGenerationRequest, type MusicGenerationResult, type MusicProvider } from './provider';

const SAMPLE_RATE = 8000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

function writeAscii(buffer: Buffer, offset: number, value: string): void {
  buffer.write(value, offset, 'ascii');
}

// Deterministic silent PCM WAV so mock generation yields a real, decodable
// audio file whose duration matches the requested length.
export function buildSilentWav(durationMs: number): Buffer {
  const safeDurationMs = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
  const frameCount = Math.max(1, Math.round((SAMPLE_RATE * safeDurationMs) / 1000));
  const dataSize = frameCount * CHANNELS * BYTES_PER_SAMPLE;
  const buffer = Buffer.alloc(44 + dataSize);

  writeAscii(buffer, 0, 'RIFF');
  buffer.writeUInt32LE(36 + dataSize, 4);
  writeAscii(buffer, 8, 'WAVE');
  writeAscii(buffer, 12, 'fmt ');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28);
  buffer.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  writeAscii(buffer, 36, 'data');
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

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
    const duration = data.length > 44 ? ((data.length - 44) / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) : 0;

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
