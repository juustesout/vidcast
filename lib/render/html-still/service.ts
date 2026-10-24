import { isSafeAssetPath, STUDIO_BIGSCREEN_RECT, STUDIO_LAYER_IDS } from '@/lib/render/scene-composition';
import { applyStudioPresetAssets } from '@/lib/render/studio-asset-resolver';
import { mediaStore } from '@/lib/storage/media-store';
import { projectStore } from '@/lib/storage/project-store';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import type { HtmlVisual, Scene } from '@/lib/types/scene';
import type { SceneCompositionMediaLayer, SceneCompositionSpec } from '@/lib/types/scene-composition';
import { createId } from '@/lib/utils/ids';
import { renderHtmlStillPng } from './chromium-still';
import { HtmlStillError } from './errors';
import { createHtmlStillFingerprint, htmlStillAssetIsCurrent } from './fingerprint';
import { resolveHtmlStillImages } from './image-assets';
import { canonicalizeHtmlStillTemplateId, resolveHtmlStillTemplate } from './templates';

const activeLocks = new Set<string>();

export interface HtmlStillServiceResult {
  sceneId: string;
  assetId: string;
  localPath: string;
  fingerprint: string;
  width: number;
  height: number;
  reused: boolean;
}

function lockKey(projectId: string, sceneId: string): string {
  return `${projectId}:${sceneId}`;
}

function getScene(project: Project, sceneId: string): Scene {
  const scene = project.scenes.find((entry) => entry.id === sceneId);
  if (!scene) {
    throw new HtmlStillError('html.scene.notFound', `Scene ${sceneId} not found.`, 404);
  }
  return scene;
}

function ensureHtmlScene(scene: Scene): asserts scene is Scene & { visual: HtmlVisual } {
  if (!scene.visual || scene.visual.kind !== 'html') {
    throw new HtmlStillError('html.scene.invalidVisualKind', 'Scene is not an HTML still scene.', 400);
  }
}

function resolveDocument(visual: HtmlVisual): { markup: string; css?: string; pageBackground?: string } {
  if (visual.template) {
    if (!canonicalizeHtmlStillTemplateId(visual.template)) {
      throw new HtmlStillError('html.template.unknown', `Unknown HTML still template: ${visual.template}.`);
    }
    const resolved = resolveHtmlStillTemplate(visual.template, visual.templateData ?? {});
    return { markup: resolved.markup, css: resolved.css, pageBackground: resolved.background };
  }
  if (!visual.html?.trim()) {
    throw new HtmlStillError('html.invalid', 'HTML still requires a template or HTML markup.');
  }
  return { markup: visual.html, css: visual.css };
}

function replaceOrInsertImageLayer(composition: SceneCompositionSpec, asset: Asset): SceneCompositionSpec {
  const image: SceneCompositionMediaLayer = {
    id: STUDIO_LAYER_IDS.image,
    type: 'image',
    enabled: true,
    zIndex: 10,
    assetId: asset.id,
    localPath: asset.localPath,
    rect: (composition.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.image && layer.type === 'image') as SceneCompositionMediaLayer | undefined)?.rect
      ?? { ...STUDIO_BIGSCREEN_RECT },
    fit: 'contain'
  };
  const index = composition.layers.findIndex((layer) => layer.id === STUDIO_LAYER_IDS.image);
  const layers = composition.layers.slice();
  if (index >= 0) {
    layers[index] = { ...layers[index], ...image, rect: image.rect ?? layers[index].rect };
  } else {
    layers.push(image);
  }
  return { ...composition, layers };
}

function bindHtmlAsset(scene: Scene, assets: readonly Asset[], asset: Asset): SceneCompositionSpec | undefined {
  const existing = applyStudioPresetAssets(scene.composition, assets) ?? scene.composition;
  if (!existing || existing.preset !== 'studio') {
    return existing;
  }
  if (!asset.localPath || !isSafeAssetPath(asset.localPath)) {
    return existing;
  }
  return replaceOrInsertImageLayer(existing, asset);
}

