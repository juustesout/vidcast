import { describe, expect, it } from 'vitest';

import { approveSceneIntents } from '@/lib/explainer/scene-intent-approval';
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

function generatedVideoProject(startFrameReferenceId?: string): Project {
  const project = baseProject();
  const now = new Date().toISOString();
  return normalizeProject({
    ...project,
    references: [
      {
        id: 'ref-1',
        name: 'ref-1',
        description: '',
        filePath: 'references/ref-1.png',
        tags: [],
        metadata: { mimeType: 'image/png' },
        createdAt: now,
        updatedAt: now
      }
    ],
    scenes: [
      {
        ...project.scenes[0],
        type: 'video',
        referenceIds: ['ref-1'],
        visual: {
          kind: 'generated_video',
          generation: {
            id: 'gen-1',
            kind: 'video',
            status: 'planned',
            provider: 'fal',
            model: 'minimax/h3-max-turbo/image-to-video',
            prompt: 'animate the start frame',
            referenceIds: ['ref-1'],
            aspectRatio: '16:9',
            startFrameReferenceId,
            createdAt: now
          }
        }
      }
    ]
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

  it('returns a validation failure instead of throwing for non-array collections', () => {
    const existing = baseProject();

    for (const incoming of [{ scenes: {} }, { assets: 'x' }, { references: 3 }, { compositions: 'nope' }]) {
      let result: ReturnType<typeof applyProjectUpdate> | undefined;
      expect(() => {
        result = applyProjectUpdate(existing, { ...existing, ...incoming });
      }).not.toThrow();
      expect(result?.validation.valid).toBe(false);
    }
  });

  it('returns a validation failure for a non-array narration attempts object', () => {
    const existing = baseProject();
    const scene = existing.scenes[0];

    const result = applyProjectUpdate(existing, {
      ...existing,
      scenes: [{ ...scene, narration: { text: 'scene text', attempts: {} } }]
    });

    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.some((error) => error.code === 'scene.narration.attempts.invalid')).toBe(true);
  });

  it('does not crash on a scene with a render object that omits motion and transition', () => {
    const existing = baseProject();
    const scene = existing.scenes[0];

    let result: ReturnType<typeof applyProjectUpdate> | undefined;
    expect(() => {
      result = applyProjectUpdate(existing, { ...existing, scenes: [{ ...scene, render: {} }] });
    }).not.toThrow();
    expect(result?.validation).toBeDefined();
    expect(result?.project.scenes[0].render.motion.preset).toBeDefined();
  });

  it('flags a non-object overlay via validation rather than throwing', () => {
    const existing = baseProject();
    const scene = existing.scenes[0];

    const result = applyProjectUpdate(existing, { ...existing, scenes: [{ ...scene, overlay: {} }] });

    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.some((error) => error.code === 'scene.overlay.invalid')).toBe(true);
  });

  it('applies a well-formed scene narration update', () => {
    const existing = baseProject();
    const scene = existing.scenes[0];

    const result = applyProjectUpdate(existing, {
      ...existing,
      scenes: [{ ...scene, narration: { text: 'Updated production narration' } }]
    });

    expect(result.validation.valid).toBe(true);
    expect(result.project.scenes[0].narration?.text).toBe('Updated production narration');
  });

  it('preserves image-to-video keyframe designations through normalization', () => {
    const project = generatedVideoProject('ref-1');
    const visual = project.scenes[0].visual;
    if (visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    expect(visual.generation.startFrameReferenceId).toBe('ref-1');
  });

  it('accepts an image-to-video keyframe that resolves to a reference', () => {
    const result = applyProjectUpdate(baseProject(), generatedVideoProject('ref-1'));
    expect(result.validation.valid).toBe(true);
  });

  it('flags an image-to-video keyframe that does not resolve to a reference', () => {
    const result = applyProjectUpdate(baseProject(), generatedVideoProject('ref-missing'));
    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.some((error) => error.code === 'scene.visual.generation.frameReference.missing')).toBe(true);
  });
});

