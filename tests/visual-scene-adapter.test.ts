import { describe, expect, it } from 'vitest';

import { createStudioComposition, STUDIO_LAYER_IDS } from '@/lib/render/scene-composition';
import { resolveRenderPlan, resolveVisualScene, resolveVisualSource } from '@/lib/render/scene-resolver';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import type { Scene, VisualSpec } from '@/lib/types/scene';

const NOW = '2026-10-22T00:00:00.000Z';

function makeAsset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    type: 'image',
    status: 'available',
    provenance: 'generated',
    filename: `${id}.png`,
    localPath: `assets/${id}.png`,
    mimeType: 'image/png',
    width: 1920,
    height: 1080,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function makeScene(id: string, visual: VisualSpec | undefined, overrides: Partial<Scene> = {}): Scene {
  const type = visual?.kind === 'html'
    ? 'html'
    : visual?.kind === 'graphic'
      ? 'graphic'
      : visual?.kind === 'text'
        ? 'text'
        : visual?.kind === 'blank' || !visual
          ? 'blank'
          : visual.kind === 'generated_video'
            ? 'video'
            : 'image';
  return {
    id,
    order: 1,
    duration: 4,
    type,
    visual,
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: '',
    ...overrides
  };
}

function makeProject(scene: Scene, assets: Asset[] = []): Project {
  return {
    id: 'project-visual-scene',
    title: 'VisualScene adapter',
    description: '',
    durationTarget: 4,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: NOW,
    updatedAt: NOW,
    narration: { text: '', segments: [] },
    scenes: [scene],
    assets,
    references: [],
    compositions: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    }
  };
}

function expectAdapterMatchesSource(project: Project, scene: Scene): ReturnType<typeof resolveVisualScene> {
  const source = resolveVisualSource(project, scene);
  const visualScene = resolveVisualScene(project, scene);
  expect(visualScene.sceneId).toBe(scene.id);
  expect(visualScene.readiness).toBe(source.status);
  expect(visualScene.source).toEqual(source.source);
  expect(visualScene.issues).toEqual(source.issues);
  expect(visualScene.kind).toBe(scene.visual?.kind ?? scene.type);
  return visualScene;
}