export async function renderSceneHtmlStill(
  projectId: string,
  sceneId: string,
  options: { regenerate?: boolean } = {}
): Promise<HtmlStillServiceResult> {
  const key = lockKey(projectId, sceneId);
  if (activeLocks.has(key)) {
    throw new HtmlStillError('html.scene.alreadyRunning', 'HTML still render is already running for this scene.', 409);
  }
  activeLocks.add(key);

  try {
    const project = await projectStore.getProject(projectId);
    if (!project) {
      throw new HtmlStillError('html.project.notFound', 'Project not found.', 404);
    }

    const scene = getScene(project, sceneId);
    ensureHtmlScene(scene);
    const currentAsset = scene.visual.assetId
      ? project.assets.find((entry) => entry.id === scene.visual.assetId && entry.localPath)
      : undefined;
    const images = await resolveHtmlStillImages(project, scene.visual);
    const fingerprint = createHtmlStillFingerprint(scene.visual, images);

    if (!options.regenerate && currentAsset?.localPath && htmlStillAssetIsCurrent(scene.visual, images)) {
      return {
        sceneId,
        assetId: currentAsset.id,
        localPath: currentAsset.localPath,
        fingerprint,
        width: currentAsset.width ?? scene.visual.width ?? 1920,
        height: currentAsset.height ?? scene.visual.height ?? 1080,
        reused: true
      };
    }

    const width = scene.visual.width ?? 1920;
    const height = scene.visual.height ?? 1080;
    const background = scene.visual.background ?? 'opaque';
    const document = resolveDocument(scene.visual);
    const still = await renderHtmlStillPng({
      markup: document.markup,
      css: document.css,
      width,
      height,
      background,
      pageBackground: document.pageBackground,
      images
    });

    const file = new File([new Uint8Array(still.png)], `scene-${String(scene.order).padStart(2, '0')}-html-still.png`, {
      type: 'image/png'
    });
    const { asset } = await mediaStore.saveAsset(projectId, file);
    const storedAsset: Asset = {
      ...asset,
      provenance: 'generated',
      generation: {
        generationId: createId('html_still'),
        provider: 'chromium',
        model: scene.visual.template ?? 'html',
        prompt: scene.visual.template ?? 'html still',
        referenceIds: []
      },
      metadata: {
        ...asset.metadata,
        htmlStill: true,
        htmlFingerprint: fingerprint,
        htmlTemplate: scene.visual.template,
        htmlBackground: background
      }
    };

    const persisted = await projectStore.mutateProject(projectId, (current) => {
      const currentScene = current.scenes.find((entry) => entry.id === sceneId);
      if (!currentScene) {
        throw new HtmlStillError('html.scene.notFound', `Scene ${sceneId} not found.`, 404);
      }
      ensureHtmlScene(currentScene);
      const composition = bindHtmlAsset(currentScene, [...current.assets, storedAsset], storedAsset);
      return {
        ...current,
        assets: [...current.assets, storedAsset],
        scenes: current.scenes.map((entry) => {
          if (entry.id !== sceneId || entry.visual?.kind !== 'html') {
            return entry;
          }
          return {
            ...entry,
            visual: {
              ...entry.visual,
              kind: 'html' as const,
              assetId: storedAsset.id,
              fingerprint
            },
            ...(composition ? { composition } : {})
          };
        })
      };
    });

    if (!persisted) {
      throw new HtmlStillError('html.project.notFound', 'Project not found.', 404);
    }

    const stored = persisted.assets.find((entry) => entry.id === storedAsset.id);
    if (!stored?.localPath) {
      throw new HtmlStillError('html.output.incomplete', 'HTML still PNG was not stored as a project asset.');
    }

    return {
      sceneId,
      assetId: stored.id,
      localPath: stored.localPath,
      fingerprint,
      width: stored.width ?? width,
      height: stored.height ?? height,
      reused: false
    };
  } finally {
    activeLocks.delete(key);
  }
}
