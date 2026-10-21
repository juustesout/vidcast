import { beforeEach, describe, expect, it, vi } from 'vitest';

import { attachAnimationToScene } from '@/lib/animation/attach-service';
import { createStudioComposition, STUDIO_BIGSCREEN_RECT, STUDIO_LAYER_IDS, STUDIO_OVERLAY_RECT } from '@/lib/render/scene-composition';
import { applyStudioPresetAssets, resolveStudioAssets } from '@/lib/render/studio-asset-resolver';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { projectStore } from '@/lib/storage/project-store';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';
import { validateProject } from '@/lib/validation/project-validation';

vi.mock('@/lib/storage/project-store', () => ({
  projectStore: {
    getProject: vi.fn(),
    mutateProject: vi.fn()
  }
}));

const NOW = '2026-10-21T00:00:00.000Z';

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

function studioStill(role: 'back' | 'desk' | 'intro' | 'outtro', fileName: string): Asset {
  return makeAsset(`asset_${role}`, {
    filename: fileName,
    originalFilename: fileName,
    localPath: `assets/studio/${fileName}`,
    metadata: { studioRole: role }
  });
}

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    order: 1,
    duration: 5,
    type: 'blank',
    visual: { kind: 'blank' },
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: '',
    ...overrides
  };
}

function makeProject(scenes: Scene[], assets: Asset[], overrides: Partial<Project> = {}): Project {
  return normalizeProject({
    id: 'project-studio-wire',
    title: 'Studio wiring',
    description: '',
    durationTarget: 5,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: NOW,
    updatedAt: NOW,
    narration: { text: '', segments: [] },
    scenes,
    assets,
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

describe('resolveStudioAssets', () => {
  it('recognizes imported stills by studioRole and filename', () => {
    const assets = [
      studioStill('back', 'studio_back.png'),
      studioStill('desk', 'studio_desk.png'),
      studioStill('intro', 'studio_intro.png'),
      studioStill('outtro', 'studio_outtro.png'),
      makeAsset('stock_extra', { metadata: { studioRole: 'stock' } })
    ];
    const resolved = resolveStudioAssets(assets);
    expect(resolved.back?.filename).toBe('studio_back.png');
    expect(resolved.desk?.filename).toBe('studio_desk.png');
    expect(resolved.intro?.filename).toBe('studio_intro.png');
    expect(resolved.outtro?.filename).toBe('studio_outtro.png');
  });
});

describe('applyStudioPresetAssets', () => {
  it('binds back and desk onto a studio preset with correct z-order', () => {
    const back = studioStill('back', 'studio_back.png');
    const desk = studioStill('desk', 'studio_desk.png');
    const composition = applyStudioPresetAssets(
      { version: 1, preset: 'studio', layers: [] },
      [back, desk]
    );
    const byId = Object.fromEntries((composition?.layers ?? []).map((layer) => [layer.id, layer]));
    expect(byId[STUDIO_LAYER_IDS.background]).toMatchObject({
      type: 'background',
      enabled: true,
      zIndex: 0,
      assetId: back.id,
      localPath: 'assets/studio/studio_back.png',
      rect: { x: 0, y: 0, width: 1920, height: 1080 }
    });
    expect(byId[STUDIO_LAYER_IDS.foreground]).toMatchObject({
      type: 'foreground',
      enabled: true,
      zIndex: 30,
      assetId: desk.id,
      localPath: 'assets/studio/studio_desk.png'
    });
  });

  it('disables missing back and desk without blocking other layers', () => {
    const composition = applyStudioPresetAssets(createStudioComposition({ overlayEnabled: false }), []);
    const back = composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.background);
    const desk = composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.foreground);
    const presenter = composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.presenter);
    expect(back).toMatchObject({ enabled: false, assetId: undefined, localPath: undefined });
    expect(desk).toMatchObject({ enabled: false, assetId: undefined, localPath: undefined });
    expect(presenter).toMatchObject({ type: 'presenter', enabled: true });
  });

  it('keeps existing chart and Nix animation layers', () => {
    const base = createStudioComposition({
      imageAssetId: 'chart-1',
      imageLocalPath: 'assets/mc-northwind-arr-chart.mp4',
      imageStartSeconds: 0,
      imageDurationSeconds: 5,
      overlayAssetId: 'nix-1',
      overlayLocalPath: 'assets/mc-nix-overlay.webm',
      overlayStartSeconds: 0.2,
      overlayDurationSeconds: 4
    });
    const wired = applyStudioPresetAssets(base, [
      studioStill('back', 'studio_back.png'),
      studioStill('desk', 'studio_desk.png')
    ]);
    const screen = wired?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.image);
    const overlay = wired?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.overlay);
    expect(screen).toMatchObject({
      assetId: 'chart-1',
      localPath: 'assets/mc-northwind-arr-chart.mp4',
      startSeconds: 0,
      durationSeconds: 5,
      rect: STUDIO_BIGSCREEN_RECT,
      zIndex: 10
    });
    expect(overlay).toMatchObject({
      assetId: 'nix-1',
      localPath: 'assets/mc-nix-overlay.webm',
      startSeconds: 0.2,
      durationSeconds: 4,
      rect: STUDIO_OVERLAY_RECT,
      zIndex: 25
    });
  });

  it('does not overwrite a manually bound background', () => {
    const composition = createStudioComposition({
      backgroundAssetId: 'custom-back',
      backgroundLocalPath: 'assets/studio/custom_back.png'
    });
    const wired = applyStudioPresetAssets(composition, [studioStill('back', 'studio_back.png')]);
    const back = wired?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.background);
    expect(back).toMatchObject({
      assetId: 'custom-back',
      localPath: 'assets/studio/custom_back.png'
    });
  });
});

