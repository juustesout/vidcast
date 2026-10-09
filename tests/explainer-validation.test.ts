import { describe, expect, it } from 'vitest';

import type { Project } from '@/lib/types/render';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { validateProject } from '@/lib/validation/project-validation';

function baseProject(): Project {
  const now = new Date().toISOString();
  return normalizeProject({
    id: 'validation-project',
    title: 'Validation Project',
    description: 'desc',
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
        narration: { text: 'production narration' },
        visual: { kind: 'blank' },
        render: {
          motion: { preset: 'none' },
          transition: { type: 'fade' }
        },
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
      audio: {
        narrationVolume: 1,
        musicVolume: 0.35,
        effectsVolume: 0.2
      },
      subtitlesEnabled: true
    }
  });
}

describe('explainer validation', () => {
  it('accepts valid brief/story/beats payload', () => {
    const project = baseProject();
    project.explainer!.brief.topic = 'Hot water skin redness';
    project.explainer!.brief.goal = 'Explain mechanism';
    project.explainer!.brief.audience = 'General audience';
    project.explainer!.brief.tone = 'Educational';
    project.explainer!.story.script = 'Opening. Explanation. CTA.';
    project.explainer!.story.beats = [
      { id: 'beat-1', order: 1, label: 'Hook', text: 'Why does skin turn red?' },
      { id: 'beat-2', order: 2, label: 'Mechanism', text: 'Heat dilates vessels.' }
    ];

    const result = validateProject(project);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid beat ordering and duplicate ids', () => {
    const project = baseProject();
    project.explainer!.story.beats = [
      { id: 'beat-1', order: 1, text: 'a' },
      { id: 'beat-1', order: 1, text: 'b' }
    ];

    const result = validateProject(project);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'explainer.story.beat.id.duplicate')).toBe(true);
    expect(result.errors.some((error) => error.code === 'explainer.story.beat.order.duplicate')).toBe(true);
  });

  it('rejects invalid brief duration', () => {
    const project = baseProject();
    project.explainer!.brief.targetDurationSeconds = 0;

    const result = validateProject(project);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'explainer.brief.targetDuration.invalid')).toBe(true);
  });

  it('rejects scene intents that reference missing beats', () => {
    const project = baseProject();
    project.explainer!.story.beats = [{ id: 'beat-1', order: 1, text: 'Beat 1' }];
    project.explainer!.sceneIntents = [{
      id: 'intent-1',
      order: 1,
      beatIds: ['missing-beat'],
      label: 'Intent 1',
      narrativeRole: 'explanation',
      visualIntent: 'Visual',
      narrationDraft: 'Narration',
      timing: { durationSeconds: 5 },
      notes: '',
      status: 'draft'
    }];

    const result = validateProject(project);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === 'explainer.sceneIntent.beatIds.missing')).toBe(true);
  });
});
