import { describe, expect, it } from 'vitest';

import { applyProjectUpdate } from '@/lib/projects/project-update';
import { normalizeProject } from '@/lib/projects/normalize-project';
import type { Project } from '@/lib/types/render';

function baseProject(): Project {
  const now = new Date().toISOString();
  return normalizeProject({
    id: 'project-update',
    title: 'Project Update',
    description: 'desc',
    durationTarget: 60,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: {
      text: '',
      segments: []
    },
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 5,
        type: 'image',
        narration: { text: 'scene narration stays production-side' },
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

describe('applyProjectUpdate', () => {
  it('normalizes explainer payload and keeps core invariants', () => {
    const existing = baseProject();
    const incoming = {
      ...existing,
      id: 'other-id',
      createdAt: '1990-01-01T00:00:00.000Z',
      explainer: {
        brief: {
          topic: 'Topic',
          goal: 'Goal',
          audience: 'Audience',
          tone: 'Tone',
          targetDurationSeconds: 45
        },
        story: {
          title: 'Story title',
          hook: 'Hook',
          script: 'Full script',
          beats: [{ id: 'b1', order: 10, text: 'Beat text' }],
          cta: 'CTA',
          notes: 'Notes',
          versions: [{ id: 'v1', script: 'Version script', createdAt: new Date().toISOString(), source: 'manual' }]
        },
        sceneIntents: []
      }
    };

    const result = applyProjectUpdate(existing, incoming);
    expect(result.validation.valid).toBe(true);
    expect(result.project.id).toBe(existing.id);
    expect(result.project.createdAt).toBe(existing.createdAt);
    expect(result.project.explainer?.story.beats[0].order).toBe(1);
  });

  it('rejects invalid explainer payload through validation result', () => {
    const existing = baseProject();
    const incoming = {
      ...existing,
      explainer: {
        ...existing.explainer,
        brief: {
          ...existing.explainer!.brief,
          targetDurationSeconds: 0
        }
      }
    };

    const result = applyProjectUpdate(existing, incoming);
    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.some((error) => error.code === 'explainer.brief.targetDuration.invalid')).toBe(true);
  });

  it('keeps story/beats separate from scene narration production copy', () => {
    const existing = baseProject();
    const incoming = {
      ...existing,
      explainer: {
        ...existing.explainer,
        story: {
          ...existing.explainer!.story,
          script: 'Changed script source text',
          beats: [{ id: 'beat-1', order: 1, text: 'Changed beat text' }]
        }
      }
    };

    const result = applyProjectUpdate(existing, incoming);
    expect(result.project.scenes[0].narration?.text).toBe('scene narration stays production-side');
  });

  it('normalizes audio mix volumes into the allowed range', () => {
    const existing = baseProject();
    const incoming = {
      ...existing,
      renderSettings: {
        ...existing.renderSettings,
        audio: { narrationVolume: -2, musicVolume: 10, effectsVolume: Number.NaN }
      }
    };

    const result = applyProjectUpdate(existing, incoming);
    expect(result.project.renderSettings.audio).toEqual({ narrationVolume: 0, musicVolume: 4, effectsVolume: 0.2 });
  });
});
