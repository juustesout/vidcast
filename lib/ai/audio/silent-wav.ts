export const SILENT_WAV_SAMPLE_RATE = 8000;
export const SILENT_WAV_CHANNELS = 1;
export const SILENT_WAV_BITS_PER_SAMPLE = 16;

const BYTES_PER_SAMPLE = SILENT_WAV_BITS_PER_SAMPLE / 8;
const HEADER_BYTES = 44;

function writeAscii(buffer: Buffer, offset: number, value: string): void {
  buffer.write(value, offset, 'ascii');
}

// Deterministic silent PCM WAV so mock generation yields a real, decodable
// audio file whose duration matches the requested length.
export function buildSilentWav(durationMs: number): Buffer {
  const safeDurationMs = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
  const frameCount = Math.max(1, Math.round((SILENT_WAV_SAMPLE_RATE * safeDurationMs) / 1000));
  const dataSize = frameCount * SILENT_WAV_CHANNELS * BYTES_PER_SAMPLE;
  const buffer = Buffer.alloc(HEADER_BYTES + dataSize);

  writeAscii(buffer, 0, 'RIFF');
  buffer.writeUInt32LE(36 + dataSize, 4);
  writeAscii(buffer, 8, 'WAVE');
  writeAscii(buffer, 12, 'fmt ');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(SILENT_WAV_CHANNELS, 22);
  buffer.writeUInt32LE(SILENT_WAV_SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SILENT_WAV_SAMPLE_RATE * SILENT_WAV_CHANNELS * BYTES_PER_SAMPLE, 28);
  buffer.writeUInt16LE(SILENT_WAV_CHANNELS * BYTES_PER_SAMPLE, 32);
  buffer.writeUInt16LE(SILENT_WAV_BITS_PER_SAMPLE, 34);
  writeAscii(buffer, 36, 'data');
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

export function silentWavDurationSeconds(buffer: Buffer): number {
  if (buffer.length <= HEADER_BYTES) {
    return 0;
  }
  const dataSize = buffer.length - HEADER_BYTES;
  return dataSize / (SILENT_WAV_SAMPLE_RATE * SILENT_WAV_CHANNELS * BYTES_PER_SAMPLE);
}
