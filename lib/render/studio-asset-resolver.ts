import type { Asset } from '@/lib/types/asset';
import type {
  SceneCompositionLayer,
  SceneCompositionMediaLayer,
  SceneCompositionSpec
} from '@/lib/types/scene-composition';
import { SCENE_COMPOSITION_SCHEMA_VERSION } from '@/lib/types/scene-composition';
import {
  createStudioComposition,
  isSafeAssetPath,
  STUDIO_COMPOSITION_CANVAS,
  STUDIO_LAYER_IDS
} from './scene-composition';

export const STUDIO_STILL_ROLES = ['back', 'desk', 'intro', 'outtro'] as const;
export type StudioStillRole = (typeof STUDIO_STILL_ROLES)[number];

export const STUDIO_STILL_FILENAMES: Record<StudioStillRole, string> = {
  back: 'studio_back.png',
  desk: 'studio_desk.png',
  intro: 'studio_intro.png',
  outtro: 'studio_outtro.png'
};

const STUDIO_STILL_PATHS: Record<StudioStillRole, string> = {
  back: 'assets/studio/studio_back.png',
  desk: 'assets/studio/studio_desk.png',
  intro: 'assets/studio/studio_intro.png',
  outtro: 'assets/studio/studio_outtro.png'
};

export interface ResolvedStudioAssets {
  back?: Asset;
  desk?: Asset;
  intro?: Asset;
  outtro?: Asset;
}

function basename(value: string): string {
  const parts = value.split(/[/\\]/);
  return parts[parts.length - 1] ?? value;
}

function isUsableStudioAsset(asset: Asset): boolean {
  return Boolean(asset.localPath && isSafeAssetPath(asset.localPath));
}

function roleFromAsset(asset: Asset): StudioStillRole | undefined {
  const metadataRole = asset.metadata?.studioRole;
  if (metadataRole === 'back' || metadataRole === 'desk' || metadataRole === 'intro' || metadataRole === 'outtro') {
    return metadataRole;
  }

  const names = [asset.filename, asset.originalFilename, asset.localPath ? basename(asset.localPath) : undefined];
  for (const name of names) {
    if (name === STUDIO_STILL_FILENAMES.back || name === basename(STUDIO_STILL_PATHS.back)) {
      return 'back';
    }
    if (name === STUDIO_STILL_FILENAMES.desk) {
      return 'desk';
    }
    if (name === STUDIO_STILL_FILENAMES.intro) {
      return 'intro';
    }
    if (name === STUDIO_STILL_FILENAMES.outtro) {
      return 'outtro';
    }
  }

  if (asset.localPath === STUDIO_STILL_PATHS.back) {
    return 'back';
  }
  if (asset.localPath === STUDIO_STILL_PATHS.desk) {
    return 'desk';
  }
  if (asset.localPath === STUDIO_STILL_PATHS.intro) {
    return 'intro';
  }
  if (asset.localPath === STUDIO_STILL_PATHS.outtro) {
    return 'outtro';
  }

  return undefined;
}

export function resolveStudioAssets(assets: readonly Asset[]): ResolvedStudioAssets {
  const resolved: ResolvedStudioAssets = {};
  for (const asset of assets) {
    if (!isUsableStudioAsset(asset)) {
      continue;
    }
    const role = roleFromAsset(asset);
    if (!role || resolved[role]) {
      continue;
    }
    resolved[role] = asset;
  }
  return resolved;
}

function isMediaLayer(layer: SceneCompositionLayer): layer is SceneCompositionMediaLayer {
  return layer.type === 'background' || layer.type === 'image' || layer.type === 'foreground';
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

function layerHasManualBinding(layer: SceneCompositionLayer | undefined, roleAsset: Asset | undefined): boolean {
  if (!layer || !isMediaLayer(layer)) {
    return false;
  }
  if (layer.assetId && layer.assetId !== roleAsset?.id) {
    return true;
  }
  if (layer.localPath && layer.localPath !== roleAsset?.localPath && layer.localPath !== STUDIO_STILL_PATHS.back && layer.localPath !== STUDIO_STILL_PATHS.desk) {
    return true;
  }
  return false;
}

function bindStillLayer(
  layers: SceneCompositionLayer[],
  options: {
    id: string;
    type: 'background' | 'foreground';
    zIndex: number;
    asset?: Asset;
  }
): SceneCompositionLayer[] {
  const existing = layers.find((layer) => layer.id === options.id);
  if (layerHasManualBinding(existing, options.asset)) {
    return layers;
  }

  if (!options.asset?.localPath || !isSafeAssetPath(options.asset.localPath)) {
    if (existing && isMediaLayer(existing) && existing.enabled !== false && !layerHasManualBinding(existing, options.asset)) {
      const knownDefault = existing.localPath === STUDIO_STILL_PATHS.back || existing.localPath === STUDIO_STILL_PATHS.desk;
      const unbound = !existing.assetId && (!existing.localPath || knownDefault);
      if (unbound) {
        return replaceOrInsertLayer(layers, {
          ...existing,
          enabled: false,
          assetId: undefined,
          localPath: undefined
        });
      }
    }
    return layers;
  }

  if (existing?.enabled === false && isMediaLayer(existing) && existing.localPath) {
    return layers;
  }

  const rect = existing && isMediaLayer(existing)
    ? existing.rect
    : { x: 0, y: 0, width: STUDIO_COMPOSITION_CANVAS.width, height: STUDIO_COMPOSITION_CANVAS.height };

  const next: SceneCompositionMediaLayer = {
    id: options.id,
    type: options.type,
    enabled: true,
    zIndex: existing?.zIndex ?? options.zIndex,
    assetId: options.asset.id,
    localPath: options.asset.localPath,
    rect,
    fit: existing && isMediaLayer(existing) ? existing.fit : 'cover'
  };
  return replaceOrInsertLayer(layers, next);
}

export function applyStudioPresetAssets(
  composition: SceneCompositionSpec | undefined,
  assets: readonly Asset[]
): SceneCompositionSpec | undefined {
  if (!composition || composition.preset !== 'studio') {
    return composition;
  }

  const studio = resolveStudioAssets(assets);
  let layers = composition.layers.slice();

  if (layers.length === 0) {
    const built = createStudioComposition({
      backgroundAssetId: studio.back?.id,
      backgroundLocalPath: studio.back?.localPath,
      foregroundAssetId: studio.desk?.id,
      foregroundLocalPath: studio.desk?.localPath,
      deskEnabled: Boolean(studio.desk),
      overlayEnabled: false
    });
    layers = built.layers;
  }

  layers = bindStillLayer(layers, {
    id: STUDIO_LAYER_IDS.background,
    type: 'background',
    zIndex: 0,
    asset: studio.back
  });
  layers = bindStillLayer(layers, {
    id: STUDIO_LAYER_IDS.foreground,
    type: 'foreground',
    zIndex: 30,
    asset: studio.desk
  });

  return {
    ...composition,
    version: composition.version ?? SCENE_COMPOSITION_SCHEMA_VERSION,
    canvas: composition.canvas ?? STUDIO_COMPOSITION_CANVAS,
    layers
  };
}
