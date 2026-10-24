import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHtmlStillFingerprint } from '@/lib/render/html-still/fingerprint';
import { HtmlStillError } from '@/lib/render/html-still/errors';
import { resolveHtmlStillImages } from '@/lib/render/html-still/image-assets';
import { renderSceneHtmlStill } from '@/lib/render/html-still/service';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { sceneRenderService } from '@/lib/render/scene-render-service';
import { LocalFFmpegVideoCompositor } from '@/lib/render/video-compositor';
import { CompositionServiceError, videoCompositionService } from '@/lib/render/video-composition-service';
import { projectStore } from '@/lib/storage/project-store';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import type { Asset } from '@/lib/types/asset';
import type { Project, SceneRenderResult } from '@/lib/types/render';
import type { HtmlVisual, Scene, SceneRenderArtifact } from '@/lib/types/scene';
import type { StockSelection } from '@/lib/types/stock';

vi.mock('@/lib/render/html-still/service', () => ({
  renderSceneHtmlStill: vi.fn()
}));

vi.mock('@/lib/render/html-still/image-assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/render/html-still/image-assets')>();
  return {
    ...actual,
    resolveHtmlStillImages: vi.fn()
  };
});

vi.mock('@/lib/render/scene-render-service', () => ({
  sceneRenderService: {
    renderScene: vi.fn()
  }
}));

const NOW = '2026-10-22T00:00:00.000Z';
const PROJECT_ID = 'project-p137-compose';

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

function makeHtmlVisual(overrides: Partial<HtmlVisual> = {}): HtmlVisual {
  return {
    kind: 'html',
    template: 'headline_card',
    templateData: { title: 'Live' },
    width: 1920,
    height: 1080,
    background: 'opaque',
    assetId: 'html-1',
    ...overrides
  };
}

