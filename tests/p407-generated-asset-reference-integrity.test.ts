import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DELETE as deleteReferenceRoute } from '@/app/api/projects/[id]/references/[referenceId]/route';
import { ReferencesPanel } from '@/components/project/references-panel';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { getReferenceAssetUsage, getReferenceUsage } from '@/lib/projects/usage';
import { clearThrottleStateForTests } from '@/lib/security/access-control';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { projectStore } from '@/lib/storage/project-store';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import type { ReferenceImage } from '@/lib/types/reference';
import type { Scene } from '@/lib/types/scene';
import { validateProject } from '@/lib/validation/project-validation';

vi.mock('next/image', () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => React.createElement('img', props)
}));

const now = '2026-10-28T00:00:00.000Z';

let originalCwd: string;
let tempRoot: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'p407-reference-asset-'));
  process.chdir(tempRoot);
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearThrottleStateForTests();
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

function generatedAsset(id: string, referenceIds: string[]): Asset {
  return {
    id,
    type: 'image',
    status: 'available',
    provenance: 'generated',
    filename: `${id}.png`,
    localPath: `assets/${id}.png`,
    mimeType: 'image/png',
    metadata: {},
    generation: {
      generationId: `gen-${id}`,
      provider: 'openai',
      model: 'test-model',
      prompt: `prompt for ${id}`,
      referenceIds
    },
    createdAt: now,
    updatedAt: now
  };
}

