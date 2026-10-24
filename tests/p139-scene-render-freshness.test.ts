import fs from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHtmlStillFingerprint } from '@/lib/render/html-still/fingerprint';
import { HtmlStillError } from '@/lib/render/html-still/errors';
import { resolveHtmlStillImages } from '@/lib/render/html-still/image-assets';
import { renderSceneHtmlStill } from '@/lib/render/html-still/service';
import { SceneRenderError, type Renderer, type SceneRenderOptions } from '@/lib/render/renderer';
import { SceneRenderService } from '@/lib/render/scene-render-service';
import { projectStore } from '@/lib/storage/project-store';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import type { Asset } from '@/lib/types/asset';
import type { Project, RenderPlan, SceneRenderResult } from '@/lib/types/render';
import type { HtmlVisual, Scene } from '@/lib/types/scene';

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

const NOW = '2026-10-22T00:00:00.000Z';
const PROJECT_ID = 'project-p139-scene-render';

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

function makeProject(scene: Scene, assets: Asset[]): Project {
  return {
    id: PROJECT_ID,
    title: 'P139 scene render freshness',
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

class RecordingRenderer implements Renderer {
  readonly plans: RenderPlan[] = [];

  async render(plan: RenderPlan, options?: SceneRenderOptions): Promise<SceneRenderResult> {
    this.plans.push(plan);
    if (!options) {
      throw new Error('Render options are required.');
    }
    return {
      renderId: options.renderId,
      sceneId: options.sceneId,
      outputPath: options.outputPath,
      createdAt: NOW,
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      duration: plan.scenes[0]?.duration ?? 4,
      filesize: 100,
      mimeType: 'video/mp4',
      renderer: 'ffmpeg',
      status: 'completed'
    };
  }
}

describe('P139 direct scene_render freshness guard', () => {
  let project: Project;
  let renderer: RecordingRenderer;
  let service: SceneRenderService;

  beforeEach(() => {
    renderer = new RecordingRenderer();
    service = new SceneRenderService(renderer);
    vi.mocked(resolveHtmlStillImages).mockResolvedValue([]);
    vi.mocked(renderSceneHtmlStill).mockImplementation(async (_projectId, sceneId) => {
      const scene = project.scenes.find((entry) => entry.id === sceneId);
      const visual = scene?.visual;
      if (!scene || visual?.kind !== 'html') {
        throw new Error('not html');
      }
      const images = await resolveHtmlStillImages(project, visual);
      visual.fingerprint = createHtmlStillFingerprint(visual, images);
      visual.assetId = visual.assetId ?? 'html-1';
      if (!project.assets.some((asset) => asset.id === visual.assetId)) {
        project.assets.push(makeAsset(visual.assetId));
      }
      return {
        sceneId,
        assetId: visual.assetId,
        localPath: 'assets/html-1.png',
        fingerprint: visual.fingerprint,
        width: 1920,
        height: 1080,
        reused: false
      };
    });
    vi.spyOn(projectStore, 'getProject').mockImplementation(async () => project);
    vi.spyOn(projectStore, 'mutateProject').mockImplementation(async (_id, mutator) => {
      project = await mutator(structuredClone(project));
      return project;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(resolveHtmlStillImages).mockReset();
    vi.mocked(renderSceneHtmlStill).mockReset();
    await fs.rm(getProjectRoot(PROJECT_ID), { recursive: true, force: true });
  });

  it('refreshes a stale HTML still after templateData change before baking the MP4', async () => {
    const visual = makeHtmlVisual({
      templateData: { title: 'Changed' },
      fingerprint: createHtmlStillFingerprint(makeHtmlVisual({ templateData: { title: 'Live' } }))
    });
    project = makeProject(makeHtmlScene(visual), [makeAsset('html-1')]);

    const result = await service.renderScene(PROJECT_ID, 'scene-html');

    expect(renderSceneHtmlStill).toHaveBeenCalledTimes(1);
    expect(renderSceneHtmlStill).toHaveBeenCalledWith(PROJECT_ID, 'scene-html');
    expect(renderer.plans).toHaveLength(1);
    expect(renderer.plans[0].scenes[0].source.htmlFingerprint).toBe(createHtmlStillFingerprint(visual));
    expect(result.render.status).toBe('completed');
    expect(project.scenes[0].renders?.[0]?.status).toBe('completed');
  });

  it('refreshes after HTML or CSS markup changes before baking the MP4', async () => {
    const visual = makeHtmlVisual({
      template: undefined,
      html: '<div>New</div>',
      css: '.card{color:#fff}',
      fingerprint: createHtmlStillFingerprint({
        html: '<div>Old</div>',
        css: '.card{color:#000}',
        width: 1920,
        height: 1080,
        background: 'opaque'
      })
    });
    project = makeProject(makeHtmlScene(visual), [makeAsset('html-1')]);

    await service.renderScene(PROJECT_ID, 'scene-html');

    expect(renderSceneHtmlStill).toHaveBeenCalledTimes(1);
    expect(renderer.plans).toHaveLength(1);
    expect(renderer.plans[0].scenes[0].source.html).toBe('<div>New</div>');
    expect(renderer.plans[0].scenes[0].source.css).toBe('.card{color:#fff}');
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

    await service.renderScene(PROJECT_ID, 'scene-html');

    expect(renderSceneHtmlStill).toHaveBeenCalledTimes(1);
    expect(renderer.plans).toHaveLength(1);
    expect(renderer.plans[0].scenes[0].source.htmlFingerprint).toContain('bbb');
    expect(project.scenes[0].renders?.[0]?.status).toBe('completed');
  });

  it('does not call html_render when the still is already current', async () => {
    const visual = makeHtmlVisual({
      fingerprint: createHtmlStillFingerprint(makeHtmlVisual())
    });
    project = makeProject(makeHtmlScene(visual), [makeAsset('html-1')]);

    await service.renderScene(PROJECT_ID, 'scene-html');

    expect(renderSceneHtmlStill).not.toHaveBeenCalled();
    expect(renderer.plans).toHaveLength(1);
  });

  it('fails closed on a missing HTML still image and does not bake an MP4', async () => {
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

    await expect(service.renderScene(PROJECT_ID, 'scene-html')).rejects.toMatchObject({
      name: 'SceneRenderError',
      code: 'MISSING_ASSET',
      details: 'html.image.missing'
    });
    expect(renderSceneHtmlStill).not.toHaveBeenCalled();
    expect(renderer.plans).toHaveLength(0);
    expect(project.scenes[0].renders ?? []).toHaveLength(0);
  });

  it('fails closed when HTML still remains stale after one refresh', async () => {
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

    await expect(service.renderScene(PROJECT_ID, 'scene-html')).rejects.toBeInstanceOf(SceneRenderError);
    expect(renderSceneHtmlStill).toHaveBeenCalledTimes(1);
    expect(renderer.plans).toHaveLength(0);
    expect(project.scenes[0].renders ?? []).toHaveLength(0);
  });

  it('does not run html_render for non-HTML scenes', async () => {
    project = makeProject({
      id: 'scene-blank',
      order: 1,
      duration: 4,
      type: 'blank',
      visual: { kind: 'blank' },
      render: { motion: { preset: 'none' }, transition: { type: 'none' } },
      overlay: { type: 'none' },
      referenceIds: [],
      notes: '',
      renders: []
    }, []);

    await service.renderScene(PROJECT_ID, 'scene-blank');

    expect(renderSceneHtmlStill).not.toHaveBeenCalled();
    expect(renderer.plans).toHaveLength(1);
    expect(renderer.plans[0].scenes[0].source.kind).toBe('blank');
  });
});
