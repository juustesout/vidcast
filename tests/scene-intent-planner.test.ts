import { describe, expect, it } from 'vitest';

import { planSceneIntentsFromBeats } from '@/lib/explainer/scene-intent-planner';
import { normalizeProject } from '@/lib/projects/normalize-project';
import type { Project } from '@/lib/types/render';

function buildProject(): Project {
  const now = new Date().toISOString();
  return normalizeProject({
    id: 'planner-project',
    title: 'Planner Project',
    description: 'desc',
    durationTarget: 40,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    explainer: {
      brief: {
        topic: 'Topic',
        goal: 'Goal',
        audience: 'Audience',
        tone: 'Tone',
        targetDurationSeconds: 40,
        notes: ''
      },
      story: {
        title: 'Planner Project',
        hook: '',
        script: 'Hook. Explanation. CTA.',
        beats: [
          { id: 'beat-1', order: 1, label: 'Hook', text: 'Opening beat text.' },
          { id: 'beat-2', order: 2, label: 'Explain', text: 'Explanation beat text.' }
        ],
        cta: '',
        notes: '',
        versions: []
      },
      sceneIntents: []
    },
    scenes: [],
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

describe('planSceneIntentsFromBeats', () => {
  it('creates one draft scene intent per beat', () => {
    const result = planSceneIntentsFromBeats(buildProject());

    expect(result.createdIntentIds).toHaveLength(2);
    expect(result.project.explainer?.sceneIntents).toHaveLength(2);
    expect(result.project.explainer?.sceneIntents[0].beatIds).toEqual(['beat-1']);
    expect(result.project.explainer?.sceneIntents[0].narrationDraft).toBe('Opening beat text.');
    expect(result.project.explainer?.sceneIntents[0].status).toBe('draft');
  });

  it('does not duplicate intents for beats that are already linked', () => {
    const project = buildProject();
    project.explainer!.sceneIntents = [
      {
        id: 'intent-1',
        order: 1,
        beatIds: ['beat-1'],
        label: 'Intent 1',
        narrativeRole: 'hook',
        visualIntent: 'close-up',
        narrationDraft: 'Opening beat text.',
        timing: { durationSeconds: 6 },
        notes: '',
        status: 'draft'
      }
    ];

    const result = planSceneIntentsFromBeats(project);
    expect(result.createdIntentIds).toHaveLength(1);
    expect(result.project.explainer?.sceneIntents).toHaveLength(2);
    expect(result.project.explainer?.sceneIntents.some((intent) => intent.beatIds.includes('beat-2'))).toBe(true);
  });

  it('preserves stable ordering after adding multiple intents', () => {
    const result = planSceneIntentsFromBeats(buildProject());
    expect(result.project.explainer?.sceneIntents.map((intent) => intent.order)).toEqual([1, 2]);
  });
});