describe('applyProjectUpdate ownership immutability', () => {
  it('ignores an incoming ownerId that tries to reassign the project', () => {
    const existing = { ...baseProject(), ownerId: 'user_owner' };
    const result = applyProjectUpdate(existing, { ...existing, ownerId: 'user_attacker', title: 'Renamed' });

    expect(result.validation.valid).toBe(true);
    expect(result.project.ownerId).toBe('user_owner');
    expect(result.project.title).toBe('Renamed');
  });

  it('does not let an update clear an existing owner', () => {
    const existing = { ...baseProject(), ownerId: 'user_owner' };
    const result = applyProjectUpdate(existing, { ...existing, ownerId: undefined });

    expect(result.project.ownerId).toBe('user_owner');
  });

  it('keeps an ownerless project ownerless even when a body supplies an owner', () => {
    const existing = baseProject();
    expect(existing.ownerId).toBeUndefined();

    const result = applyProjectUpdate(existing, { ...existing, ownerId: 'user_supplied' });

    expect(result.project.ownerId).toBeUndefined();
  });

  it('preserves ownership for a partial patch that only changes other fields', () => {
    const existing = { ...baseProject(), ownerId: 'user_owner' };
    const result = applyProjectUpdate(existing, { title: 'Only the title changes' });

    expect(result.project.ownerId).toBe('user_owner');
    expect(result.project.title).toBe('Only the title changes');
  });
});

describe('applyProjectUpdate approval immutability', () => {
  function projectWithDraftIntent(): Project {
    const existing = baseProject();
    return {
      ...existing,
      explainer: {
        ...existing.explainer!,
        story: {
          ...existing.explainer!.story,
          beats: [{ id: 'beat-1', order: 1, text: 'Beat' }]
        },
        sceneIntents: [
          {
            id: 'intent-1',
            order: 1,
            beatIds: ['beat-1'],
            narrativeRole: 'hook',
            visualIntent: 'Show it',
            narrationDraft: 'Say it',
            timing: { durationSeconds: 5 },
            status: 'draft'
          }
        ]
      }
    };
  }

  it('does not let a client forge scene-intent approved status or humanApproval', () => {
    const existing = projectWithDraftIntent();
    const result = applyProjectUpdate(existing, {
      ...existing,
      explainer: {
        ...existing.explainer,
        sceneIntents: [
          {
            ...existing.explainer!.sceneIntents[0],
            status: 'approved'
          }
        ],
        humanApproval: {
          approvedBy: 'service:api_token',
          approvedAt: '2026-01-01T00:00:00.000Z',
          contentHash: 'forged'
        }
      }
    });

    expect(result.validation.valid).toBe(true);
    expect(result.project.explainer?.sceneIntents[0].status).toBe('draft');
    expect(result.project.explainer?.humanApproval).toBeUndefined();
  });

  it('preserves a server-owned approval when content is unchanged', () => {
    const approved = approveSceneIntents(projectWithDraftIntent(), ['intent-1'], { subject: 'user_owner' }).project;
    const result = applyProjectUpdate(approved, { title: 'Retitled' });

    expect(result.project.title).toBe('Retitled');
    expect(result.project.explainer?.sceneIntents[0].status).toBe('approved');
    expect(result.project.explainer?.sceneIntents[0].approval?.approvedBy).toBe('user_owner');
    expect(result.project.explainer?.humanApproval?.approvedBy).toBe('user_owner');
  });

  it('invalidates a prior approval when intent content changes', () => {
    const approved = approveSceneIntents(projectWithDraftIntent(), ['intent-1'], { subject: 'user_owner' }).project;
    const result = applyProjectUpdate(approved, {
      explainer: {
        ...approved.explainer,
        sceneIntents: [
          {
            ...approved.explainer!.sceneIntents[0],
            visualIntent: 'Changed after approval',
            status: 'approved'
          }
        ]
      }
    });

    expect(result.project.explainer?.sceneIntents[0].status).toBe('draft');
    expect(result.project.explainer?.sceneIntents[0].approval).toBeUndefined();
    expect(result.project.explainer?.humanApproval).toBeUndefined();
  });
});
