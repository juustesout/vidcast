import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashProductionContent, isValidHumanApproval, stampHumanApproval } from '@/lib/explainer/human-approval';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { getReferenceUsage } from '@/lib/projects/usage';
import { projectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';
import type { ReferenceImage } from '@/lib/types/reference';
import type { Scene } from '@/lib/types/scene';

const now = '2026-10-27T00:00:00.000Z';

let originalCwd: string;
let tempRoot: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'p406-reference-'));
  process.chdir(tempRoot);
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

function reference(id: string): ReferenceImage {
  return {
    id,
    name: id,
    description: '',
    filePath: `references/${id}.png`,
    tags: [],
    metadata: { mimeType: 'image/png' },
    createdAt: now,
    updatedAt: now
  };
}

function generatedVideoScene(overrides: {
  id?: string;
  order?: number;
  sceneReferenceIds?: string[];
  generationReferenceIds?: string[];
  startFrameReferenceId?: string;
  endFrameReferenceId?: string;
  negativePrompt?: string;
  prompt?: string;
} = {}): Scene {
  return {
    id: overrides.id ?? 'scene-video',
    order: overrides.order ?? 1,
    duration: 5,
    type: 'video',
    visual: {
      kind: 'generated_video',
      generation: {
        id: 'gen-video',
        kind: 'video',
        status: 'planned',
        provider: 'fal',
        model: 'minimax/h3-max-turbo/image-to-video',
        prompt: overrides.prompt ?? 'animate the start frame',
        negativePrompt: overrides.negativePrompt,
        referenceIds: overrides.generationReferenceIds ?? [],
        aspectRatio: '16:9',
        startFrameReferenceId: overrides.startFrameReferenceId,
        endFrameReferenceId: overrides.endFrameReferenceId,
        createdAt: now
      }
    },
    render: { motion: { preset: 'none' }, transition: { type: 'fade' } },
    overlay: { type: 'none' },
    referenceIds: overrides.sceneReferenceIds ?? [],
    notes: ''
  };
}

function baseProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p406-project',
    title: 'P406',
    description: '',
    durationTarget: 15,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    assets: [],
    references: [],
    compositions: [],
    scenes: [generatedVideoScene()],
    ...overrides
  };
}

function withApproval(project: Project): Project {
  const next = structuredClone(project) as Project;
  next.explainer = {
    brief: {
      topic: '',
      goal: '',
      audience: '',
      tone: '',
      targetDurationSeconds: project.durationTarget,
      notes: ''
    },
    story: { title: project.title, hook: '', script: '', beats: [], cta: '', notes: '', versions: [] },
    sceneIntents: [],
    humanApproval: stampHumanApproval(next, { subject: 'user_test' })
  };
  return next;
}

