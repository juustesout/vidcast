import type { Project } from '@/lib/types/render';

// Sentinel usage marker for project-level (non-scene) references such as the
// selected background music track. Kept non-scene so the UI's scene lookup
// inherently ignores it while deletion protection still sees a usage.
export const PROJECT_MUSIC_USAGE_ID = 'project:music';

export function getAssetUsage(project: Project, assetId: string): string[] {
  const sceneUsage = project.scenes
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

  if (project.music?.assetId === assetId) {
    sceneUsage.push(PROJECT_MUSIC_USAGE_ID);
  }

  return sceneUsage;
}

export function getReferenceUsage(project: Project, referenceId: string): string[] {
  return project.scenes
    .filter((scene) => scene.referenceIds.includes(referenceId))
    .map((scene) => scene.id);
}
