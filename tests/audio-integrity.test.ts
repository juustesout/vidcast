import { describe, expect, it } from 'vitest';

import { AudioIntegrityError, sniffAudioFormat, validateGeneratedAudio } from '@/lib/ai/audio/audio-integrity';
import { buildSilentWav } from '@/lib/ai/audio/silent-wav';

describe('sniffAudioFormat', () => {
  it('detects WAV by RIFF/WAVE magic bytes', () => {
    expect(sniffAudioFormat(buildSilentWav(100))).toBe('wav');
  });

  it('detects MP3 by ID3 tag and by frame sync', () => {
    expect(sniffAudioFormat(Buffer.from('ID3....rest'))).toBe('mp3');
    expect(sniffAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3');
  });

  it('detects M4A by ftyp brand box', () => {
    const buffer = Buffer.alloc(16);
    buffer.write('ftyp', 4, 'ascii');
    buffer.write('M4A ', 8, 'ascii');
    expect(sniffAudioFormat(buffer)).toBe('m4a');
  });

  it('detects OGG and FLAC', () => {
    expect(sniffAudioFormat(Buffer.from('OggS....'))).toBe('ogg');
    expect(sniffAudioFormat(Buffer.from('fLaC....'))).toBe('flac');
  });

  it('returns undefined for unrecognized bytes', () => {
    expect(sniffAudioFormat(Buffer.from('<html></html>'))).toBeUndefined();
  });
});

describe('validateGeneratedAudio', () => {
  it('accepts a decodable WAV and reports its format, MIME and duration', async () => {
    const result = await validateGeneratedAudio(buildSilentWav(1000), { reportedFormat: 'wav' });
    expect(result.format).toBe('wav');
    expect(result.mimeType).toBe('audio/wav');
    expect(result.duration).toBeCloseTo(1, 2);
    expect(result.filesize).toBeGreaterThan(44);
  });

  it('rejects empty audio', async () => {
    await expect(validateGeneratedAudio(Buffer.alloc(0))).rejects.toMatchObject({ code: 'empty' });
  });

  it('rejects unrecognized/corrupt containers', async () => {
    await expect(validateGeneratedAudio(Buffer.from('<html>gateway error</html>'))).rejects.toBeInstanceOf(AudioIntegrityError);
    await expect(validateGeneratedAudio(Buffer.from('<html>gateway error</html>'))).rejects.toMatchObject({ code: 'unknown' });
  });

  it('rejects a container that does not match the reported format', async () => {
    await expect(validateGeneratedAudio(buildSilentWav(500), { reportedFormat: 'mp3' })).rejects.toMatchObject({ code: 'formatMismatch' });
  });

  it('rejects a truncated/undecodable container', async () => {
    const truncated = buildSilentWav(1000).subarray(0, 44);
    await expect(validateGeneratedAudio(truncated, { reportedFormat: 'wav' })).rejects.toMatchObject({ code: 'undecodable' });
  });
});