describe('P406 reference roundtrip', () => {
  it('keeps scene references and generation references as separate fields', () => {
    const normalized = normalizeProject(baseProject({
      references: [reference('scene-ref'), reference('gen-ref')],
      scenes: [generatedVideoScene({ sceneReferenceIds: ['scene-ref'], generationReferenceIds: ['gen-ref'] })]
    }));

    const scene = normalized.scenes[0];
    expect(scene.referenceIds).toEqual(['scene-ref']);
    if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    expect(scene.visual.generation.referenceIds).toEqual(['gen-ref']);
  });

  it('keeps keyframes and generation-only references that the scene list does not contain', () => {
    const normalized = normalizeProject(baseProject({
      references: [reference('start'), reference('end')],
      scenes: [generatedVideoScene({
        sceneReferenceIds: [],
        generationReferenceIds: ['start', 'end'],
        startFrameReferenceId: 'start',
        endFrameReferenceId: 'end'
      })]
    }));

    const scene = normalized.scenes[0];
    if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    expect(scene.visual.generation.referenceIds).toEqual(['start', 'end']);
    expect(scene.visual.generation.startFrameReferenceId).toBe('start');
    expect(scene.visual.generation.endFrameReferenceId).toBe('end');
  });

  it('falls back to scene references for legacy projects without a generation snapshot', () => {
    const legacy = baseProject({
      references: [reference('legacy-ref')],
      scenes: [{
        ...generatedVideoScene(),
        visual: {
          kind: 'generated_video',
          generation: {
            id: 'gen-video',
            kind: 'video',
            status: 'planned',
            prompt: 'legacy',
            aspectRatio: '16:9',
            createdAt: now
          }
        },
        referenceIds: ['legacy-ref']
      }]
    });

    const scene = normalizeProject(legacy).scenes[0];
    if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    expect(scene.visual.generation.referenceIds).toEqual(['legacy-ref']);
  });

  it('survives a store write/read cycle without losing generation references or keyframes', async () => {
    const project = baseProject({
      references: [reference('start'), reference('end')],
      scenes: [generatedVideoScene({
        sceneReferenceIds: ['start', 'end'],
        generationReferenceIds: ['start', 'end'],
        startFrameReferenceId: 'start',
        endFrameReferenceId: 'end'
      })]
    });
    await projectStore.updateProject(project);

    const reloaded = await projectStore.getProject(project.id);
    const scene = reloaded?.scenes[0];
    if (scene?.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    expect(scene.referenceIds).toEqual(['start', 'end']);
    expect(scene.visual.generation.referenceIds).toEqual(['start', 'end']);
    expect(scene.visual.generation.startFrameReferenceId).toBe('start');
    expect(scene.visual.generation.endFrameReferenceId).toBe('end');
  });
});

describe('P406 reference usage', () => {
  it('reports scenes that only use the reference through the generation snapshot', () => {
    const project = normalizeProject(baseProject({
      references: [reference('gen-only')],
      scenes: [generatedVideoScene({ sceneReferenceIds: [], generationReferenceIds: ['gen-only'] })]
    }));

    expect(getReferenceUsage(project, 'gen-only')).toEqual(['scene-video']);
  });

  it('reports scenes that only use the reference as a keyframe', () => {
    const project = normalizeProject(baseProject({
      references: [reference('frame')],
      scenes: [generatedVideoScene({ generationReferenceIds: ['frame'], startFrameReferenceId: 'frame' })]
    }));

    expect(getReferenceUsage(project, 'frame')).toEqual(['scene-video']);
  });

  it('reports every consumer and no usage for an unused reference', () => {
    const project = normalizeProject(baseProject({
      references: [reference('shared'), reference('unused')],
      scenes: [
        generatedVideoScene({ sceneReferenceIds: ['shared'] }),
        generatedVideoScene({ id: 'scene-two', order: 2, sceneReferenceIds: ['shared'] })
      ]
    }));

    expect(getReferenceUsage(project, 'shared')).toEqual(['scene-video', 'scene-two']);
    expect(getReferenceUsage(project, 'unused')).toEqual([]);
  });
});

describe('P406 reference deletion protection', () => {
  it('blocks deleting a reference only used by a generation snapshot', async () => {
    const project = await projectStore.createProject({ title: 'P406 delete' });
    await projectStore.mutateProject(project.id, (current) => ({
      ...current,
      references: [reference('gen-only')],
      scenes: [generatedVideoScene({ generationReferenceIds: ['gen-only'] })]
    }));

    const result = await projectStore.deleteReference(project.id, 'gen-only');
    expect(result.usageSceneIds).toEqual(['scene-video']);

    const reloaded = await projectStore.getProject(project.id);
    expect(reloaded?.references.map((entry) => entry.id)).toContain('gen-only');
  });

  it('blocks deleting a reference only used as a keyframe', async () => {
    const project = await projectStore.createProject({ title: 'P406 keyframe delete' });
    await projectStore.mutateProject(project.id, (current) => ({
      ...current,
      references: [reference('frame')],
      scenes: [generatedVideoScene({ generationReferenceIds: ['frame'], startFrameReferenceId: 'frame' })]
    }));

    const result = await projectStore.deleteReference(project.id, 'frame');
    expect(result.usageSceneIds).toEqual(['scene-video']);

    const reloaded = await projectStore.getProject(project.id);
    expect(reloaded?.references.map((entry) => entry.id)).toContain('frame');
  });

  it('still deletes an unused reference', async () => {
    const project = await projectStore.createProject({ title: 'P406 unused' });
    await projectStore.mutateProject(project.id, (current) => ({
      ...current,
      references: [reference('unused')],
      scenes: [generatedVideoScene()]
    }));

    const result = await projectStore.deleteReference(project.id, 'unused');
    expect(result).toEqual({ usageSceneIds: [], usageAssetIds: [] });

    const reloaded = await projectStore.getProject(project.id);
    expect(reloaded?.references).toEqual([]);
  });
});

describe('P406 approval invalidation', () => {
  const references = [reference('start'), reference('end')];

  function approvedProject(): Project {
    return withApproval(normalizeProject(baseProject({
      references,
      scenes: [generatedVideoScene({
        sceneReferenceIds: ['start', 'end'],
        generationReferenceIds: ['start', 'end'],
        startFrameReferenceId: 'start',
        endFrameReferenceId: 'end'
      })]
    })));
  }

  it('starts valid', () => {
    expect(isValidHumanApproval(approvedProject())).toBe(true);
  });

  it('becomes stale when the negative prompt changes', () => {
    const project = approvedProject();
    const scene = project.scenes[0];
    if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    scene.visual.generation.negativePrompt = 'no text overlays';
    expect(isValidHumanApproval(project)).toBe(false);
  });

  it('becomes stale when the effective reference set changes', () => {
    const project = approvedProject();
    const scene = project.scenes[0];
    if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    scene.visual.generation.referenceIds = ['start'];
    expect(isValidHumanApproval(project)).toBe(false);
  });

  it('becomes stale when a keyframe designation changes', () => {
    const project = approvedProject();
    const scene = project.scenes[0];
    if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    scene.visual.generation.startFrameReferenceId = 'end';
    scene.visual.generation.endFrameReferenceId = 'start';
    expect(isValidHumanApproval(project)).toBe(false);
  });

  it('ignores scene-list drift while a generation snapshot is effective', () => {
    const project = approvedProject();
    project.scenes[0].referenceIds = ['start'];
    expect(isValidHumanApproval(project)).toBe(true);
  });

  it('becomes stale when the scene-list fallback changes for legacy generations', () => {
    const project = withApproval(normalizeProject(baseProject({
      references,
      scenes: [generatedVideoScene({ sceneReferenceIds: ['start', 'end'] })]
    })));
    expect(isValidHumanApproval(project)).toBe(true);

    project.scenes[0].referenceIds = ['start'];
    expect(isValidHumanApproval(project)).toBe(false);
  });

  it('does not change for title or updatedAt changes', () => {
    const project = approvedProject();
    const original = hashProductionContent(project);
    project.title = 'Renamed';
    project.updatedAt = '2027-01-01T00:00:00.000Z';
    expect(hashProductionContent(project)).toBe(original);
    expect(isValidHumanApproval(project)).toBe(true);
  });
});
