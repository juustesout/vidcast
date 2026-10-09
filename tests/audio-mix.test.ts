import { describe, expect, it } from 'vitest';

import { DEFAULT_RENDER_SETTINGS } from '@/lib/constants';
import {
  MAX_AUDIO_VOLUME,
  MIN_AUDIO_VOLUME,
  audioMixesEqual,
  clampAudioVolume,
  formatVolumeFilter,
  normalizeAudioMix
} from '@/lib/render/audio-mix';

describe('audio mix normalization', () => {
  it('returns project defaults when no input is provided', () => {
    expect(normalizeAudioMix()).toEqual(DEFAULT_RENDER_SETTINGS.audio);
    expect(normalizeAudioMix(null)).toEqual(DEFAULT_RENDER_SETTINGS.audio);
    expect(normalizeAudioMix({})).toEqual(DEFAULT_RENDER_SETTINGS.audio);
  });

  it('keeps valid values within bounds', () => {
    const mix = normalizeAudioMix({ narrationVolume: 0.5, musicVolume: 1.25, effectsVolume: 0 });
    expect(mix).toEqual({ narrationVolume: 0.5, musicVolume: 1.25, effectsVolume: 0 });
  });

  it('clamps negative and oversized values to the allowed range', () => {
    const mix = normalizeAudioMix({ narrationVolume: -3, musicVolume: 99, effectsVolume: -0.0001 });
    expect(mix.narrationVolume).toBe(MIN_AUDIO_VOLUME);
    expect(mix.musicVolume).toBe(MAX_AUDIO_VOLUME);
    expect(mix.effectsVolume).toBe(MIN_AUDIO_VOLUME);
  });

  it('falls back to defaults for non-finite and non-numeric values', () => {
    const mix = normalizeAudioMix({
      narrationVolume: Number.NaN,
      musicVolume: Number.POSITIVE_INFINITY,
      effectsVolume: '0.5' as unknown as number
    });
    expect(mix).toEqual(DEFAULT_RENDER_SETTINGS.audio);
  });

  it('formats a deterministic, valid FFmpeg volume multiplier', () => {
    expect(formatVolumeFilter(1)).toBe('1.000');
    expect(formatVolumeFilter(0.5)).toBe('0.500');
    expect(formatVolumeFilter(-1)).toBe('0.000');
    expect(formatVolumeFilter(Number.NaN)).toBe('1.000');
    expect(formatVolumeFilter(99)).toBe(`${MAX_AUDIO_VOLUME.toFixed(3)}`);
  });

  it('compares mixes by field value', () => {
    const base = { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 };
    expect(audioMixesEqual(base, { ...base })).toBe(true);
    expect(audioMixesEqual(base, { ...base, narrationVolume: 0.5 })).toBe(false);
    expect(audioMixesEqual(undefined, undefined)).toBe(true);
    expect(audioMixesEqual(base, undefined)).toBe(false);
  });

  it('exposes a bounded clamp helper', () => {
    expect(clampAudioVolume(2, 1)).toBe(2);
    expect(clampAudioVolume(undefined, 0.35)).toBe(0.35);
    expect(clampAudioVolume(-1, 1)).toBe(0);
    expect(clampAudioVolume(MAX_AUDIO_VOLUME + 5, 1)).toBe(MAX_AUDIO_VOLUME);
  });
});
