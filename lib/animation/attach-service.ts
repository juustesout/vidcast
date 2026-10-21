import {
  createStudioComposition,
  isSafeAssetPath,
  STUDIO_BIGSCREEN_RECT,
  STUDIO_LAYER_IDS,
  STUDIO_OVERLAY_RECT
} from '@/lib/render/scene-composition';
import { applyStudioPresetAssets } from '@/lib/render/studio-asset-resolver';
import type { Asset } from '@/lib/types/asset';
import { projectStore } from '@/lib/storage/project-store';
import type { SceneCompositionLayer, SceneCompositionMediaLayer, SceneCompositionOverlayLayer, SceneCompositionRect, SceneCompositionSpec } from '@/lib/types/scene-composition';
import type { Scene } from '@/lib/types/scene';
import { AnimationError } from './errors';
import type { AnimationAttachInput, AnimationAttachResult, AnimationDestination } from './types';
import { validateAnimationAttachInput } from './validate';

function cloneRect(rect: SceneCompositionRect): SceneCompositionRect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function defaultRect(destination: AnimationDestination): SceneCompositionRect {
  return destination === 'overlay' ? cloneRect(STUDIO_OVERLAY_RECT) : cloneRect(STUDIO_BIGSCREEN_RECT);
}

function scaleRect(base: SceneCompositionRect, scale: number): SceneCompositionRect {
  const width = Math.max(1, Math.round(base.width * scale));
  const height = Math.max(1, Math.round(base.height * scale));
  return {
    x: base.x + Math.round((base.width - width) / 2),
    y: base.y + Math.round((base.height - height) / 2),
    width,
    height
  };
}

function resolveRect(input: AnimationAttachInput): SceneCompositionRect {
  if (input.rect) {
    return cloneRect(input.rect);
  }
  const base = defaultRect(input.destination);
  const scaled = input.scale === undefined ? base : scaleRect(base, input.scale);
  if (input.position) {
    return { ...scaled, x: input.position.x, y: input.position.y };
  }
  return scaled;
}

function replaceOrInsertLayer(layers: SceneCompositionLayer[], next: SceneCompositionLayer): SceneCompositionLayer[] {
  const index = layers.findIndex((layer) => layer.id === next.id);
  if (index >= 0) {
    const copy = layers.slice();
    copy[index] = next;
    return copy;
  }
  return [...layers, next];
}

function studioBaseFromScene(scene: Scene, assets: readonly Asset[]): SceneCompositionSpec {
  const existing = scene.composition;
  const base = existing?.preset === 'studio'
    ? { ...existing, layers: existing.layers.slice() }
    : createStudioComposition({
        imageLocalPath: undefined,
        overlayEnabled: false
      });
  return applyStudioPresetAssets(base, assets) ?? base;
}

export async function attachAnimationToScene(raw: unknown): Promise<AnimationAttachResult> {
  const input = validateAnimationAttachInput(raw);
  const project = await projectStore.getProject(input.projectId);
  if (!project) {
    throw new AnimationError('animation.project.notFound', 'Project not found.', { projectId: input.projectId });
  }

  const scene = project.scenes.find((entry) => entry.id === input.sceneId);
  if (!scene) {
    throw new AnimationError('animation.scene.notFound', 'Scene not found.', {
      projectId: input.projectId,
      sceneId: input.sceneId
    });
  }

  const asset = project.assets.find((entry) => entry.id === input.assetId);
  if (!asset?.localPath) {
    throw new AnimationError('animation.asset.notFound', 'Animation asset not found.', {
      projectId: input.projectId,
      assetId: input.assetId
    });
  }
  if (!isSafeAssetPath(asset.localPath)) {
    throw new AnimationError('animation.path.unsafe', 'Animation asset path is not a safe project-relative assets/ path.', {
      localPath: asset.localPath
    });
  }

  const expectedDestination = asset.metadata?.animationDestination;
  if (expectedDestination && expectedDestination !== input.destination) {
    throw new AnimationError(
      'animation.destination.unsupported',
      `Asset destination is ${expectedDestination}; cannot attach as ${input.destination}.`,
      { assetId: asset.id, destination: input.destination, expectedDestination }
    );
  }

  const rect = resolveRect(input);
  const layerId = input.destination === 'overlay' ? STUDIO_LAYER_IDS.overlay : STUDIO_LAYER_IDS.image;

  const persisted = await projectStore.mutateProject(input.projectId, (current) => {
    const currentScene = current.scenes.find((entry) => entry.id === input.sceneId);
    if (!currentScene) {
      throw new AnimationError('animation.scene.notFound', 'Scene not found.', {
        projectId: input.projectId,
        sceneId: input.sceneId
      });
    }

    const composition = studioBaseFromScene(currentScene, current.assets);
    if (input.destination === 'overlay') {
      const overlay: SceneCompositionOverlayLayer = {
        id: STUDIO_LAYER_IDS.overlay,
        type: 'overlay',
        enabled: true,
        zIndex: 25,
        assetId: asset.id,
        localPath: asset.localPath,
        rect,
        fit: 'contain',
        ...(input.startSeconds !== undefined ? { startSeconds: input.startSeconds } : {}),
        ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {})
      };
      composition.layers = replaceOrInsertLayer(composition.layers, overlay);
    } else {
      const image: SceneCompositionMediaLayer = {
        id: STUDIO_LAYER_IDS.image,
        type: 'image',
        enabled: true,
        zIndex: 10,
        assetId: asset.id,
        localPath: asset.localPath,
        rect,
        fit: 'contain',
        ...(input.startSeconds !== undefined ? { startSeconds: input.startSeconds } : {}),
        ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {})
      };
      composition.layers = replaceOrInsertLayer(composition.layers, image);
    }

    return {
      ...current,
      scenes: current.scenes.map((entry) => (entry.id === input.sceneId ? { ...entry, composition } : entry))
    };
  });

  if (!persisted) {
    throw new AnimationError('animation.project.notFound', 'Project not found.', { projectId: input.projectId });
  }

  return {
    projectId: input.projectId,
    sceneId: input.sceneId,
    assetId: asset.id,
    localPath: asset.localPath,
    destination: input.destination,
    layerId,
    rect,
    startSeconds: input.startSeconds,
    durationSeconds: input.durationSeconds
  };
}
