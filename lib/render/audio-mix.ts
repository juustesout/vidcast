import { DEFAULT_RENDER_SETTINGS } from '@/lib/constants';
import type { AudioMixSettings } from '@/lib/types/render';

export const MIN_AUDIO_VOLUME = 0;
export const MAX_AUDIO_VOLUME = 4;

export interface AudioMixInput {
  narrationVolume?: unknown;
  musicVolume?: unknown;
  effectsVolume?: unknown;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

export function clampAudioVolume(value: unknown, fallback: number): number {
  const numeric = asFiniteNumber(value) ?? fallback;
  return Math.min(MAX_AUDIO_VOLUME, Math.max(MIN_AUDIO_VOLUME, numeric));
}

export function normalizeAudioMix(audio?: AudioMixInput | null): AudioMixSettings {
  return {
    narrationVolume: clampAudioVolume(audio?.narrationVolume, DEFAULT_RENDER_SETTINGS.audio.narrationVolume),
    musicVolume: clampAudioVolume(audio?.musicVolume, DEFAULT_RENDER_SETTINGS.audio.musicVolume),
    effectsVolume: clampAudioVolume(audio?.effectsVolume, DEFAULT_RENDER_SETTINGS.audio.effectsVolume)
  };
}

// Produces a deterministic, always-valid FFmpeg volume multiplier (e.g. "1.000").
export function formatVolumeFilter(value: unknown, fallback = 1): string {
  return clampAudioVolume(value, clampAudioVolume(fallback, 1)).toFixed(3);
}

export function audioMixesEqual(left: AudioMixSettings | undefined, right: AudioMixSettings | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.narrationVolume === right.narrationVolume &&
    left.musicVolume === right.musicVolume &&
    left.effectsVolume === right.effectsVolume
  );
}
