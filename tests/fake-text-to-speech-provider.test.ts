import { describe, expect, it } from 'vitest';

import { buildSilentWav, silentWavDurationSeconds } from '@/lib/ai/audio/silent-wav';
import { FakeTextToSpeechProvider } from '@/lib/ai/text-to-speech/fake-provider';
import { TextToSpeechProviderError } from '@/lib/ai/text-to-speech/provider';
import { mediaMetadataReader } from '@/lib/media/metadata-reader';

function readWavHeader(buffer: Buffer) {
  return {
    riff: buffer.toString('ascii', 0, 4),
    wave: buffer.toString('ascii', 8, 12),
    sampleRate: buffer.readUInt32LE(24),
    channels: buffer.readUInt16LE(22),
    bitsPerSample: buffer.readUInt16LE(34),
    dataSize: buffer.readUInt32LE(40)
  };
}

describe('fake text-to-speech provider', () => {
  it('emits a decodable WAV with real samples and a positive duration', async () => {
    const provider = new FakeTextToSpeechProvider();
    const result = await provider.synthesize({
      text: 'Hello world from the mock narrator',
      voiceId: 'voice-1',
      format: 'wav'
    });

    const header = readWavHeader(result.data);
    expect(header.riff).toBe('RIFF');
    expect(header.wave).toBe('WAVE');
    expect(header.channels).toBe(1);
    expect(header.bitsPerSample).toBe(16);
    expect(header.dataSize).toBeGreaterThan(0);
    expect(result.mimeType).toBe('audio/wav');
    expect(result.format).toBe('wav');
    expect(result.duration).toBeGreaterThan(0);
    expect(result.duration).toBeCloseTo(silentWavDurationSeconds(result.data), 5);
  });

  it('reports format and MIME that match the emitted bytes for every requested format', async () => {
    const provider = new FakeTextToSpeechProvider();

    for (const format of ['wav', 'mp3', 'm4a'] as const) {
      const result = await provider.synthesize({ text: 'Sample narration', voiceId: 'voice-1', format });
      expect(result.format).toBe('wav');
      expect(result.mimeType).toBe('audio/wav');
      expect(result.data.toString('ascii', 0, 4)).toBe('RIFF');
      expect(result.metadata?.requestedFormat).toBe(format);
    }
  });

  it('keeps the emitted duration within the requested maximum and stays probeable', async () => {
    const provider = new FakeTextToSpeechProvider();
    const result = await provider.synthesize({
      text: 'A fairly long narration sentence that would otherwise run longer than the target scene.',
      voiceId: 'voice-1',
      format: 'wav',
      maxDurationSeconds: 2
    });

    expect(result.duration).toBeGreaterThan(0);
    expect(result.duration).toBeLessThanOrEqual(2.01);

    const probed = await mediaMetadataReader.read(result.data, 'narration.wav', result.mimeType, 'audio');
    expect(probed.duration).toBeCloseTo(result.duration ?? 0, 2);
  });

  it('rejects empty narration text and a missing voice id', async () => {
    const provider = new FakeTextToSpeechProvider();
    await expect(provider.synthesize({ text: '   ', voiceId: 'voice-1', format: 'wav' })).rejects.toBeInstanceOf(TextToSpeechProviderError);
    await expect(provider.synthesize({ text: 'Hello', voiceId: '  ', format: 'wav' })).rejects.toBeInstanceOf(TextToSpeechProviderError);
  });
});

describe('buildSilentWav', () => {
  it('produces a valid header for a zero duration without crashing', () => {
    const header = readWavHeader(buildSilentWav(0));
    expect(header.riff).toBe('RIFF');
    expect(header.dataSize).toBeGreaterThan(0);
  });
});
