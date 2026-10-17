import { describe, expect, it } from 'vitest';

import { deriveNarrationFreshness } from '@/lib/generation/narration-freshness';
import { deriveProductionPlan } from '@/lib/production/production-planner';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import { deriveCompositionArtifactStatus } from '@/lib/render/render-status';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import type { Scene, SceneRenderArtifact } from '@/lib/types/scene';
import type { StockProviderId, StockSelection } from '@/lib/types/stock';

const NOW = '2026-10-17T00:00:00.000Z';

function stockSelection(provider: StockProviderId, photoId: string): StockSelection {
  return {
    provider,
    photoId,
    query: 'forest path',
    orientation: 'landscape',
    usagePolicy: 'download',
    attribution: {
      provider,
      providerName: provider,
      photoId,
      photographerName: 'Tester',
      sourceUrl: `https://example.com/${provider}/${photoId}`,
      license: 'Test License'
    },
    sourceUrl: `https://example.com/${provider}/${photoId}`,
    imageUrl: `https://images.example/${provider}/${photoId}.jpg`,
    downloadUrl: `https://images.example/${provider}/${photoId}.jpg`,
    width: 1280,
    height: 720,
    selectedAt: NOW,
    selectionKey: 'landscape::forest path',
    origin: 'auto'
  };
}

function stockAsset(id: string): Asset {
  return {
    id,
    type: 'image',
    status: 'available',
    provenance: 'stock',
    filename: `${id}.jpg`,
    localPath: `assets/${id}.jpg`,
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
    filesize: 1000,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW
  };
}

function stockScene(id: string, order: number, provider: StockProviderId, photoId: string, assetId: string): Scene {
  return {
    id,
    order,
    duration: 2,
    type: 'image',
    narration: { text: '' },
    visual: {
      kind: 'stock_image',
      query: 'forest path',
      orientation: 'landscape',
      assetId,
      selection: stockSelection(provider, photoId)
    },
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: '',
    renders: []
  };
}

function createProject(): Project {
  return normalizeProject({
    id: 'project-p31.3',
    title: 'P31.3 stale composition',
    description: 'desc',
    durationTarget: 4,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: NOW,
    updatedAt: NOW,
    narration: { text: '', segments: [] },
    scenes: [
      stockScene('scene-1', 1, 'fake', 'fake-1', 'asset-fake-1'),
      stockScene('scene-2', 2, 'fake', 'fake-2', 'asset-fake-2')
    ],
    assets: [stockAsset('asset-fake-1'), stockAsset('asset-fake-2')],
    references: [],
    compositions: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1280,
      height: 720,
      background: { type: 'color', value: '#020617' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    }
  });
}

function attachRender(project: Project, sceneId: string, renderId: string, createdAt: string): void {
  const plan = resolveRenderPlan(project);
  const scene = project.scenes.find((entry) => entry.id === sceneId)!;
  const planScene = plan.scenes.find((entry) => entry.sceneId === sceneId)!;
  const render: SceneRenderArtifact = {
    renderId,
    outputPath: `renders/${renderId}.mp4`,
    createdAt,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    duration: scene.duration,
    filesize: 1000,
    mimeType: 'video/mp4',
    renderer: 'ffmpeg',
    status: 'completed',
    renderFingerprint: createSceneRenderFingerprint(plan, planScene)
  };
  scene.renders = [render, ...(scene.renders ?? [])];
}

function attachComposition(project: Project, entries: Array<{ sceneId: string; renderId: string }>): void {
  const plan = resolveRenderPlan(project);
  project.compositions = [{
    compositionId: 'composition-1',
    projectId: project.id,
    outputPath: 'renders/final-composition-1.mp4',
    createdAt: NOW,
    sceneIds: entries.map((entry) => entry.sceneId),
    inputFingerprint: {
      version: 'p10.1',
      audioMix: project.renderSettings.audio,
      scenes: entries.map((entry) => {
        const scene = project.scenes.find((candidate) => candidate.id === entry.sceneId)!;
        return {
          sceneId: entry.sceneId,
          renderId: entry.renderId,
          narrationSignature: deriveNarrationFreshness(project, scene).narrationSignature
        };
      })
    },
    duration: 4,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    renderer: 'ffmpeg',
    version: 'p10.1',
    filesize: 1000,
    mimeType: 'video/mp4',
    transition: { type: 'none' }
  }];
}

function reselectAndRerender(
  project: Project,
  sceneId: string,
  provider: StockProviderId,
  photoId: string,
  assetId: string,
  renderId: string,
  createdAt: string
): void {
  const scene = project.scenes.find((entry) => entry.id === sceneId)!;
  if (!project.assets.some((asset) => asset.id === assetId)) {
    project.assets.push(stockAsset(assetId));
  }
  scene.visual = {
    kind: 'stock_image',
    query: 'forest path',
    orientation: 'landscape',
    assetId,
    selection: stockSelection(provider, photoId)
  };
  attachRender(project, sceneId, renderId, createdAt);
}

function fakeProjectWithComposition(): Project {
  const project = createProject();
  attachRender(project, 'scene-1', 'render-fake-1', '2026-10-17T00:00:10.000Z');
  attachRender(project, 'scene-2', 'render-fake-2', '2026-10-17T00:00:11.000Z');
  attachComposition(project, [
    { sceneId: 'scene-1', renderId: 'render-fake-1' },
    { sceneId: 'scene-2', renderId: 'render-fake-2' }
  ]);
  return project;
}

