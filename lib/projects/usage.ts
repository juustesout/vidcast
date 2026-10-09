import type { Project } from '@/lib/types/render';

export function getAssetUsage(project: Project, assetId: string): string[] {
  return project.scenes
    .filter((scene) => {
      const visual = scene.visual;
      if (!visual) {
        return false;
      }

      if (visual.kind === 'asset') {
        return visual.assetId === assetId;
      }

      if (visual.kind === 'generated_image' || visual.kind === 'generated_video') {
        return visual.assetId === assetId || visual.generation.assetId === assetId;
      }

      return false;
    })
    .map((scene) => scene.id);
}

export function getReferenceUsage(project: Project, referenceId: string): string[] {
  return project.scenes
    .filter((scene) => scene.referenceIds.includes(referenceId))
    .map((scene) => scene.id);
}
