import type { RenderPlan, RenderPlanScene } from '@/lib/types/render';

export function createSceneRenderFingerprint(plan: RenderPlan, scene: RenderPlanScene): string {
  return JSON.stringify({
    projectId: plan.projectId,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    background: plan.background,
    studio: plan.studio,
    scene: {
      sceneId: scene.sceneId,
      order: scene.order,
      duration: scene.duration,
        source: {
          kind: scene.source.kind,
          assetId: scene.source.assetId,
          assetPath: scene.source.assetPath,
          remoteUrl: scene.source.remoteUrl,
          assetType: scene.source.assetType,
        width: scene.source.width,
        height: scene.source.height,
        duration: scene.source.duration,
        mimeType: scene.source.mimeType,
        template: scene.source.template,
        templateData: scene.source.templateData,
        style: scene.source.style,
        text: scene.source.text,
        html: scene.source.html,
        css: scene.source.css,
        htmlTemplate: scene.source.htmlTemplate,
        htmlBackground: scene.source.htmlBackground,
        htmlFingerprint: scene.source.htmlFingerprint
      },
      motion: scene.motion,
      transition: scene.transition,
      overlay: scene.overlay,
      logo: scene.logo,
      composition: scene.composition,
      karaoke: {
        subtitlesEnabled: plan.subtitlesEnabled !== false,
        words: scene.narration?.alignment?.words ?? []
      }
    },
    renderer: 'ffmpeg'
  });
}