function makeProject(scene: Scene, assets: Asset[]): Project {
  return {
    id: PROJECT_ID,
    title: 'P137 compose freshness',
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

function makeHtmlScene(visual: HtmlVisual): Scene {
  return {
    id: 'scene-html',
    order: 1,
    duration: 4,
    type: 'html',
    visual,
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: '',
    renders: []
  };
}

function attachCurrentRender(project: Project, outputPath = 'renders/scene-html.mp4'): SceneRenderArtifact {
  const plan = resolveRenderPlan(project);
  const scene = project.scenes[0];
  const planScene = plan.scenes[0];
  const render: SceneRenderArtifact = {
    renderId: 'render-1',
    outputPath,
    createdAt: NOW,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    duration: scene.duration,
    filesize: 100,
    mimeType: 'video/mp4',
    renderer: 'ffmpeg',
    status: 'completed',
    renderFingerprint: createSceneRenderFingerprint(plan, planScene)
  };
  scene.renders = [render];
  return render;
}

function hotlinkSelection(imageUrl: string): StockSelection {
  return {
    provider: 'unsplash',
    photoId: 'abc',
    query: 'city',
    usagePolicy: 'hotlink',
    attribution: {
      provider: 'unsplash',
      providerName: 'Unsplash',
      photoId: 'abc',
      photographerName: 'Jane',
      sourceUrl: 'https://unsplash.com/photos/abc',
      license: 'Unsplash License'
    },
    sourceUrl: 'https://unsplash.com/photos/abc',
    imageUrl,
    width: 1200,
    height: 800,
    selectedAt: NOW,
    selectionKey: 'any::city'
  };
}

async function writeRenderFile(projectId: string, relativePath: string): Promise<void> {
  const full = path.join(getProjectRoot(projectId), relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, 'ok', 'utf8');
}

describe('P137 compose freshness guard', () => {
  let project: Project;

  beforeEach(() => {
    vi.mocked(resolveHtmlStillImages).mockResolvedValue([]);
    vi.mocked(renderSceneHtmlStill).mockImplementation(async (_projectId, sceneId) => {
      const scene = project.scenes.find((entry) => entry.id === sceneId);
      if (!scene || scene.visual?.kind !== 'html') {
        throw new Error('not html');
      }
      const images = await resolveHtmlStillImages(project, scene.visual);
      scene.visual.fingerprint = createHtmlStillFingerprint(scene.visual, images);
      scene.visual.assetId = scene.visual.assetId ?? 'html-1';
      return {
        sceneId,
        assetId: scene.visual.assetId,
        localPath: 'assets/html-1.png',
        fingerprint: scene.visual.fingerprint,
        width: 1920,
        height: 1080,
        reused: false
      };
    });
    vi.mocked(sceneRenderService.renderScene).mockImplementation(async (projectId, sceneId) => {
      const plan = resolveRenderPlan(project);
      const planScene = plan.scenes.find((entry) => entry.sceneId === sceneId)!;
      const scene = project.scenes.find((entry) => entry.id === sceneId)!;
      const render: SceneRenderResult = {
        renderId: 'render-new',
        sceneId,
        outputPath: scene.renders?.[0]?.outputPath ?? 'renders/scene-html.mp4',
        createdAt: NOW,
        width: plan.width,
        height: plan.height,
        fps: plan.fps,
        duration: scene.duration,
        filesize: 100,
        mimeType: 'video/mp4',
        renderer: 'ffmpeg',
        status: 'completed',
        renderFingerprint: createSceneRenderFingerprint(plan, planScene)
      };
      scene.renders = [render];
      return { projectId, sceneId, render };
    });
    vi.spyOn(projectStore, 'getProject').mockImplementation(async () => project);
    vi.spyOn(projectStore, 'mutateProject').mockImplementation(async (_id, mutator) => {
      project = await mutator(structuredClone(project));
      return project;
    });
    vi.spyOn(LocalFFmpegVideoCompositor.prototype, 'compose').mockImplementation(async (_plan, options) => {
      await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
      await fs.writeFile(options.outputPath, 'mp4');
      return { filesize: 4, duration: 4 };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(resolveHtmlStillImages).mockReset();
    vi.mocked(renderSceneHtmlStill).mockReset();
    vi.mocked(sceneRenderService.renderScene).mockReset();
    await fs.rm(getProjectRoot(PROJECT_ID), { recursive: true, force: true });
  });

  it('refreshes a stale HTML PNG from templateData before composing', async () => {
    const visual = makeHtmlVisual({
      templateData: { title: 'Changed' },
      fingerprint: createHtmlStillFingerprint(makeHtmlVisual({ templateData: { title: 'Live' } }))
    });
    project = makeProject(makeHtmlScene(visual), [makeAsset('html-1')]);
    attachCurrentRender(project);
    await writeRenderFile(PROJECT_ID, 'renders/scene-html.mp4');

    await videoCompositionService.composeProject(PROJECT_ID);

    expect(renderSceneHtmlStill).toHaveBeenCalledTimes(1);
    expect(renderSceneHtmlStill).toHaveBeenCalledWith(PROJECT_ID, 'scene-html');
    expect(sceneRenderService.renderScene).toHaveBeenCalledTimes(1);
    expect(sceneRenderService.renderScene).toHaveBeenCalledWith(PROJECT_ID, 'scene-html');
    expect(LocalFFmpegVideoCompositor.prototype.compose).toHaveBeenCalledTimes(1);
  });

  it('refreshes PNG and MP4 when used image bytes change at the same imageAssetId', async () => {
    const visualSpec = {
      template: 'product_card' as const,
      templateData: { name: 'Hub', imageAssetId: 'product-1' },
      width: 1920,
      height: 1080,
      background: 'opaque' as const
    };
    const visual = makeHtmlVisual({
      ...visualSpec,
      fingerprint: createHtmlStillFingerprint(visualSpec, [{ assetId: 'product-1', sha256: 'aaa' }])
    });
    vi.mocked(resolveHtmlStillImages).mockResolvedValue([
      { assetId: 'product-1', mimeType: 'image/png', dataUri: 'data:image/png;base64,AA==', sha256: 'bbb' }
    ]);
    project = makeProject(makeHtmlScene(visual), [makeAsset('html-1'), makeAsset('product-1')]);
    attachCurrentRender(project);
    await writeRenderFile(PROJECT_ID, 'renders/scene-html.mp4');

    await videoCompositionService.composeProject(PROJECT_ID);

    expect(renderSceneHtmlStill).toHaveBeenCalledTimes(1);
    expect(sceneRenderService.renderScene).toHaveBeenCalledTimes(1);
    expect(LocalFFmpegVideoCompositor.prototype.compose).toHaveBeenCalledTimes(1);
  });

  it('does not rerender HTML still or scene MP4 when inputs are unchanged', async () => {
    const visualSpec = {
      template: 'product_card' as const,
      templateData: { name: 'Hub', imageAssetId: 'product-1' },
      width: 1920,
      height: 1080,
      background: 'opaque' as const
    };
    const images = [{ assetId: 'product-1', mimeType: 'image/png' as const, dataUri: 'data:image/png;base64,AA==', sha256: 'aaa' }];
    const visual = makeHtmlVisual({
      ...visualSpec,
      fingerprint: createHtmlStillFingerprint(visualSpec, images)
    });
    vi.mocked(resolveHtmlStillImages).mockResolvedValue(images);
    project = makeProject(makeHtmlScene(visual), [makeAsset('html-1'), makeAsset('product-1')]);
    attachCurrentRender(project);
    await writeRenderFile(PROJECT_ID, 'renders/scene-html.mp4');

    await videoCompositionService.composeProject(PROJECT_ID);

    expect(renderSceneHtmlStill).not.toHaveBeenCalled();
    expect(sceneRenderService.renderScene).not.toHaveBeenCalled();
    expect(LocalFFmpegVideoCompositor.prototype.compose).toHaveBeenCalledTimes(1);
  });

  it('re-renders a hotlink scene when remoteUrl changes at the same dimensions', async () => {
    const scene: Scene = {
      id: 'scene-stock',
      order: 1,
      duration: 4,
      type: 'image',
      visual: { kind: 'stock_image', query: 'city', selection: hotlinkSelection('https://images.unsplash.com/abc?w=1200') },
      render: { motion: { preset: 'none' }, transition: { type: 'none' } },
      overlay: { type: 'none' },
      referenceIds: [],
      notes: '',
      renders: []
    };
    project = makeProject(scene, []);
    attachCurrentRender(project, 'renders/scene-stock.mp4');
    project.scenes[0].visual = {
      kind: 'stock_image',
      query: 'city',
      selection: hotlinkSelection('https://images.unsplash.com/xyz?w=1200')
    };
    await writeRenderFile(PROJECT_ID, 'renders/scene-stock.mp4');

    await videoCompositionService.composeProject(PROJECT_ID);

    expect(renderSceneHtmlStill).not.toHaveBeenCalled();
    expect(sceneRenderService.renderScene).toHaveBeenCalledTimes(1);
    expect(sceneRenderService.renderScene).toHaveBeenCalledWith(PROJECT_ID, 'scene-stock');
    expect(LocalFFmpegVideoCompositor.prototype.compose).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a missing HTML still image and does not compose a stale MP4', async () => {
    const visual = makeHtmlVisual({
      template: 'product_card',
      templateData: { name: 'Hub', imageAssetId: 'missing-image' },
      fingerprint: createHtmlStillFingerprint({
        template: 'product_card',
        templateData: { name: 'Hub', imageAssetId: 'missing-image' },
        width: 1920,
        height: 1080,
        background: 'opaque'
      })
    });
    vi.mocked(resolveHtmlStillImages).mockRejectedValue(
      new HtmlStillError('html.image.missing', 'HTML still image asset missing-image does not exist.', 400, { assetId: 'missing-image' })
    );
    project = makeProject(makeHtmlScene(visual), [makeAsset('html-1')]);
    attachCurrentRender(project);
    await writeRenderFile(PROJECT_ID, 'renders/scene-html.mp4');

    await expect(videoCompositionService.composeProject(PROJECT_ID)).rejects.toMatchObject({
      name: 'CompositionServiceError',
      code: 'INCOMPATIBLE_RENDER',
      details: 'html.image.missing'
    });
    expect(renderSceneHtmlStill).not.toHaveBeenCalled();
    expect(sceneRenderService.renderScene).not.toHaveBeenCalled();
    expect(LocalFFmpegVideoCompositor.prototype.compose).not.toHaveBeenCalled();
  });

  it('does not loop when HTML still remains stale after one refresh', async () => {
    const visual = makeHtmlVisual({
      templateData: { title: 'Changed' },
      fingerprint: createHtmlStillFingerprint(makeHtmlVisual({ templateData: { title: 'Live' } }))
    });
    vi.mocked(renderSceneHtmlStill).mockImplementation(async () => ({
      sceneId: 'scene-html',
      assetId: 'html-1',
      localPath: 'assets/html-1.png',
      fingerprint: visual.fingerprint ?? '',
      width: 1920,
      height: 1080,
      reused: false
    }));
    project = makeProject(makeHtmlScene(visual), [makeAsset('html-1')]);
    attachCurrentRender(project);
    await writeRenderFile(PROJECT_ID, 'renders/scene-html.mp4');

    await expect(videoCompositionService.composeProject(PROJECT_ID)).rejects.toBeInstanceOf(CompositionServiceError);
    expect(renderSceneHtmlStill).toHaveBeenCalledTimes(1);
    expect(sceneRenderService.renderScene).not.toHaveBeenCalled();
    expect(LocalFFmpegVideoCompositor.prototype.compose).not.toHaveBeenCalled();
  });
});
