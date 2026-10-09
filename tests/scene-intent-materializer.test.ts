import { describe, expect, it } from 'vitest';

import { materializeSceneIntents, SceneIntentMaterializationError } from '@/lib/explainer/scene-intent-materializer';
import { normalizeProject } from '@/lib/projects/normalize-project';
import type { Project } from '@/lib/types/render';

function buildProject(): Project {
  const now = new Date().toISOString();
  return normalizeProject({
    id: 'materializer-project',
    title: 'Materializer Project',
    description: 'desc',
    durationTarget: 50,
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
        targetDurationSeconds: 50,
        notes: ''
      },
      story: {
        title: 'Materializer Project',
        hook: '',
        script: 'Script',
        beats: [
          { id: 'beat-1', order: 1, label: 'Hook', text: 'Beat 1 text' },
          { id: 'beat-2', order: 2, label: 'Explain', text: 'Beat 2 text' }
        ],
        cta: '',
        notes: '',
        versions: []
      },
      sceneIntents: [
        {
          id: 'intent-1',
          order: 1,
          beatIds: ['beat-1'],
          label: 'Intent 1',
          narrativeRole: 'hook',
          visualIntent: 'Show a close-up of dry skin',
          narrationDraft: 'Narration draft 1',
          timing: { durationSeconds: 6 },
          notes: 'Intent note 1',
          status: 'approved'
        },
        {
          id: 'intent-2',
          order: 2,
          beatIds: ['beat-2'],
          label: 'Intent 2',
          narrativeRole: 'explanation',
          visualIntent: 'Illustrate hydration importance',
          narrationDraft: 'Narration draft 2',
          timing: { durationSeconds: 7 },
          notes: 'Intent note 2',
          status: 'draft'
        }
      ]
    },
    scenes: [
      {
        id: 'existing-scene',
        order: 1,
        duration: 5,
        type: 'blank',
        narration: { text: 'Existing scene stays' },
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

describe('materializeSceneIntents', () => {
  it('materializes approved intents into new scenes without overwriting existing scenes', () => {
    const result = materializeSceneIntents(buildProject());

    expect(result.materialized).toHaveLength(1);
    expect(result.project.scenes).toHaveLength(2);
    expect(result.project.scenes[0].id).toBe('existing-scene');

    const scene = result.project.scenes[1];
    expect(scene.narration?.text).toBe('Narration draft 1');
    expect(scene.source?.sceneIntentId).toBe('intent-1');
    expect(scene.source?.beatIds).toEqual(['beat-1']);
    expect(scene.notes).toContain('Visual intent: Show a close-up of dry skin');
    expect(result.project.explainer?.sceneIntents[0].materializedSceneId).toBe(scene.id);
  });

  it('is idempotent for already materialized intents', () => {
    const first = materializeSceneIntents(buildProject());
    const second = materializeSceneIntents(first.project);

    expect(second.materialized).toHaveLength(0);
    expect(second.skipped).toHaveLength(1);
    expect(second.project.scenes).toHaveLength(2);
  });

  it('rejects explicit materialization of non-approved intents', () => {
    expect(() => materializeSceneIntents(buildProject(), ['intent-2'])).toThrowError(SceneIntentMaterializationError);
  });

  it('keeps beat to intent to scene traceability stable', () => {
    const result = materializeSceneIntents(buildProject(), ['intent-1']);
    const sceneId = result.materialized[0].sceneId;
    const scene = result.project.scenes.find((entry) => entry.id === sceneId);

    expect(scene?.source?.sceneIntentId).toBe('intent-1');
    expect(scene?.source?.beatIds).toEqual(['beat-1']);
    expect(result.project.explainer?.sceneIntents.find((intent) => intent.id === 'intent-1')?.materializedSceneId).toBe(sceneId);
  });
});
