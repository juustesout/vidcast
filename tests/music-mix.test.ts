import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MUSIC_LENGTH_MS,
  MAX_MUSIC_LENGTH_MS,
  MIN_MUSIC_LENGTH_MS,
  clampMusicLengthMs,
  deriveMusicSignature,
  isMusicAsset,
  resolveMusicFade,
  resolveSelectedMusicAsset
} from '@/lib/render/music-mix';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';

function createAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-music-1',
    type: 'music',
    status: 'available',
    provenance: 'generated',
    filename: 'music-1.wav',
    localPath: 'assets/music-1.wav',
    mimeType: 'audio/wav',
    duration: 60,
    filesize: 100,
    metadata: {},
    generation: {
      generationId: 'attempt-1',
      provider: 'fake',
      model: 'music_v1',
      prompt: 'calm ambient',
      referenceIds: []
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    title: 'Music Mix Test',
    description: '',
    durationTarget: 30,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    narration: { text: '', segments: [] },
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1280,
      height: 720,
      background: { type: 'color', value: '#000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    assets: [],
    references: [],
    scenes: [],
    ...overrides
  };
}

describe('music mix helpers', () => {
  it('clamps music length to the provider-safe bounds', () => {
    expect(clampMusicLengthMs(100)).toBe(MIN_MUSIC_LENGTH_MS);
    expect(clampMusicLengthMs(999_999_999)).toBe(MAX_MUSIC_LENGTH_MS);
    expect(clampMusicLengthMs(undefined)).toBe(DEFAULT_MUSIC_LENGTH_MS);
    expect(clampMusicLengthMs(Number.NaN)).toBe(DEFAULT_MUSIC_LENGTH_MS);
  });

  it('treats music and audio assets as music-capable', () => {
    expect(isMusicAsset(createAsset({ type: 'music' }))).toBe(true);
    expect(isMusicAsset(createAsset({ type: 'audio' }))).toBe(true);
    expect(isMusicAsset(createAsset({ type: 'video' }))).toBe(false);
    expect(isMusicAsset(undefined)).toBe(false);
  });

  it('resolves only the explicitly selected asset', () => {
    const asset = createAsset();
    const project = createProject({ assets: [asset], music: { assetId: asset.id } });
    expect(resolveSelectedMusicAsset(project)?.id).toBe(asset.id);

    const cleared = createProject({ assets: [asset] });
    expect(resolveSelectedMusicAsset(cleared)).toBeUndefined();
  });

  it('returns an empty signature without a selected asset', () => {
    expect(deriveMusicSignature(createProject())).toBe('');
  });

  it('changes the signature when the selected track changes', () => {
    const asset = createAsset();
    const project = createProject({ assets: [asset], music: { assetId: asset.id } });
    const other = createAsset({
      id: 'asset-music-2',
      generation: {
        generationId: 'attempt-2',
        provider: 'fake',
        model: 'music_v2',
        prompt: 'other',
        referenceIds: []
      }
    });
    const replaced = createProject({ assets: [other], music: { assetId: other.id } });

    expect(deriveMusicSignature(project)).not.toBe(deriveMusicSignature(replaced));
    expect(deriveMusicSignature(project)).toContain(`asset:${asset.id}`);
  });

  it('produces deterministic, non-overlapping fades bounded by the duration', () => {
    expect(resolveMusicFade(60)).toEqual({ inSeconds: 1, outSeconds: 2, outStartSeconds: 58 });
    expect(resolveMusicFade(2)).toEqual({ inSeconds: 1, outSeconds: 1, outStartSeconds: 1 });
    expect(resolveMusicFade(0)).toEqual({ inSeconds: 0, outSeconds: 0, outStartSeconds: 0 });
  });
});
