import { describe, expect, it } from 'vitest';

import { approveSceneIntents, SceneIntentApprovalError } from '@/lib/explainer/scene-intent-approval';
import { materializeSceneIntents } from '@/lib/explainer/scene-intent-materializer';
import { normalizeProject } from '@/lib/projects/normalize-project';
import type { Project } from '@/lib/types/render';
import { validateProject } from '@/lib/validation/project-validation';

function buildProject(): Project {
  const now = new Date().toISOString();
  return normalizeProject({
    id: 'approval-project',
    title: 'Approval Project',
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
        title: 'Approval Project',
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
          visualIntent: 'Show a close-up',
          narrationDraft: 'Narration draft 1',
          timing: { durationSeconds: 6 },
          notes: '',
          status: 'draft'
        },
        {
          id: 'intent-2',
          order: 2,
          beatIds: ['beat-2'],
          label: 'Intent 2',
          narrativeRole: 'explanation',
          visualIntent: 'Illustrate hydration',
          narrationDraft: 'Narration draft 2',
          timing: { durationSeconds: 7 },
          notes: '',
          status: 'approved'
        }
      ]
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
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    }
  });
}

describe('approveSceneIntents', () => {
  it('approves every non-approved intent and reports already-approved ones as skipped', () => {
    const result = approveSceneIntents(buildProject());

    expect(result.approved).toEqual(['intent-1']);
    expect(result.skipped).toEqual(['intent-2']);
    expect(result.project.explainer?.sceneIntents.map((intent) => intent.status)).toEqual(['approved', 'approved']);
  });

  it('approves only the requested intent ids', () => {
    const result = approveSceneIntents(buildProject(), ['intent-1']);

    expect(result.approved).toEqual(['intent-1']);
    expect(result.skipped).toEqual([]);
    expect(result.project.explainer?.sceneIntents[1].status).toBe('approved');
  });

  it('is idempotent when re-approving', () => {
    const first = approveSceneIntents(buildProject(), ['intent-1']);
    const second = approveSceneIntents(first.project, ['intent-1']);

    expect(second.approved).toEqual([]);
    expect(second.skipped).toEqual(['intent-1']);
  });

  it('throws INTENT_NOT_FOUND for an unknown intent id without mutating later ids', () => {
    expect(() => approveSceneIntents(buildProject(), ['missing-intent'])).toThrowError(SceneIntentApprovalError);

    try {
      approveSceneIntents(buildProject(), ['intent-1', 'missing-intent']);
      throw new Error('expected approval to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SceneIntentApprovalError);
      expect((error as SceneIntentApprovalError).code).toBe('INTENT_NOT_FOUND');
    }
  });

  it('keeps the approved project valid and unblocks materialization', () => {
    const approved = approveSceneIntents(buildProject());

    const validation = validateProject(approved.project);
    expect(validation.valid).toBe(true);

    const materialized = materializeSceneIntents(approved.project);
    expect(materialized.materialized).toHaveLength(2);
    expect(materialized.project.scenes).toHaveLength(2);
  });

  it('never creates scenes on its own', () => {
    const result = approveSceneIntents(buildProject());
    expect(result.project.scenes).toHaveLength(0);
  });

  it('binds approval to a human actor and the current intent content', () => {
    const result = approveSceneIntents(buildProject(), ['intent-1'], { subject: 'user_owner' });
    const intent = result.project.explainer?.sceneIntents[0];

    expect(intent?.status).toBe('approved');
    expect(intent?.approval?.approvedBy).toBe('user_owner');
    expect(intent?.approval?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.project.explainer?.humanApproval?.approvedBy).toBe('user_owner');
  });
});
