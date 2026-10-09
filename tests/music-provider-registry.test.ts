import { describe, expect, it } from 'vitest';

import { FakeMusicProvider, buildSilentWav } from '@/lib/ai/music/fake-provider';
import { MusicProviderError } from '@/lib/ai/music/provider';
import { createMusicRegistry } from '@/lib/ai/music/registry';

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

describe('fake music provider', () => {
  it('builds a decodable silent WAV whose length matches the requested duration', async () => {
    const provider = new FakeMusicProvider();
    const result = await provider.generate({ prompt: 'calm', durationMs: 4000, model: 'music_v1', instrumental: true });

    expect(result.provider).toBe('fake');
    expect(result.mimeType).toBe('audio/wav');
    expect(result.format).toBe('wav');

    const header = readWavHeader(result.data);
    expect(header.riff).toBe('RIFF');
    expect(header.wave).toBe('WAVE');
    expect(header.channels).toBe(1);
    expect(header.bitsPerSample).toBe(16);
    expect(header.dataSize).toBeGreaterThan(0);
    expect(result.duration).toBeCloseTo(4, 2);
  });

  it('rejects an empty prompt and a non-positive duration', async () => {
    const provider = new FakeMusicProvider();
    await expect(provider.generate({ prompt: '   ', durationMs: 3000 })).rejects.toBeInstanceOf(MusicProviderError);
    await expect(provider.generate({ prompt: 'calm', durationMs: 0 })).rejects.toBeInstanceOf(MusicProviderError);
  });
});

describe('music provider registry', () => {
  it('resolves the fake provider and rejects unsupported real providers', () => {
    const registry = createMusicRegistry();
    expect(registry.getProvider('fake').providerId).toBe('fake');
    expect(registry.getProvider('local').providerId).toBe('fake');
    expect(() => registry.getProvider('elevenlabs')).toThrow(MusicProviderError);
    try {
      registry.getProvider('elevenlabs');
    } catch (error) {
      expect((error as MusicProviderError).code).toBe('UNSUPPORTED');
    }
  });
});

describe('buildSilentWav', () => {
  it('produces a valid header for a zero/invalid duration without crashing', () => {
    const header = readWavHeader(buildSilentWav(0));
    expect(header.riff).toBe('RIFF');
    expect(header.dataSize).toBeGreaterThan(0);
  });
});