describe('VisualScene adapter', () => {
  it('marks renderable HTML with a current PNG as studio-screen contain when studio composition exists', () => {
    const composition = createStudioComposition({
      backgroundLocalPath: 'assets/studio/studio_back.png',
      imageAssetId: 'html-1',
      imageLocalPath: 'assets/html-1.png',
      foregroundLocalPath: 'assets/studio/studio_desk.png'
    });
    const scene = makeScene('scene-html', {
      kind: 'html',
      template: 'headline',
      templateData: { title: 'Live' },
      assetId: 'html-1'
    }, { composition });
    const project = makeProject(scene, [makeAsset('html-1')]);

    const visualScene = expectAdapterMatchesSource(project, scene);
    expect(visualScene.readiness).toBe('renderable');
    expect(visualScene.source.assetPath).toBe('assets/html-1.png');
    expect(visualScene.bind).toEqual({ mode: 'studio_screen', layerId: 'studio-screen', fit: 'contain' });
  });

  it('keeps HTML without a PNG planned and full_frame', () => {
    const scene = makeScene('scene-html', {
      kind: 'html',
      template: 'headline',
      templateData: { title: 'Live' }
    });
    const project = makeProject(scene);

    const visualScene = expectAdapterMatchesSource(project, scene);
    expect(visualScene.readiness).toBe('planned');
    expect(visualScene.source.assetPath).toBeUndefined();
    expect(visualScene.issues.some((issue) => issue.code === 'scene.visual.html.planned')).toBe(true);
    expect(visualScene.bind).toEqual({ mode: 'full_frame' });
  });

  it('marks a downloaded stock asset renderable and studio-screen when studio composition exists', () => {
    const composition = createStudioComposition({
      backgroundLocalPath: 'assets/studio/studio_back.png',
      imageAssetId: 'stock-1',
      imageLocalPath: 'assets/stock-1.png'
    });
    const scene = makeScene('scene-stock', {
      kind: 'stock_image',
      query: 'forest',
      assetId: 'stock-1'
    }, { composition });
    const project = makeProject(scene, [makeAsset('stock-1', { provenance: 'stock' })]);

    const visualScene = expectAdapterMatchesSource(project, scene);
    expect(visualScene.readiness).toBe('renderable');
    expect(visualScene.source.assetPath).toBe('assets/stock-1.png');
    expect(visualScene.bind).toEqual({ mode: 'studio_screen', layerId: 'studio-screen', fit: 'contain' });
  });

  it('keeps graphic, text, and blank on the existing full_frame SVG route', () => {
    const graphic = makeScene('scene-graphic', { kind: 'graphic', template: 'title_card', templateData: { title: 'Hello' } });
    const text = makeScene('scene-text', { kind: 'text', text: 'Hello' });
    const blank = makeScene('scene-blank', { kind: 'blank' });

    for (const scene of [graphic, text, blank]) {
      const visualScene = expectAdapterMatchesSource(makeProject(scene), scene);
      expect(visualScene.readiness).toBe('renderable');
      expect(visualScene.bind).toEqual({ mode: 'full_frame' });
    }
  });

  it('preserves invalid source issues from resolveVisualSource', () => {
    const missingVisual = makeScene('scene-missing', undefined);
    const missingHtml = makeScene('scene-html', { kind: 'html' });
    const missingAsset = makeScene('scene-asset', { kind: 'asset', assetId: 'missing' });

    const missingVisualScene = expectAdapterMatchesSource(makeProject(missingVisual), missingVisual);
    expect(missingVisualScene.readiness).toBe('invalid');
    expect(missingVisualScene.issues.some((issue) => issue.code === 'scene.visual.missing')).toBe(true);
    expect(missingVisualScene.bind).toEqual({ mode: 'full_frame' });

    const missingHtmlScene = expectAdapterMatchesSource(makeProject(missingHtml), missingHtml);
    expect(missingHtmlScene.readiness).toBe('invalid');
    expect(missingHtmlScene.issues.some((issue) => issue.code === 'scene.visual.html.missing')).toBe(true);

    const missingAssetScene = expectAdapterMatchesSource(makeProject(missingAsset), missingAsset);
    expect(missingAssetScene.readiness).toBe('invalid');
    expect(missingAssetScene.issues.some((issue) => issue.code === 'scene.visual.asset.notFound')).toBe(true);
  });

  it('does not change resolveRenderPlan composition or status for an existing studio stack', () => {
    const composition = createStudioComposition({
      backgroundLocalPath: 'assets/studio/studio_back.png',
      imageAssetId: 'html-1',
      imageLocalPath: 'assets/html-1.png',
      foregroundLocalPath: 'assets/studio/studio_desk.png'
    });
    const scene = makeScene('scene-html', {
      kind: 'html',
      template: 'headline',
      templateData: { title: 'Live' },
      assetId: 'html-1'
    }, { composition });
    const project = makeProject(scene, [
      makeAsset('html-1'),
      makeAsset('studio_back', { localPath: 'assets/studio/studio_back.png' }),
      makeAsset('studio_desk', { localPath: 'assets/studio/studio_desk.png' })
    ]);

    const plan = resolveRenderPlan(project);
    const visualScene = resolveVisualScene(project, scene);
    const plannedScene = plan.scenes[0];

    expect(plannedScene.status).toBe(visualScene.readiness);
    expect(plannedScene.source).toEqual(visualScene.source);
    expect(plannedScene.composition?.preset).toBe('studio');
    expect(plannedScene.composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.image)).toMatchObject({
      id: 'studio-screen',
      fit: 'contain',
      assetId: 'html-1',
      assetPath: 'assets/html-1.png'
    });
    expect(visualScene.bind).toEqual({ mode: 'studio_screen', layerId: 'studio-screen', fit: 'contain' });
  });

  it('keeps HTML with a PNG but no composition on the historical full_frame path', () => {
    const scene = makeScene('scene-html', {
      kind: 'html',
      template: 'headline',
      templateData: { title: 'Live' },
      assetId: 'html-1'
    });
    const project = makeProject(scene, [makeAsset('html-1')]);
    const visualScene = expectAdapterMatchesSource(project, scene);
    expect(visualScene.readiness).toBe('renderable');
    expect(visualScene.bind).toEqual({ mode: 'full_frame' });
    expect(resolveRenderPlan(project).scenes[0].composition).toBeUndefined();
  });
});
