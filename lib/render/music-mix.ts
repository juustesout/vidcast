import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';

// ElevenLabs Music accepts 3000..600000 ms; we mirror those bounds so the
// service never builds a request the provider would reject.
export const MIN_MUSIC_LENGTH_MS = 3000;
export const MAX_MUSIC_LENGTH_MS = 600000;
export const DEFAULT_MUSIC_LENGTH_MS = 60000;

// Fixed, deterministic fades applied during the music mix pass. They are
// recorded in the composition fingerprint so a future change invalidates
// existing final compositions.
export const MUSIC_FADE_IN_SECONDS = 1;
export const MUSIC_FADE_OUT_SECONDS = 2;

export function clampMusicLengthMs(value: unknown, fallback: number = DEFAULT_MUSIC_LENGTH_MS): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const rounded = Math.round(numeric);
  return Math.min(MAX_MUSIC_LENGTH_MS, Math.max(MIN_MUSIC_LENGTH_MS, rounded));
}

export function isMusicAsset(asset: Asset | undefined): boolean {
  return Boolean(asset && (asset.type === 'music' || asset.type === 'audio'));
}

export function resolveSelectedMusicAsset(project: Project): Asset | undefined {
  const assetId = project.music?.assetId;
  if (!assetId) {
    return undefined;
  }
  return project.assets.find((asset) => asset.id === assetId);
}

// Identity of the selected track: enough to detect replacement, regeneration
// or duration changes without hashing the audio bytes.
export function deriveMusicSignature(project: Project): string {
  const asset = resolveSelectedMusicAsset(project);
  if (!asset) {
    return '';
  }

  return [
    `asset:${asset.id}`,
    `duration:${asset.duration ?? ''}`,
    `gen:${asset.generation?.generationId ?? ''}`,
    `provider:${asset.generation?.provider ?? ''}`,
    `model:${asset.generation?.model ?? ''}`,
    `prompt:${asset.generation?.prompt ?? ''}`
  ].join('|');
}

export interface MusicFade {
  inSeconds: number;
  outSeconds: number;
  outStartSeconds: number;
}

// Deterministic, non-overlapping fades bounded by the output duration.
export function resolveMusicFade(durationSeconds: number): MusicFade {
  const total = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const inSeconds = Math.min(MUSIC_FADE_IN_SECONDS, total);
  const outSeconds = Math.min(MUSIC_FADE_OUT_SECONDS, Math.max(0, total - inSeconds));
  const outStartSeconds = Math.max(0, total - outSeconds);
  return { inSeconds, outSeconds, outStartSeconds };
}
