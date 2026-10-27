import type { Project } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';
import { joinProjectFileUrl } from '@/lib/utils/project-files';

export function getSceneVisualAssetId(scene: Scene): string | undefined {
  if (!scene.visual) {
    return undefined;
  }
  if (scene.visual.kind === 'asset') {
    return scene.visual.assetId;
  }
  if (scene.visual.kind === 'generated_image' || scene.visual.kind === 'generated_video') {
    return scene.visual.assetId ?? scene.visual.generation.assetId;
  }
  if (scene.visual.kind === 'html' || scene.visual.kind === 'stock_image') {
    return scene.visual.assetId;
  }
  return undefined;
}

export function resolveSceneThumbUrl(project: Project, scene: Scene): string | undefined {
  const assetId = getSceneVisualAssetId(scene);
  const asset = assetId ? project.assets.find((entry) => entry.id === assetId) : undefined;
  if (!asset?.localPath) {
    return undefined;
  }
  if (asset.type !== 'image' && asset.type !== 'graphic') {
    return undefined;
  }
  return joinProjectFileUrl(project.id, asset.localPath);
}

export function sceneThumbPlaceholder(scene: Scene): string {
  return scene.visual?.kind ? scene.visual.kind.replace(/_/g, ' ') : scene.type;
}
