import { describe, expect, it } from 'vitest';

import { normalizeProject } from '@/lib/projects/normalize-project';
import { collectProjectPatchShapeIssues } from '@/lib/projects/project-patch-shape';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import {
  createStudioComposition,
  normalizeSceneComposition,
  resolveStudioPipRect,
  sceneBakesPresenter,
  sortCompositionLayers,
  STUDIO_BIGSCREEN_RECT,
  STUDIO_COMPOSITION_CANVAS,
  STUDIO_LAYER_IDS,
  validateSceneComposition
} from '@/lib/render/scene-composition';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { STUDIO_PIP_PRESETS } from '@/lib/render/studio-compositions';
import type { Asset } from '@/lib/types/asset';
import type { Project, RenderIssue } from '@/lib/types/render';
import type { Scene, VisualSpec } from '@/lib/types/scene';
import { SCENE_COMPOSITION_SCHEMA_VERSION } from '@/lib/types/scene-composition';
import { validateProject } from '@/lib/validation/project-validation';

const NOW = '2026-10-20T00:00:00.000Z';

function makeAsset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    type: 'image',
    status: 'available',
    provenance: 'imported',
    filename: `${id}.png`,
    localPath: `assets/studio/${id}.png`,
    mimeType: 'image/png',
    width: 1920,
    height: 1080,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function makeScene(id: string, visual: VisualSpec, overrides: Partial<Scene> = {}): Scene {
  return {
    id,
    order: 1,
    duration: 2,
    type: visual.kind === 'blank' ? 'blank' : visual.kind === 'graphic' ? 'graphic' : 'image',
    visual,
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: '',
    ...overrides
  };
}

function makeProject(scenes: Scene[], overrides: Partial<Project> = {}): Project {
  return normalizeProject({
    id: 'project-composition-test',
    title: 'Scene Composition Test',
    description: 'desc',
    durationTarget: 4,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: NOW,
    updatedAt: NOW,
    narration: { text: '', segments: [] },
    scenes,
    assets: [
      makeAsset('studio_back'),
      makeAsset('studio_desk'),
      makeAsset('screen', { localPath: 'assets/studio/screen.png', width: 1346, height: 761 })
    ],
    references: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#070b10' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    ...overrides
  } as Project);
}

