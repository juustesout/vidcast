import { describe, expect, it } from 'vitest';

import { normalizeProject } from '@/lib/projects/normalize-project';
import { validateProject } from '@/lib/validation/project-validation';
import type { Project } from '@/lib/types/render';

function rawProject(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: 'project-music-normalize',
    title: 'Music Normalize',
    description: '',
    durationTarget: 30,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    scenes: [],
    assets: [],
    references: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1280,
      height: 720,
      background: { type: 'color', value: '#000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    ...overrides
  };
}

describe('project music normalization', () => {
  it('omits music when the payload has no music content', () => {
    const project = normalizeProject(rawProject({ music: { attempts: [] } }) as unknown as Project);
    expect(project.music).toBeUndefined();
  });

  it('defaults status to generated when an assetId is present', () => {
    const project = normalizeProject(rawProject({ music: { assetId: 'music-1' } }) as unknown as Project);
    expect(project.music?.assetId).toBe('music-1');
    expect(project.music?.status).toBe('generated');
  });

  it('normalizes generation attempt statuses and empty identifiers', () => {
    const project = normalizeProject(
      rawProject({
        music: {
          prompt: 'ambient',
          attempts: [
            { status: 'nonsense', provider: 'fake' },
            { id: 'attempt-2', status: 'generated', provider: 'fake' }
          ]
        }
      }) as unknown as Project
    );

    const attempts = project.music?.attempts ?? [];
    expect(attempts).toHaveLength(2);
    expect(attempts[0].id).toBe('music_attempt_1');
    expect(attempts[0].status).toBe('planned');
    expect(attempts[1].status).toBe('generated');
  });
});

describe('project music validation', () => {
  it('flags a missing selected music asset as an error', () => {
    const project = normalizeProject(rawProject({ music: { assetId: 'missing' } }) as unknown as Project);
    const result = validateProject(project);
    expect(result.errors.some((issue) => issue.code === 'project.music.asset.missing')).toBe(true);
  });

  it('flags a non-audio selected asset as an error', () => {
    const project = normalizeProject(
      rawProject({
        assets: [
          {
            id: 'asset-1',
            type: 'video',
            status: 'available',
            provenance: 'imported',
            filename: 'clip.mp4',
            localPath: 'assets/clip.mp4',
            mimeType: 'video/mp4',
            filesize: 10,
            metadata: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        music: { assetId: 'asset-1' }
      }) as unknown as Project
    );

    const result = validateProject(project);
    expect(result.errors.some((issue) => issue.code === 'project.music.asset.invalidType')).toBe(true);
  });

  it('accepts a valid music asset reference', () => {
    const project = normalizeProject(
      rawProject({
        assets: [
          {
            id: 'asset-1',
            type: 'music',
            status: 'available',
            provenance: 'generated',
            filename: 'music.wav',
            localPath: 'assets/music.wav',
            mimeType: 'audio/wav',
            duration: 60,
            filesize: 10,
            metadata: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        music: { assetId: 'asset-1' }
      }) as unknown as Project
    );

    const result = validateProject(project);
    expect(result.errors.some((issue) => issue.code.startsWith('project.music'))).toBe(false);
  });
});
