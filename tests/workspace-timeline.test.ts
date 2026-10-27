import { describe, expect, it } from 'vitest';

import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { resolveNeighborSceneId } from '@/lib/workspace/scene-navigation';
import { deriveSaveStatus, projectSaveSignature } from '@/lib/workspace/save-status';
import { buildWorkspaceTimeline, resolveTimeToScene } from '@/lib/workspace/timeline';
import type { Project } from '@/lib/types/render';

function plan(scenes: Array<{ sceneId: string; order: number; duration: number }>) {
  return { scenes };
}

function project(overrides: Partial<Project> = {}): Project {
  const now = '2026-10-26T00:00:00.000Z';
  return {
    id: 'project-save',
    title: 'Saved',
    description: 'desc',
    durationTarget: 12,
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
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: false
    },
    ...overrides
  };
}

describe('buildWorkspaceTimeline', () => {
  it('uses render-plan durations in scene order and sums the total', () => {
    const timeline = buildWorkspaceTimeline(
      plan([
        { sceneId: 'news', order: 2, duration: 6.25 },
        { sceneId: 'intro', order: 1, duration: 3 },
        { sceneId: 'outro', order: 3, duration: 3 }
      ])
    );

    expect(timeline.totalDuration).toBeCloseTo(12.25, 5);
    expect(timeline.scenes.map((scene) => scene.sceneId)).toEqual(['intro', 'news', 'outro']);
    expect(timeline.scenes[0]).toMatchObject({ start: 0, end: 3, duration: 3 });
    expect(timeline.scenes[1].start).toBeCloseTo(3, 5);
    expect(timeline.scenes[1].end).toBeCloseTo(9.25, 5);
    expect(timeline.scenes[2].start).toBeCloseTo(9.25, 5);
    expect(timeline.scenes[2].end).toBeCloseTo(12.25, 5);
  });

  it('does not use authored duration when the plan already carries the effective duration', () => {
    const timeline = buildWorkspaceTimeline(plan([{ sceneId: 'scene-1', order: 1, duration: 5.25 }]));
    expect(timeline.scenes[0].duration).toBe(5.25);
    expect(timeline.totalDuration).toBe(5.25);
  });

  it('follows narration-extended render-plan duration instead of authored scene.duration', () => {
    const now = '2026-10-26T00:00:00.000Z';
    const projectWithNarration: Project = {
      ...project(),
      assets: [
        {
          id: 'audio-1',
          type: 'audio',
          status: 'available',
          provenance: 'generated',
          filename: 'voice.mp3',
          localPath: 'assets/voice.mp3',
          mimeType: 'audio/mpeg',
          duration: 5,
          filesize: 50,
          metadata: {},
          createdAt: now,
          updatedAt: now
        }
      ],
      scenes: [
        {
          id: 'scene-1',
          order: 1,
          duration: 2,
          type: 'blank',
          narration: { text: 'hello world', audioAssetId: 'audio-1', duration: 5 },
          visual: { kind: 'blank' },
          render: { motion: { preset: 'none' }, transition: { type: 'none' } },
          overlay: { type: 'none' },
          referenceIds: [],
          notes: ''
        }
      ]
    };
    const renderPlan = resolveRenderPlan(projectWithNarration);
    expect(renderPlan.scenes[0].duration).toBeCloseTo(5.25, 5);
    expect(projectWithNarration.scenes[0].duration).toBe(2);

    const timeline = buildWorkspaceTimeline(renderPlan);
    expect(timeline.scenes[0].duration).toBeCloseTo(5.25, 5);
    expect(timeline.totalDuration).toBeCloseTo(5.25, 5);
  });

  it('returns an empty timeline for a project with no scenes', () => {
    expect(buildWorkspaceTimeline(plan([]))).toEqual({ totalDuration: 0, scenes: [] });
  });

  it('treats non-finite durations as zero-length slots', () => {
    const timeline = buildWorkspaceTimeline(
      plan([
        { sceneId: 'a', order: 1, duration: Number.NaN },
        { sceneId: 'b', order: 2, duration: 2 }
      ])
    );
    expect(timeline.scenes[0]).toMatchObject({ start: 0, end: 0, duration: 0 });
    expect(timeline.scenes[1]).toMatchObject({ start: 0, end: 2, duration: 2 });
    expect(timeline.totalDuration).toBe(2);
  });
});

describe('resolveTimeToScene', () => {
  const timeline = buildWorkspaceTimeline(
    plan([
      { sceneId: 'intro', order: 1, duration: 3 },
      { sceneId: 'news', order: 2, duration: 6 },
      { sceneId: 'outro', order: 3, duration: 3 }
    ])
  );

  it('maps the start of the program to the first scene', () => {
    expect(resolveTimeToScene(timeline, 0)).toEqual({ sceneId: 'intro', localTime: 0 });
  });

  it('keeps times just before a boundary on the earlier scene', () => {
    expect(resolveTimeToScene(timeline, 2.999)?.sceneId).toBe('intro');
    expect(resolveTimeToScene(timeline, 3)).toEqual({ sceneId: 'news', localTime: 0 });
  });

  it('maps the exact total duration to the last scene', () => {
    expect(resolveTimeToScene(timeline, 12)).toEqual({ sceneId: 'outro', localTime: 3 });
  });

  it('clamps times outside the range', () => {
    expect(resolveTimeToScene(timeline, -4)).toEqual({ sceneId: 'intro', localTime: 0 });
    expect(resolveTimeToScene(timeline, 99)).toEqual({ sceneId: 'outro', localTime: 3 });
    expect(resolveTimeToScene(timeline, Number.NaN)).toEqual({ sceneId: 'intro', localTime: 0 });
  });

  it('returns null for an empty timeline', () => {
    expect(resolveTimeToScene({ totalDuration: 0, scenes: [] }, 0)).toBeNull();
  });
});

describe('resolveNeighborSceneId', () => {
  const ids = ['intro', 'news', 'outro'];

  it('moves to the previous and next scene in order', () => {
    expect(resolveNeighborSceneId(ids, 'news', -1)).toBe('intro');
    expect(resolveNeighborSceneId(ids, 'news', 1)).toBe('outro');
  });

  it('does not wrap at the ends', () => {
    expect(resolveNeighborSceneId(ids, 'intro', -1)).toBeUndefined();
    expect(resolveNeighborSceneId(ids, 'outro', 1)).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(resolveNeighborSceneId([], 'intro', 1)).toBeUndefined();
  });
});

describe('deriveSaveStatus', () => {
  it('is saved when draft matches the last successful snapshot ignoring updatedAt', () => {
    const saved = project({ title: 'A', updatedAt: '2026-10-26T00:00:00.000Z' });
    const draft = project({ title: 'A', updatedAt: '2026-10-26T01:00:00.000Z' });
    expect(deriveSaveStatus(draft, saved)).toBe('saved');
    expect(projectSaveSignature(draft)).toBe(projectSaveSignature(saved));
  });

  it('is unsaved after a content change', () => {
    const saved = project({ title: 'A' });
    const draft = project({ title: 'B' });
    expect(deriveSaveStatus(draft, saved)).toBe('unsaved');
  });

  it('stays unsaved when a save fails and the snapshot is unchanged', () => {
    const saved = project({ title: 'A' });
    const draft = project({ title: 'B' });
    expect(deriveSaveStatus(draft, saved)).toBe('unsaved');
  });
});