describe('studio preset production wiring', () => {
  it('wires imported stills through normalize, validation, and the render plan', () => {
    const assets = [
      studioStill('back', 'studio_back.png'),
      studioStill('desk', 'studio_desk.png'),
      studioStill('intro', 'studio_intro.png'),
      studioStill('outtro', 'studio_outtro.png')
    ];
    const project = makeProject(
      [makeScene({ composition: { version: 1, preset: 'studio', layers: [] } })],
      assets
    );

    const back = project.scenes[0].composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.background);
    const desk = project.scenes[0].composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.foreground);
    expect(back).toMatchObject({ enabled: true, assetId: assets[0].id, zIndex: 0 });
    expect(desk).toMatchObject({ enabled: true, assetId: assets[1].id, zIndex: 30 });

    const validation = validateProject(project);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.warnings.some((issue) => issue.code === 'studio.asset.intro.unused')).toBe(true);
    expect(validation.warnings.some((issue) => issue.code === 'studio.asset.outtro.unused')).toBe(true);

    const plan = resolveRenderPlan(project);
    expect(plan.scenes[0].status).toBe('renderable');
    expect(plan.scenes[0].composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.background)).toMatchObject({
      enabled: true,
      assetPath: 'assets/studio/studio_back.png'
    });
    expect(plan.scenes[0].composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.foreground)).toMatchObject({
      enabled: true,
      assetPath: 'assets/studio/studio_desk.png'
    });
    expect(plan.scenes[0].composition?.layers.some((layer) => layer.assetPath?.includes('studio_intro'))).toBe(false);
    expect(plan.scenes[0].composition?.layers.some((layer) => layer.assetPath?.includes('studio_outtro'))).toBe(false);
  });

  it('does not block production when back and desk are missing', () => {
    const project = makeProject(
      [makeScene({ composition: createStudioComposition({ overlayEnabled: false }) })],
      []
    );
    const validation = validateProject(project);
    expect(validation.valid).toBe(true);
    const plan = resolveRenderPlan(project);
    expect(plan.scenes[0].status).toBe('renderable');
    expect(plan.scenes[0].composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.background)?.enabled).toBe(false);
    expect(plan.scenes[0].composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.foreground)?.enabled).toBe(false);
  });

  it('leaves scenes without a composition unchanged', () => {
    const project = makeProject(
      [makeScene()],
      [studioStill('back', 'studio_back.png'), studioStill('desk', 'studio_desk.png')]
    );
    expect(project.scenes[0].composition).toBeUndefined();
    expect(resolveRenderPlan(project).scenes[0].composition).toBeUndefined();
  });
});

describe('attachAnimationToScene studio wiring', () => {
  beforeEach(() => {
    vi.mocked(projectStore.getProject).mockReset();
    vi.mocked(projectStore.mutateProject).mockReset();
  });

  it('binds imported stills when creating a studio composition for a chart attach', async () => {
    const back = studioStill('back', 'studio_back.png');
    const desk = studioStill('desk', 'studio_desk.png');
    const chart = makeAsset('asset_chart', {
      type: 'video',
      filename: 'mc-northwind-arr-chart.mp4',
      localPath: 'assets/mc-northwind-arr-chart.mp4',
      mimeType: 'video/mp4',
      metadata: { animationTemplateId: 'northwind_arr_chart', animationDestination: 'bigscreen' }
    });
    const scene = makeScene();
    const project = makeProject([scene], [back, desk, chart]);
    vi.mocked(projectStore.getProject).mockResolvedValue(project);
    vi.mocked(projectStore.mutateProject).mockImplementation(async (_id, mutator) => mutator(project));

    await attachAnimationToScene({
      projectId: project.id,
      sceneId: scene.id,
      assetId: chart.id,
      destination: 'bigscreen',
      startSeconds: 0,
      durationSeconds: 5
    });

    const updated = await vi.mocked(projectStore.mutateProject).mock.results[0].value as Project;
    const composition = updated.scenes[0].composition;
    expect(composition?.preset).toBe('studio');
    expect(composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.background)).toMatchObject({
      assetId: back.id,
      localPath: back.localPath
    });
    expect(composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.foreground)).toMatchObject({
      assetId: desk.id,
      localPath: desk.localPath
    });
    expect(composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.image)).toMatchObject({
      assetId: chart.id,
      localPath: chart.localPath,
      startSeconds: 0,
      durationSeconds: 5
    });
  });
});