function collectCodes(issues: RenderIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe('studio composition preset', () => {
  it('builds a 1920x1080 studio stack with independent desk and bigscreen layers', () => {
    const composition = createStudioComposition({
      backgroundAssetId: 'studio_back',
      imageAssetId: 'screen',
      imageLocalPath: 'assets/studio/screen.png',
      foregroundAssetId: 'studio_desk'
    });

    expect(composition.version).toBe(SCENE_COMPOSITION_SCHEMA_VERSION);
    expect(composition.preset).toBe('studio');
    expect(composition.canvas).toEqual(STUDIO_COMPOSITION_CANVAS);
    expect(composition.layers.map((layer) => layer.id)).toEqual([
      STUDIO_LAYER_IDS.background,
      STUDIO_LAYER_IDS.image,
      STUDIO_LAYER_IDS.presenter,
      STUDIO_LAYER_IDS.foreground
    ]);
    expect(composition.layers.map((layer) => layer.zIndex)).toEqual([0, 10, 20, 30]);

    const [background, image, presenter, foreground] = composition.layers;
    expect(background).toMatchObject({
      type: 'background',
      enabled: true,
      localPath: 'assets/studio/studio_back.png',
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      fit: 'cover'
    });
    expect(image).toMatchObject({
      type: 'image',
      enabled: true,
      assetId: 'screen',
      rect: STUDIO_BIGSCREEN_RECT,
      fit: 'contain'
    });
    expect(presenter).toMatchObject({
      type: 'presenter',
      mode: 'full_canvas',
      rect: { x: 0, y: 0, width: 1920, height: 1080 }
    });
    expect(foreground).toMatchObject({
      type: 'foreground',
      enabled: true,
      localPath: 'assets/studio/studio_desk.png',
      rect: { x: 0, y: 0, width: 1920, height: 1080 }
    });
  });

  it('can disable desk and bigscreen independently without changing z-order', () => {
    const composition = createStudioComposition({
      deskEnabled: false,
      bigscreenEnabled: false
    });
    const byId = Object.fromEntries(composition.layers.map((layer) => [layer.id, layer]));

    expect(byId[STUDIO_LAYER_IDS.image]?.enabled).toBe(false);
    expect(byId[STUDIO_LAYER_IDS.foreground]?.enabled).toBe(false);
    expect(byId[STUDIO_LAYER_IDS.background]?.enabled).toBe(true);
    expect(byId[STUDIO_LAYER_IDS.presenter]?.enabled).toBe(true);
    expect(sortCompositionLayers(composition.layers).map((layer) => layer.id)).toEqual([
      STUDIO_LAYER_IDS.background,
      STUDIO_LAYER_IDS.image,
      STUDIO_LAYER_IDS.presenter,
      STUDIO_LAYER_IDS.foreground
    ]);
  });

  it('resolves intro and news PiP geometry in final canvas pixels', () => {
    const intro = resolveStudioPipRect(STUDIO_COMPOSITION_CANVAS, 'intro');
    const news = resolveStudioPipRect(STUDIO_COMPOSITION_CANVAS, 'news');
    const introWidth = Math.round(1920 * STUDIO_PIP_PRESETS.intro.widthRatio);
    const newsWidth = Math.round(1920 * STUDIO_PIP_PRESETS.news.widthRatio);

    expect(intro).toEqual({
      x: 1344,
      y: 77,
      width: introWidth,
      height: Math.round(introWidth * 1080 / 1920)
    });
    expect(news).toEqual({
      x: 1421,
      y: 115,
      width: newsWidth,
      height: Math.round(newsWidth * 1080 / 1920)
    });
    expect(intro.width).toBeGreaterThan(news.width);

    const pip = createStudioComposition({ presenterMode: 'pip', pipPreset: 'news' });
    const presenter = pip.layers.find((layer) => layer.type === 'presenter');
    expect(presenter).toMatchObject({ mode: 'pip', pipPreset: 'news', rect: news });
  });
});

describe('scene composition normalize and round-trip', () => {
  it('leaves scenes without composition unchanged', () => {
    const project = makeProject([makeScene('scene-1', { kind: 'blank' })]);
    expect(project.scenes[0].composition).toBeUndefined();
    expect(validateProject(project).valid).toBe(true);
    expect(validateProject(project).errors).toHaveLength(0);
  });

  it('round-trips a studio composition through project normalize and JSON', () => {
    const composition = createStudioComposition({
      backgroundAssetId: 'studio_back',
      imageAssetId: 'screen',
      imageLocalPath: 'assets/studio/screen.png',
      foregroundAssetId: 'studio_desk',
      presenterMode: 'pip',
      pipPreset: 'intro'
    });
    const project = makeProject([
      makeScene('scene-1', { kind: 'blank' }, { composition })
    ]);

    expect(project.scenes[0].composition).toEqual(composition);

    const reloaded = normalizeProject(JSON.parse(JSON.stringify(project)) as Project);
    expect(reloaded.scenes[0].composition).toEqual(composition);
    expect(validateProject(reloaded).valid).toBe(true);
  });

  it('defaults missing presenter mode to full canvas and fills studio canvas', () => {
    const normalized = normalizeSceneComposition({
      version: 1,
      preset: 'studio',
      layers: [
        {
          id: 'studio-back',
          type: 'background',
          zIndex: 0,
          localPath: 'assets/studio/studio_back.png',
          rect: { x: 0, y: 0, width: 1920, height: 1080 }
        },
        {
          id: 'studio-presenter',
          type: 'presenter'
        }
      ]
    });

    expect(normalized?.canvas).toEqual(STUDIO_COMPOSITION_CANVAS);
    expect(normalized?.layers[0]).toMatchObject({ enabled: true, fit: 'cover' });
    expect(normalized?.layers[1]).toMatchObject({
      type: 'presenter',
      mode: 'full_canvas',
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      enabled: true
    });
  });
});

describe('scene composition validation', () => {
  it('rejects unsafe and missing composition assets', () => {
    const project = makeProject([
      makeScene('scene-1', { kind: 'blank' }, {
        composition: createStudioComposition({
          backgroundLocalPath: '../secret.png',
          imageAssetId: 'missing-screen',
          foregroundLocalPath: '/tmp/studio_desk.png'
        })
      })
    ]);
    const result = validateProject(project);
    const codes = collectCodes(result.errors);

    expect(result.valid).toBe(false);
    expect(codes).toContain('scene.composition.asset.path.unsafe');
    expect(codes).toContain('scene.composition.asset.missing');
  });

  it('warns when an enabled media layer has no asset', () => {
    const project = makeProject([
      makeScene('scene-1', { kind: 'blank' }, {
        composition: createStudioComposition({
          backgroundLocalPath: undefined,
          backgroundAssetId: undefined,
          imageAssetId: 'screen',
          imageLocalPath: 'assets/studio/screen.png',
          foregroundLocalPath: undefined,
          foregroundAssetId: undefined,
          deskEnabled: false
        })
      })
    ]);
    const background = project.scenes[0].composition?.layers.find((layer) => layer.type === 'background');
    expect(background).toMatchObject({ enabled: true, localPath: 'assets/studio/studio_back.png' });

    const emptyBackground = {
      ...project.scenes[0].composition!,
      layers: project.scenes[0].composition!.layers.map((layer) => (
        layer.type === 'background' ? { ...layer, localPath: undefined, assetId: undefined } : layer
      ))
    };
    project.scenes[0].composition = emptyBackground;

    const result = validateProject(project);
    expect(result.warnings.some((issue) => issue.code === 'scene.composition.asset.missing')).toBe(true);
  });

  it('rejects duplicate z-index, invalid PiP, and out-of-bounds geometry', () => {
    const errors: RenderIssue[] = [];
    const warnings: RenderIssue[] = [];
    const project = makeProject([makeScene('scene-1', { kind: 'blank' })]);

    validateSceneComposition({
      version: 2,
      preset: 'newsroom',
      canvas: { width: 1920, height: 1080 },
      layers: [
        {
          id: 'back',
          type: 'background',
          enabled: true,
          zIndex: 1,
          localPath: 'assets/studio/studio_back.png',
          rect: { x: 0, y: 0, width: 1920, height: 1080 },
          fit: 'cover'
        },
        {
          id: 'back',
          type: 'presenter',
          enabled: true,
          zIndex: 1,
          mode: 'pip',
          rect: { x: 1800, y: 0, width: 400, height: 200 }
        }
      ]
    }, 'scenes.scene-1.composition', project, errors, warnings);

    const codes = collectCodes(errors);
    expect(codes).toContain('scene.composition.version.invalid');
    expect(codes).toContain('scene.composition.preset.invalid');
    expect(codes).toContain('scene.composition.layer.id.duplicate');
    expect(codes).toContain('scene.composition.layer.zIndex.duplicate');
    expect(codes).toContain('scene.composition.rect.bounds');
  });

  it('requires an explicit PiP rect or named intro/news preset', () => {
    const errors: RenderIssue[] = [];
    const warnings: RenderIssue[] = [];
    const project = makeProject([makeScene('scene-1', { kind: 'blank' })]);

    validateSceneComposition({
      version: 1,
      layers: [
        {
          id: 'presenter',
          type: 'presenter',
          enabled: true,
          zIndex: 20,
          mode: 'pip'
        }
      ]
    }, 'scenes.scene-1.composition', project, errors, warnings);

    expect(collectCodes(errors)).toContain('scene.composition.presenter.pip.missing');
  });
});

describe('scene composition patch shape', () => {
  it('rejects a non-object composition and non-array layers', () => {
    const invalidObject = collectProjectPatchShapeIssues({
      scenes: [{ composition: 'studio' }]
    });
    const invalidLayers = collectProjectPatchShapeIssues({
      scenes: [{ composition: { version: 1, layers: {} } }]
    });

    expect(invalidObject.some((issue) => issue.code === 'scene.composition.invalid')).toBe(true);
    expect(invalidLayers.some((issue) => issue.code === 'scene.composition.layers.invalid')).toBe(true);
  });
});

describe('scene composition render plan', () => {
  it('does not attach composition onto scenes without it', () => {
    const project = makeProject([makeScene('scene-1', { kind: 'blank' })]);
    const plan = resolveRenderPlan(project);
    expect(plan.scenes[0].composition).toBeUndefined();
    expect(plan.scenes[0].status).toBe('renderable');
  });

  it('resolves studio layers, presenter clip, and bakes presenter out of final compose', () => {
    const composition = createStudioComposition({
      backgroundAssetId: 'studio_back',
      imageAssetId: 'screen',
      imageLocalPath: 'assets/studio/screen.png',
      foregroundAssetId: 'studio_desk',
      presenterMode: 'full_canvas'
    });
    const project = makeProject(
      [makeScene('scene-1', { kind: 'blank' }, { composition })],
      {
        assets: [
          makeAsset('studio_back'),
          makeAsset('studio_desk'),
          makeAsset('screen', { localPath: 'assets/studio/screen.png', width: 1346, height: 761 }),
          makeAsset('presenter-1', {
            type: 'video',
            filename: 'presenter.webm',
            localPath: 'assets/presenter.webm',
            mimeType: 'video/webm'
          })
        ],
        presenterClips: [
          {
            sceneId: 'scene-1',
            status: 'generated',
            provider: 'mock',
            outputFormat: 'webm',
            audioAssetId: '',
            narrationSignature: '',
            duration: 2,
            assetId: 'presenter-1'
          }
        ]
      }
    );

    const plan = resolveRenderPlan(project);
    expect(plan.scenes[0].status).toBe('renderable');
    expect(plan.scenes[0].composition?.canvas).toEqual(STUDIO_COMPOSITION_CANVAS);
    expect(plan.scenes[0].composition?.layers.map((layer) => layer.id)).toEqual([
      STUDIO_LAYER_IDS.background,
      STUDIO_LAYER_IDS.image,
      STUDIO_LAYER_IDS.presenter,
      STUDIO_LAYER_IDS.foreground
    ]);
    const presenter = plan.scenes[0].composition?.layers.find((layer) => layer.type === 'presenter');
    expect(presenter).toMatchObject({
      enabled: true,
      assetPath: 'assets/presenter.webm',
      mode: 'full_canvas',
      mediaKind: 'video'
    });
    expect(sceneBakesPresenter(project.scenes[0].composition)).toBe(true);

    const withComposition = createSceneRenderFingerprint(plan, plan.scenes[0]);
    const without = createSceneRenderFingerprint(plan, { ...plan.scenes[0], composition: undefined });
    expect(withComposition).not.toBe(without);
  });

  it('marks unsafe composition paths as invalid on the render plan', () => {
    const project = makeProject([
      makeScene('scene-1', { kind: 'blank' }, {
        composition: createStudioComposition({
          backgroundLocalPath: '../secret.png',
          imageAssetId: 'screen',
          foregroundAssetId: 'studio_desk'
        })
      })
    ]);
    const plan = resolveRenderPlan(project);
    expect(plan.scenes[0].status).toBe('invalid');
    expect(plan.scenes[0].issues.some((issue) => issue.code === 'scene.composition.asset.path.unsafe')).toBe(true);
  });
});
