import { describe, expect, it, vi } from 'vitest';

import {
  describeMusicError,
  formatMusicSeconds,
  listMusicCandidateAssets,
  resolveSelectedMusicAsset,
  validateMusicForm
} from '@/lib/music/music-form';
import { createSingleFlight } from '@/lib/utils/single-flight';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';

function createAsset(id: string, type: Asset['type']): Asset {
  const now = new Date().toISOString();
  return {
    id,
    type,
    status: 'available',
    provenance: 'generated',
    filename: `${id}.mp3`,
    localPath: `assets/${id}.mp3`,
    mimeType: 'audio/mpeg',
    duration: 30,
    filesize: 100,
    metadata: {},
    createdAt: now,
    updatedAt: now
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-1',
    title: 'Music Form Test',
    description: 'desc',
    durationTarget: 30,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
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

describe('validateMusicForm', () => {
  it('requires a non-empty prompt', () => {
    const result = validateMusicForm({ prompt: '   ' });
    expect(result.ok).toBe(false);
    expect(result.errors.prompt).toBeDefined();
    expect(result.payload).toBeUndefined();
  });

  it('builds a payload with the default duration and instrumental=true', () => {
    const result = validateMusicForm({ prompt: '  calm ambient  ' });
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({ prompt: 'calm ambient', musicLengthMs: 60000, instrumental: true });
  });

  it('converts a custom duration in seconds to milliseconds', () => {
    const result = validateMusicForm({ prompt: 'calm', durationSeconds: '15', instrumental: false });
    expect(result.payload).toEqual({ prompt: 'calm', musicLengthMs: 15000, instrumental: false });
  });

  it('rejects durations outside the supported 3-600 second range', () => {
    expect(validateMusicForm({ prompt: 'calm', durationSeconds: 2 }).errors.duration).toContain('at least 3');
    expect(validateMusicForm({ prompt: 'calm', durationSeconds: 601 }).errors.duration).toContain('at most 600');
  });

  it('rejects a non-numeric duration', () => {
    expect(validateMusicForm({ prompt: 'calm', durationSeconds: 'abc' }).errors.duration).toBeDefined();
  });

  it('falls back to a valid default duration when none is provided', () => {
    const result = validateMusicForm({ prompt: 'calm' }, { defaultDurationSeconds: 45 });
    expect(result.payload?.musicLengthMs).toBe(45000);
  });

  it('ignores an out-of-range default duration and uses the built-in default', () => {
    const result = validateMusicForm({ prompt: 'calm' }, { defaultDurationSeconds: 9000 });
    expect(result.payload?.musicLengthMs).toBe(60000);
  });
});

describe('music asset helpers', () => {
  it('resolves the selected music asset and lists music-capable assets', () => {
    const music = createAsset('asset-music', 'music');
    const audio = createAsset('asset-audio', 'audio');
    const image = createAsset('asset-image', 'image');
    const project = createProject({
      assets: [music, audio, image],
      music: { assetId: music.id, status: 'generated' }
    });

    expect(resolveSelectedMusicAsset(project)?.id).toBe('asset-music');
    expect(listMusicCandidateAssets(project).map((asset) => asset.id)).toEqual(['asset-music', 'asset-audio']);
  });

  it('returns undefined when no music is selected', () => {
    expect(resolveSelectedMusicAsset(createProject())).toBeUndefined();
  });
});

describe('describeMusicError', () => {
  it('maps known error codes to friendly messages', () => {
    expect(describeMusicError({ code: 'music.provider.notConfigured' })).toContain('not configured');
    expect(describeMusicError({ code: 'music.provider.rateLimited' })).toContain('rate limit');
    expect(describeMusicError({ code: 'music.provider.auth' })).toContain('authorize');
  });

  it('maps status codes when no code is present', () => {
    expect(describeMusicError({ status: 429 })).toContain('rate limit');
    expect(describeMusicError({ status: 401 })).toContain('authorize');
    expect(describeMusicError({ status: 409 })).toContain('conflicts');
  });

  it('prefers known codes and otherwise falls back to the server message or a safe default', () => {
    expect(describeMusicError({})).toContain('No automatic retry');
    expect(describeMusicError({ status: 500, message: 'Generation failed upstream.' })).toBe('Generation failed upstream.');
    expect(describeMusicError({ code: 'music.provider.failed', message: 'raw body' })).toContain('No automatic retry');
  });
});

describe('formatMusicSeconds', () => {
  it('formats valid durations and reports unknown ones', () => {
    expect(formatMusicSeconds(60)).toBe('60.00s');
    expect(formatMusicSeconds(undefined)).toBe('Unknown');
    expect(formatMusicSeconds(0)).toBe('Unknown');
  });
});

describe('createSingleFlight', () => {
  it('runs at most one operation at a time', async () => {
    const flight = createSingleFlight();
    const operation = vi.fn(async () => {
      await Promise.resolve();
      return 'done';
    });

    const first = flight.run(operation);
    const second = flight.run(operation);

    expect(flight.active).toBe(true);
    expect(await first).toBe('done');
    expect(await second).toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(flight.active).toBe(false);
  });

  it('allows a new run after the previous one settles', async () => {
    const flight = createSingleFlight();
    const operation = vi.fn(async () => 'ok');
    await flight.run(operation);
    await flight.run(operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
