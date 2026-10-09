import { describe, expect, it } from 'vitest';

import { normalizeProject } from '@/lib/projects/normalize-project';
import type { Project } from '@/lib/types/render';

function buildLegacyProject(): Project {
  const now = new Date().toISOString();
  return {
    id: 'legacy-project',
    title: 'Legacy Explainer',
    description: 'Legacy project without explainer',
    durationTarget: 42,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: {
      text: 'Legacy master script text.',
      segments: [
        {
          id: 'segment-1',
          order: 1,
          sceneId: 'scene-1',
          text: 'Legacy beat one.',
          estimatedDurationSeconds: 6
        },
        {
          id: 'segment-2',
          order: 2,
          sceneId: 'scene-2',
          text: 'Legacy beat two.',
          estimatedDurationSeconds: 7
        }
      ]
    },
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 6,
        type: 'image',
        narration: { text: 'Existing production narration stays untouched.' },
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
  };
}

describe('explainer normalization', () => {
  it('adds explainer defaults for projects without explainer data', () => {
    const normalized = normalizeProject(buildLegacyProject());

    expect(normalized.explainer).toBeDefined();
    expect(normalized.explainer?.brief.targetDurationSeconds).toBe(42);
    expect(normalized.explainer?.story.title).toBe('Legacy Explainer');
    expect(normalized.explainer?.story.script).toBe('Legacy master script text.');
    expect(normalized.explainer?.sceneIntents).toEqual([]);
  });

  it('migrates legacy narration segments into beats and keeps scene narration separate', () => {
    const normalized = normalizeProject(buildLegacyProject());

    expect(normalized.explainer?.story.beats).toHaveLength(2);
    expect(normalized.explainer?.story.beats[0].text).toBe('Legacy beat one.');
    expect(normalized.scenes[0].narration?.text).toBe('Existing production narration stays untouched.');
  });

  it('preserves script versions during normalize roundtrip', () => {
    const project = normalizeProject(buildLegacyProject());
    project.explainer!.story.versions = [
      {
        id: 'version-1',
        script: 'Script snapshot one.',
        createdAt: new Date().toISOString(),
        source: 'manual'
      }
    ];

    const reloaded = normalizeProject(JSON.parse(JSON.stringify(project)) as Project);
    expect(reloaded.explainer?.story.versions).toHaveLength(1);
    expect(reloaded.explainer?.story.versions[0].id).toBe('version-1');
    expect(reloaded.explainer?.story.versions[0].script).toBe('Script snapshot one.');
  });
});
