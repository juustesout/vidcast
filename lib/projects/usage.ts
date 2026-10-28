import { htmlStillSlotImageAssetIds } from '@/lib/projects/html-still-slot-images';
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

      if (visual.kind === 'stock_image') {
        return visual.assetId === assetId;
      }

      if (visual.kind === 'html') {
        return visual.assetId === assetId || htmlStillSlotImageAssetIds(visual).includes(assetId);
      }

      return false;
    })
    .map((scene) => scene.id);

  if (project.music?.assetId === assetId) {
    sceneUsage.push(PROJECT_MUSIC_USAGE_ID);
  }

  return sceneUsage;
}

/**
 * True when a scene consumes `referenceId` as a generation input.
 *
 * The scene-level list, the per-attempt generation snapshot and the keyframe
 * designations are distinct fields. The generation services prefer the snapshot
 * and fall back to the scene list, while a keyframe id can be the only remaining
 * pointer after a partial update. All of them count as usage so deleting a
 * reference can never leave a dangling generation input behind.
 */
function sceneUsesReference(scene: Project['scenes'][number], referenceId: string): boolean {
  if (scene.referenceIds.includes(referenceId)) {
    return true;
  }

  const visual = scene.visual;
  if (!visual || (visual.kind !== 'generated_image' && visual.kind !== 'generated_video')) {
    return false;
  }

  const generation = visual.generation;
  return (
    (generation.referenceIds ?? []).includes(referenceId) ||
    generation.startFrameReferenceId === referenceId ||
    generation.endFrameReferenceId === referenceId
  );
}

export function getReferenceUsage(project: Project, referenceId: string): string[] {
  return project.scenes
    .filter((scene) => sceneUsesReference(scene, referenceId))
    .map((scene) => scene.id);
}

/**
 * Ids of generated assets that record `referenceId` as a provenance input.
 *
 * `asset.generation.referenceIds` is written once when the asset is created and
 * is never mutated afterwards. It is not a scene input any more, but it is still
 * a hard validation input: `validateProject` rejects a project whose asset trace
 * points at a reference that no longer exists. Counting it as usage keeps a
 * reference from being deleted while an existing asset still claims it, so the
 * project can never be left in that invalid state by the delete path.
 */
export function getReferenceAssetUsage(project: Project, referenceId: string): string[] {
  return project.assets
    .filter((asset) => (asset.generation?.referenceIds ?? []).includes(referenceId))
    .map((asset) => asset.id);
}
