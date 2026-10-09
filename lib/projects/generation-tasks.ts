import type { GenerationRecord } from '@/lib/types/generation';
import type { Project } from '@/lib/types/render';

export interface GenerationTask {
  sceneId: string;
  sceneOrder: number;
  generation: GenerationRecord;
  readiness: 'ready' | 'in_progress' | 'not_ready' | 'invalid';
}

export function deriveGenerationTasks(project: Project): GenerationTask[] {
  return project.scenes
    .flatMap((scene) => {
      if (!scene.visual || (scene.visual.kind !== 'generated_image' && scene.visual.kind !== 'generated_video')) {
        return [];
      }

      const generation = scene.visual.generation;
      const assetId = scene.visual.assetId ?? generation.assetId;
      const asset = assetId ? project.assets.find((entry) => entry.id === assetId) : undefined;

      const hasUsableAsset = Boolean(asset && asset.status === 'available');
      const readiness: GenerationTask['readiness'] = generation.status === 'generated'
        ? hasUsableAsset
          ? 'ready'
          : 'invalid'
        : generation.status === 'queued' || generation.status === 'generating'
          ? 'in_progress'
          : generation.status === 'failed' || generation.status === 'rejected'
            ? hasUsableAsset
              ? 'ready'
              : 'invalid'
            : hasUsableAsset
              ? 'ready'
              : 'not_ready';

      return [{
        sceneId: scene.id,
        sceneOrder: scene.order,
        generation,
        readiness
      }];
    })
    .sort((a, b) => a.sceneOrder - b.sceneOrder);
}
