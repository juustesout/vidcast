import { beforeEach, describe, expect, it, vi } from 'vitest';

import { attachAnimationToScene } from '@/lib/animation/attach-service';
import { AnimationError } from '@/lib/animation/errors';
import { STUDIO_BIGSCREEN_RECT, STUDIO_LAYER_IDS, STUDIO_OVERLAY_RECT } from '@/lib/render/scene-composition';
import { projectStore } from '@/lib/storage/project-store';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';

vi.mock('@/lib/storage/project-store', () => ({
  projectStore: {
    getProject: vi.fn(),
    mutateProject: vi.fn()
  }
}));

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset_chart',
    type: 'video',
    status: 'available',
    provenance: 'generated',
    filename: 'mc-northwind-arr-chart.mp4',
    localPath: 'assets/mc-northwind-arr-chart.mp4',
    mimeType: 'video/mp4',
    metadata: { animationTemplateId: 'northwind_arr_chart', animationDestination: 'bigscreen' },
    createdAt: new Date().toISOString(),
    ...overrides
  };
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

function makeProject(assets: Asset[], scene: Scene): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-1',
    title: 'P102.4',
    description: '',
    durationTarget: 5,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
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

describe('attachAnimationToScene', () => {
  beforeEach(() => {
    vi.mocked(projectStore.getProject).mockReset();
    vi.mocked(projectStore.mutateProject).mockReset();
  });

  it('writes the chart onto studio-screen without touching presenter or desk', async () => {
    const asset = makeAsset();
    const scene = makeScene();
    const project = makeProject([asset], scene);
    vi.mocked(projectStore.getProject).mockResolvedValue(project);
    vi.mocked(projectStore.mutateProject).mockImplementation(async (_id, mutator) => mutator(project));

    const result = await attachAnimationToScene({
      projectId: 'project-1',
      sceneId: 'scene-1',
      assetId: asset.id,
      destination: 'bigscreen',
      startSeconds: 0,
      durationSeconds: 5
    });

    expect(result.layerId).toBe(STUDIO_LAYER_IDS.image);
    expect(result.rect).toEqual(STUDIO_BIGSCREEN_RECT);
    const updated = await vi.mocked(projectStore.mutateProject).mock.results[0].value as Project;
    const composition = updated.scenes[0].composition;
    const image = composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.image);
    const presenter = composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.presenter);
    const desk = composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.foreground);
    expect(image).toMatchObject({
      type: 'image',
      localPath: 'assets/mc-northwind-arr-chart.mp4',
      startSeconds: 0,
      durationSeconds: 5
    });
    expect(presenter?.type).toBe('presenter');
    expect(desk?.type).toBe('foreground');
  });

  it('writes Nix onto studio-overlay at the P102.2 rect', async () => {
    const asset = makeAsset({
      id: 'asset_overlay',
      filename: 'mc-nix-overlay.webm',
      localPath: 'assets/mc-nix-overlay.webm',
      mimeType: 'video/webm',
      metadata: { animationTemplateId: 'nix_overlay', animationDestination: 'overlay' }
    });
    const scene = makeScene();
    const project = makeProject([asset], scene);
    vi.mocked(projectStore.getProject).mockResolvedValue(project);
    vi.mocked(projectStore.mutateProject).mockImplementation(async (_id, mutator) => mutator(project));

    const result = await attachAnimationToScene({
      projectId: 'project-1',
      sceneId: 'scene-1',
      assetId: asset.id,
      destination: 'overlay',
      startSeconds: 0.2,
      durationSeconds: 4
    });

    expect(result.layerId).toBe(STUDIO_LAYER_IDS.overlay);
    expect(result.rect).toEqual(STUDIO_OVERLAY_RECT);
  });

  it('does not attach when the asset path is unsafe', async () => {
    const asset = makeAsset({ localPath: '/tmp/evil.mp4' });
    const project = makeProject([asset], makeScene());
    vi.mocked(projectStore.getProject).mockResolvedValue(project);

    await expect(attachAnimationToScene({
      projectId: 'project-1',
      sceneId: 'scene-1',
      assetId: asset.id,
      destination: 'bigscreen'
    })).rejects.toMatchObject({ code: 'animation.path.unsafe' } satisfies Partial<AnimationError>);
    expect(projectStore.mutateProject).not.toHaveBeenCalled();
  });
});
