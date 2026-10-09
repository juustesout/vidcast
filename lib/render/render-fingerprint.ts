import type { RenderPlan, RenderPlanScene } from '@/lib/types/render';

export function createSceneRenderFingerprint(plan: RenderPlan, scene: RenderPlanScene): string {
  return JSON.stringify({
    projectId: plan.projectId,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    background: plan.background,
    scene: {
      sceneId: scene.sceneId,
      order: scene.order,
      duration: scene.duration,
      source: {
        kind: scene.source.kind,
        assetId: scene.source.assetId,
        assetPath: scene.source.assetPath,
        assetType: scene.source.assetType,
        width: scene.source.width,
        height: scene.source.height,
        duration: scene.source.duration,
        mimeType: scene.source.mimeType,
        template: scene.source.template,
        templateData: scene.source.templateData,
        text: scene.source.text
      },
      motion: scene.motion,
      transition: scene.transition,
      overlay: scene.overlay
    },
    renderer: 'ffmpeg'
  });
}