function realProjectWithComposition(): Project {
  const project = createProject();
  project.assets = [stockAsset('asset-real-1'), stockAsset('asset-real-2')];
  project.scenes[0].visual = {
    kind: 'stock_image',
    query: 'forest path',
    orientation: 'landscape',
    assetId: 'asset-real-1',
    selection: stockSelection('pixabay', 'pixabay-1')
  };
  project.scenes[1].visual = {
    kind: 'stock_image',
    query: 'forest path',
    orientation: 'landscape',
    assetId: 'asset-real-2',
    selection: stockSelection('pixabay', 'pixabay-2')
  };
  attachRender(project, 'scene-1', 'render-real-1', '2026-10-17T00:00:20.000Z');
  attachRender(project, 'scene-2', 'render-real-2', '2026-10-17T00:00:21.000Z');
  attachComposition(project, [
    { sceneId: 'scene-1', renderId: 'render-real-1' },
    { sceneId: 'scene-2', renderId: 'render-real-2' }
  ]);
  return project;
}

function finalCompose(project: Project, options: Parameters<typeof deriveProductionPlan>[1] = {}) {
  return deriveProductionPlan(project, options).actions.find((action) => action.type === 'final_compose')!;
}

describe('P31.3 stale composition invalidation', () => {
  it('marks a composition stale when a scene was re-rendered after it was created', () => {
    const project = fakeProjectWithComposition();

    reselectAndRerender(project, 'scene-1', 'pixabay', 'pixabay-1', 'asset-real-1', 'render-real-1', '2026-10-17T00:01:00.000Z');

    const status = deriveCompositionArtifactStatus(project, resolveRenderPlan(project));

    expect(status.status).toBe('stale');
    expect(status.reasons).toContain('Scene 1 was re-rendered since the final composition was created.');
  });

  it('re-plans final_compose after a mock-to-real stock re-selection without force', () => {
    const project = fakeProjectWithComposition();

    reselectAndRerender(project, 'scene-1', 'pixabay', 'pixabay-1', 'asset-real-1', 'render-real-1', '2026-10-17T00:01:00.000Z');
    reselectAndRerender(project, 'scene-2', 'pixabay', 'pixabay-2', 'asset-real-2', 'render-real-2', '2026-10-17T00:01:01.000Z');

    const plan = deriveProductionPlan(project, { mode: 'real' });

    expect(plan.actions.filter((action) => action.type === 'stock_select').map((action) => action.status)).toEqual(['current', 'current']);
    expect(plan.actions.filter((action) => action.type === 'scene_render').map((action) => action.status)).toEqual(['current', 'current']);
    expect(finalCompose(project, { mode: 'real' })).toMatchObject({
      status: 'ready',
      execute: true
    });
  });

  it('keeps final_compose current when the real selections and renders are unchanged', () => {
    const project = realProjectWithComposition();

    const status = deriveCompositionArtifactStatus(project, resolveRenderPlan(project));
    const compose = finalCompose(project, { mode: 'real' });

    expect(status.status).toBe('current');
    expect(compose.status).toBe('current');
    expect(compose.execute).toBe(false);
  });

  it('keeps forced recomposition behavior after the forced scene actions complete', () => {
    const project = realProjectWithComposition();
    const completed = [
      'scene:scene-1:stock_select',
      'scene:scene-2:stock_select',
      'scene:scene-1:scene_render',
      'scene:scene-2:scene_render'
    ];

    const forced = finalCompose(project, { mode: 'real', force: true });
    const settled = finalCompose(project, {
      mode: 'real',
      force: true,
      completedActionIds: completed
    });

    expect(forced.status).toBe('waiting_dependency');
    expect(settled.status).toBe('ready');
    expect(settled.execute).toBe(true);
  });

  it('invalidates the composition when only one of multiple scenes is re-rendered', () => {
    const project = realProjectWithComposition();

    reselectAndRerender(project, 'scene-2', 'pixabay', 'pixabay-9', 'asset-real-9', 'render-real-9', '2026-10-17T00:02:00.000Z');

    const status = deriveCompositionArtifactStatus(project, resolveRenderPlan(project));
    const plan = deriveProductionPlan(project, { mode: 'real' });
    const renders = plan.actions.filter((action) => action.type === 'scene_render');
    const stock = plan.actions.filter((action) => action.type === 'stock_select');

    expect(status.status).toBe('stale');
    expect(status.reasons).toContain('Scene 2 was re-rendered since the final composition was created.');
    expect(status.reasons.some((reason) => reason.startsWith('Scene 1 '))).toBe(false);
    expect(renders.map((action) => action.status)).toEqual(['current', 'current']);
    expect(stock.map((action) => action.status)).toEqual(['current', 'current']);
    expect(plan.actions.find((action) => action.type === 'final_compose')).toMatchObject({
      status: 'ready',
      execute: true
    });
  });

  it('returns to current after the composition fingerprint records the new renders', () => {
    const project = fakeProjectWithComposition();

    reselectAndRerender(project, 'scene-1', 'pixabay', 'pixabay-1', 'asset-real-1', 'render-real-1', '2026-10-17T00:01:00.000Z');
    reselectAndRerender(project, 'scene-2', 'pixabay', 'pixabay-2', 'asset-real-2', 'render-real-2', '2026-10-17T00:01:01.000Z');

    expect(deriveCompositionArtifactStatus(project, resolveRenderPlan(project)).status).toBe('stale');

    attachComposition(project, [
      { sceneId: 'scene-1', renderId: 'render-real-1' },
      { sceneId: 'scene-2', renderId: 'render-real-2' }
    ]);

    expect(deriveCompositionArtifactStatus(project, resolveRenderPlan(project)).status).toBe('current');
    expect(finalCompose(project, { mode: 'real' }).status).toBe('current');
  });
});