function assetVisualScene(id: string, assetId: string, order = 1): Scene {
  return {
    id,
    order,
    duration: 5,
    type: 'image',
    visual: { kind: 'asset', assetId },
    render: { motion: { preset: 'none' }, transition: { type: 'fade' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: ''
  };
}

function generatedVideoScene(overrides: {
  id?: string;
  order?: number;
  sceneReferenceIds?: string[];
  generationReferenceIds?: string[];
  startFrameReferenceId?: string;
  endFrameReferenceId?: string;
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
        prompt: 'animate the start frame',
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
  return normalizeProject({
    id: 'p407-project',
    title: 'P407',
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
    compositions: [],
    assets: [],
    references: [],
    scenes: [assetVisualScene('scene-1', 'asset-a')],
    ...overrides
  } as Project);
}

async function createStoredProject(overrides: Partial<Project> = {}): Promise<Project> {
  const created = await projectStore.createProject({ title: 'P407 store' });
  const project = await projectStore.mutateProject(created.id, (current) => ({
    ...current,
    ...baseProject(overrides),
    id: current.id,
    ownerId: current.ownerId,
    createdAt: current.createdAt
  }));
  if (!project) {
    throw new Error('failed to create P407 project');
  }
  return project;
}

function referenceDeleteRequest(projectId: string, referenceId: string): Request {
  return new Request(`http://localhost/api/projects/${projectId}/references/${referenceId}`, {
    method: 'DELETE',
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${createUserSessionCookie('user-a')}`
    }
  });
}

describe('P407 asset trace usage', () => {
  it('reports assets whose generation trace names the reference', () => {
    const project = baseProject({
      references: [reference('ref-a'), reference('ref-b')],
      assets: [
        generatedAsset('asset-a', ['ref-a']),
        generatedAsset('asset-b', ['ref-a', 'ref-b']),
        generatedAsset('asset-c', ['ref-b']),
        generatedAsset('asset-d', [])
      ]
    });

    expect(getReferenceAssetUsage(project, 'ref-a')).toEqual(['asset-a', 'asset-b']);
    expect(getReferenceAssetUsage(project, 'ref-b')).toEqual(['asset-b', 'asset-c']);
    expect(getReferenceAssetUsage(project, 'ref-missing')).toEqual([]);
  });

  it('reports every asset that still traces a reference after regeneration', () => {
    const project = baseProject({
      references: [reference('ref-a')],
      assets: [
        generatedAsset('asset-old', ['ref-a']),
        generatedAsset('asset-new', ['ref-a'])
      ]
    });

    expect(getReferenceAssetUsage(project, 'ref-a')).toEqual(['asset-old', 'asset-new']);
  });

  it('keeps scene usage separate from asset usage', () => {
    const project = baseProject({
      references: [reference('ref-a')],
      assets: [generatedAsset('asset-a', ['ref-a'])],
      scenes: [generatedVideoScene({ sceneReferenceIds: ['ref-a'] })]
    });

    expect(getReferenceUsage(project, 'ref-a')).toEqual(['scene-video']);
    expect(getReferenceAssetUsage(project, 'ref-a')).toEqual(['asset-a']);
  });

  it('does not report imported or stock assets without a trace', () => {
    const project = baseProject({
      references: [reference('ref-a')],
      assets: [
        {
          id: 'asset-imported',
          type: 'image',
          status: 'available',
          provenance: 'imported',
          filename: 'imported.png',
          localPath: 'assets/imported.png',
          metadata: {},
          createdAt: now,
          updatedAt: now
        }
      ]
    });

    expect(getReferenceAssetUsage(project, 'ref-a')).toEqual([]);
  });
});

describe('P407 reference deletion guard', () => {
  it('blocks deletion when only an asset trace still uses the reference', async () => {
    const project = await createStoredProject({
      references: [reference('ref-traced')],
      assets: [generatedAsset('asset-traced', ['ref-traced'])],
      scenes: [assetVisualScene('scene-1', 'asset-traced')]
    });

    const result = await projectStore.deleteReference(project.id, 'ref-traced');

    expect(result.usageSceneIds).toEqual([]);
    expect(result.usageAssetIds).toEqual(['asset-traced']);

    const reloaded = await projectStore.getProject(project.id);
    expect(reloaded?.references.map((entry) => entry.id)).toEqual(['ref-traced']);
    expect(validateProject(reloaded!).valid).toBe(true);
  });

  it('does not strip the trace when deletion is blocked', async () => {
    const project = await createStoredProject({
      references: [reference('ref-traced')],
      assets: [generatedAsset('asset-traced', ['ref-traced'])],
      scenes: [assetVisualScene('scene-1', 'asset-traced')]
    });

    await projectStore.deleteReference(project.id, 'ref-traced');

    const reloaded = await projectStore.getProject(project.id);
    expect(reloaded?.assets[0].generation?.referenceIds).toEqual(['ref-traced']);
  });

  it('reports both scene and asset usage at once', async () => {
    const project = await createStoredProject({
      references: [reference('ref-a')],
      assets: [generatedAsset('asset-a', ['ref-a'])],
      scenes: [generatedVideoScene({ sceneReferenceIds: ['ref-a'] })]
    });

    const result = await projectStore.deleteReference(project.id, 'ref-a');

    expect(result.usageSceneIds).toEqual(['scene-video']);
    expect(result.usageAssetIds).toEqual(['asset-a']);
  });

  it('reports multiple blocking assets', async () => {
    const project = await createStoredProject({
      references: [reference('ref-a')],
      assets: [
        generatedAsset('asset-one', ['ref-a']),
        generatedAsset('asset-two', ['ref-a'])
      ],
      scenes: [assetVisualScene('scene-1', 'asset-one')]
    });

    const result = await projectStore.deleteReference(project.id, 'ref-a');

    expect(result.usageAssetIds).toEqual(['asset-one', 'asset-two']);
  });

  it('only blocks the traced reference, not its siblings', async () => {
    const project = await createStoredProject({
      references: [reference('ref-traced'), reference('ref-free')],
      assets: [generatedAsset('asset-traced', ['ref-traced'])],
      scenes: [assetVisualScene('scene-1', 'asset-traced')]
    });

    const blocked = await projectStore.deleteReference(project.id, 'ref-traced');
    expect(blocked.usageAssetIds).toEqual(['asset-traced']);

    const allowed = await projectStore.deleteReference(project.id, 'ref-free');
    expect(allowed).toEqual({ usageSceneIds: [], usageAssetIds: [] });

    const reloaded = await projectStore.getProject(project.id);
    expect(reloaded?.references.map((entry) => entry.id)).toEqual(['ref-traced']);
  });

  it('still deletes an unused reference', async () => {
    const project = await createStoredProject({
      references: [reference('ref-unused')],
      assets: [generatedAsset('asset-a', [])],
      scenes: [assetVisualScene('scene-1', 'asset-a')]
    });

    const result = await projectStore.deleteReference(project.id, 'ref-unused');

    expect(result).toEqual({ usageSceneIds: [], usageAssetIds: [] });
    const reloaded = await projectStore.getProject(project.id);
    expect(reloaded?.references).toEqual([]);
  });

  it('keeps the P406 scene, generation-snapshot and keyframe guards intact', async () => {
    const project = await createStoredProject({
      references: [reference('scene-ref'), reference('snapshot-ref'), reference('frame-ref')],
      assets: [],
      scenes: [
        generatedVideoScene({ id: 'scene-list', order: 1, sceneReferenceIds: ['scene-ref'] }),
        generatedVideoScene({ id: 'scene-snapshot', order: 2, generationReferenceIds: ['snapshot-ref'] }),
        generatedVideoScene({ id: 'scene-frame', order: 3, generationReferenceIds: ['frame-ref'], startFrameReferenceId: 'frame-ref' })
      ]
    });

    const sceneList = await projectStore.deleteReference(project.id, 'scene-ref');
    expect(sceneList.usageSceneIds).toEqual(['scene-list']);
    expect(sceneList.usageAssetIds).toEqual([]);

    const snapshot = await projectStore.deleteReference(project.id, 'snapshot-ref');
    expect(snapshot.usageSceneIds).toEqual(['scene-snapshot']);
    expect(snapshot.usageAssetIds).toEqual([]);

    const frame = await projectStore.deleteReference(project.id, 'frame-ref');
    expect(frame.usageSceneIds).toEqual(['scene-frame']);
    expect(frame.usageAssetIds).toEqual([]);

    const reloaded = await projectStore.getProject(project.id);
    expect(reloaded?.references.map((entry) => entry.id).sort()).toEqual(['frame-ref', 'scene-ref', 'snapshot-ref']);
  });
});

describe('P407 safe order', () => {
  it('allows deletion after the asset is unbound and deleted', async () => {
    const project = await createStoredProject({
      references: [reference('ref-a')],
      assets: [generatedAsset('asset-a', ['ref-a'])],
      scenes: [assetVisualScene('scene-1', 'asset-a')]
    });

    const unbound = await projectStore.mutateProject(project.id, (current) => ({
      ...current,
      scenes: current.scenes.map((scene) => ({ ...scene, visual: { kind: 'blank' as const } }))
    }));
    expect(validateProject(unbound!).valid).toBe(true);

    const assetDeletion = await projectStore.deleteAsset(project.id, 'asset-a');
    expect(assetDeletion).toEqual({ usageSceneIds: [] });

    const deletion = await projectStore.deleteReference(project.id, 'ref-a');
    expect(deletion).toEqual({ usageSceneIds: [], usageAssetIds: [] });

    const reloaded = await projectStore.getProject(project.id);
    expect(reloaded?.references).toEqual([]);
    expect(reloaded?.assets).toEqual([]);
    expect(validateProject(reloaded!).valid).toBe(true);
  });

  it('allows deletion after the tracing asset is removed directly', async () => {
    const project = await createStoredProject({
      references: [reference('ref-a')],
      assets: [generatedAsset('asset-detached', ['ref-a']), generatedAsset('asset-bound', [])],
      scenes: [assetVisualScene('scene-1', 'asset-bound')]
    });

    // asset-detached is not bound to any scene, so it can go straight away.
    const assetDeletion = await projectStore.deleteAsset(project.id, 'asset-detached');
    expect(assetDeletion).toEqual({ usageSceneIds: [] });

    const deletion = await projectStore.deleteReference(project.id, 'ref-a');
    expect(deletion).toEqual({ usageSceneIds: [], usageAssetIds: [] });

    const reloaded = await projectStore.getProject(project.id);
    expect(validateProject(reloaded!).valid).toBe(true);
  });
});

describe('P407 reference delete route', () => {
  it('returns 409 with usageAssetIds when an asset trace blocks deletion', async () => {
    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-1', ownerId: 'user-a' } as never);
    vi.spyOn(projectStore, 'deleteReference').mockResolvedValue({
      usageSceneIds: [],
      usageAssetIds: ['asset-traced']
    });

    const response = await deleteReferenceRoute(
      referenceDeleteRequest('project-1', 'ref-traced'),
      { params: Promise.resolve({ id: 'project-1', referenceId: 'ref-traced' }) }
    );

    expect(response.status).toBe(409);
    const body = await response.json() as { message: string; usageSceneIds: string[]; usageAssetIds: string[] };
    expect(body.usageAssetIds).toEqual(['asset-traced']);
    expect(body.usageSceneIds).toEqual([]);
    expect(body.message).toContain('generated asset');
    expect(body.message).toContain('Unbind or delete');
  });

  it('keeps the existing scene 409 fields intact', async () => {
    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-1', ownerId: 'user-a' } as never);
    vi.spyOn(projectStore, 'deleteReference').mockResolvedValue({
      usageSceneIds: ['scene-1'],
      usageAssetIds: []
    });

    const response = await deleteReferenceRoute(
      referenceDeleteRequest('project-1', 'ref-scene'),
      { params: Promise.resolve({ id: 'project-1', referenceId: 'ref-scene' }) }
    );

    expect(response.status).toBe(409);
    const body = await response.json() as { message: string; usageSceneIds: string[]; usageAssetIds: string[] };
    expect(body.usageSceneIds).toEqual(['scene-1']);
    expect(body.usageAssetIds).toEqual([]);
    expect(body.message).toContain('scene');
  });

  it('returns 200 when nothing uses the reference', async () => {
    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-1', ownerId: 'user-a' } as never);
    vi.spyOn(projectStore, 'deleteReference').mockResolvedValue({ usageSceneIds: [], usageAssetIds: [] });

    const response = await deleteReferenceRoute(
      referenceDeleteRequest('project-1', 'ref-free'),
      { params: Promise.resolve({ id: 'project-1', referenceId: 'ref-free' }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe('P407 references panel asset usage', () => {
  function renderPanel(overrides: Partial<React.ComponentProps<typeof ReferencesPanel>> = {}): string {
    const project = overrides.project ?? baseProject();
    const props: React.ComponentProps<typeof ReferencesPanel> = {
      project,
      references: project.references,
      referenceQuery: '',
      onReferenceQueryChange: () => {},
      selectedReferenceId: '',
      onSelectReference: () => {},
      onNavigateScene: () => {},
      onNavigateAsset: () => {},
      newReferenceName: '',
      newReferenceDescription: '',
      newReferenceTags: '',
      onNewReferenceNameChange: () => {},
      onNewReferenceDescriptionChange: () => {},
      onNewReferenceTagsChange: () => {},
      onImportReference: () => {},
      onSaveReferenceDetails: () => {},
      onDeleteReference: () => {},
      referenceMessage: '',
      ...overrides
    };

    return renderToStaticMarkup(React.createElement(ReferencesPanel, props));
  }

  it('shows how many generated assets record a reference', () => {
    const referenceRecord = reference('ref-a');
    const project = baseProject({
      references: [referenceRecord],
      assets: [generatedAsset('asset-one', ['ref-a']), generatedAsset('asset-two', ['ref-a'])],
      scenes: []
    });

    const html = renderPanel({ project, references: [referenceRecord] });

    expect(html).toContain('used by 0');
    expect(html).toContain('2 asset(s)');
  });

  it('lists the blocking assets by filename in the detail card', () => {
    const referenceRecord = reference('ref-a');
    const project = baseProject({
      references: [referenceRecord],
      assets: [generatedAsset('asset-one', ['ref-a']), generatedAsset('asset-two', ['ref-a'])],
      scenes: []
    });

    const html = renderPanel({ project, references: [referenceRecord], selectedReferenceId: referenceRecord.id });

    expect(html).toContain('Used by generated assets');
    expect(html).toContain('asset-one.png (image)');
    expect(html).toContain('asset-two.png (image)');
    expect(html).toContain('Unbind or delete these assets before deleting this reference.');
  });

  it('shows the empty asset state when no asset records the reference', () => {
    const referenceRecord = reference('ref-a');
    const project = baseProject({ references: [referenceRecord], assets: [], scenes: [] });

    const html = renderPanel({ project, references: [referenceRecord], selectedReferenceId: referenceRecord.id });

    expect(html).toContain('No generated asset records this reference.');
  });

  it('renders the blocked-delete message from the workspace', () => {
    const referenceRecord = reference('ref-a');
    const project = baseProject({
      references: [referenceRecord],
      assets: [generatedAsset('asset-one', ['ref-a'])],
      scenes: []
    });

    const html = renderPanel({
      project,
      references: [referenceRecord],
      selectedReferenceId: referenceRecord.id,
      referenceMessage: 'This reference is still recorded by generated asset(s): asset-one.png (image). Unbind or delete those assets first.'
    });

    expect(html).toContain('recorded by generated asset(s)');
    expect(html).toContain('asset-one.png (image)');
  });
});
