import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildSceneFadeFilters, resolveSceneFadeSeconds, SCENE_FADE_MAX_SECONDS, SCENE_FADE_MIN_SECONDS } from '@/lib/render/render-source';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { validateProject } from '@/lib/validation/project-validation';
import type { Project } from '@/lib/types/render';
import type { TransitionSpec } from '@/lib/types/scene';

function baseProject(transition: TransitionSpec): Project {
  const now = '2026-10-27T00:00:00.000Z';
  return normalizeProject({
    id: 'transition-project',
    title: 'Transition Project',
    description: '',
    durationTarget: 30,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 5,
        type: 'image',
        narration: { text: '' },
        visual: { kind: 'blank' },
        render: { motion: { preset: 'none' }, transition },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ],
    assets: [],
    references: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    }
  });
}

describe('scene fade filters', () => {
  it('does not fade scenes with a none transition', () => {
    expect(buildSceneFadeFilters(5, { type: 'none' })).toEqual([]);
  });

  it('does not fade scenes with a crossfade transition', () => {
    expect(buildSceneFadeFilters(5, { type: 'crossfade', duration: 0.3 })).toEqual([]);
  });

  it('does not fade when the transition is missing', () => {
    expect(buildSceneFadeFilters(5)).toEqual([]);
  });

  it('fades in at 0 and out at the tail of a fade scene without changing duration', () => {
    const filters = buildSceneFadeFilters(5, { type: 'fade', duration: 0.25 });
    expect(filters).toEqual(['fade=t=in:st=0:d=0.25', 'fade=t=out:st=4.75:d=0.25']);
  });

  it('falls back to the heuristic when the authored duration is invalid', () => {
    expect(buildSceneFadeFilters(5, { type: 'fade', duration: 0 })).toEqual(buildSceneFadeFilters(5, { type: 'fade' }));
    expect(buildSceneFadeFilters(5, { type: 'fade', duration: -1 })).toEqual(buildSceneFadeFilters(5, { type: 'fade' }));
    expect(buildSceneFadeFilters(5, { type: 'fade', duration: Number.NaN })).toEqual(buildSceneFadeFilters(5, { type: 'fade' }));
  });

  it('clamps the authored duration into the safe bounds', () => {
    expect(resolveSceneFadeSeconds(10, 0.05)).toBe(0.12);
    expect(resolveSceneFadeSeconds(10, 0.2)).toBe(0.2);
    expect(resolveSceneFadeSeconds(10, 1)).toBe(0.35);
    expect(SCENE_FADE_MIN_SECONDS).toBe(0.12);
    expect(SCENE_FADE_MAX_SECONDS).toBe(0.35);
  });

  it('never lets a fade exceed half of the scene duration', () => {
    expect(resolveSceneFadeSeconds(0.3, 0.2)).toBe(0.15);
    expect(buildSceneFadeFilters(0.2, { type: 'fade', duration: 0.1 })).toEqual([]);
  });

  it('skips fades for non-positive durations', () => {
    expect(buildSceneFadeFilters(0, { type: 'fade' })).toEqual([]);
    expect(buildSceneFadeFilters(-2, { type: 'fade' })).toEqual([]);
  });
});

describe('scene transition validation', () => {
  it('keeps crossfade valid but reports it as unsupported', () => {
    const result = validateProject(baseProject({ type: 'crossfade', duration: 0.5 }));
    expect(result.valid).toBe(true);
    const issue = result.warnings.find((warning) => warning.code === 'scene.transition.crossfade.unsupported');
    expect(issue?.severity).toBe('warning');
  });

  it('accepts fade scenes without warnings', () => {
    const result = validateProject(baseProject({ type: 'fade', duration: 0.3 }));
    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.code.startsWith('scene.transition'))).toBe(false);
  });

  it('rejects non-positive transition durations', () => {
    const result = validateProject(baseProject({ type: 'fade', duration: 0 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'scene.transition.duration.invalid')).toBe(true);
  });
});

describe('scene transition renderer wiring', () => {
  it('passes scene.transition into every scene fade call site', async () => {
    const renderer = await readFile(path.join(process.cwd(), 'lib/render/renderer.ts'), 'utf8');
    const calls = renderer.match(/buildSceneFadeFilters\(scene\.duration, scene\.transition\)/g) ?? [];
    expect(calls).toHaveLength(4);

    const compositor = await readFile(path.join(process.cwd(), 'lib/render/scene-composition-compositor.ts'), 'utf8');
    expect(compositor).toContain('buildSceneFadeFilters(scene.duration, scene.transition)');
  });
});
