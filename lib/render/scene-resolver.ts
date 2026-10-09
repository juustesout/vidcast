import type { Project, RenderIssue, RenderPlan, RenderPlanScene, RenderPlanSceneStateIssue, RenderPlanSceneStatus } from '@/lib/types/render';
import type { Asset } from '@/lib/types/asset';
import type { Scene, VisualSpec } from '@/lib/types/scene';

function findAsset(project: Project, assetId?: string): Asset | undefined {
  if (!assetId) {
    return undefined;
  }

  return project.assets.find((entry) => entry.id === assetId);
}

function createSceneIssue(code: string, message: string, severity: 'error' | 'warning' = 'error'): RenderPlanSceneStateIssue {
  return { code, message, severity };
}

function resolveVisualSource(project: Project, scene: Scene): {
  status: RenderPlanSceneStatus;
  source: RenderPlanScene['source'];
  issues: RenderPlanSceneStateIssue[];
} {
  const visual = scene.visual;

  if (!visual) {
    return {
      status: 'invalid',
      source: { kind: scene.type },
      issues: [createSceneIssue('scene.visual.missing', 'Scene has no visual specification.')]
    };
  }

  switch (visual.kind) {
    case 'asset': {
      const asset = findAsset(project, visual.assetId);
      if (!visual.assetId) {
        return {
          status: 'invalid',
          source: { kind: scene.type },
          issues: [createSceneIssue('scene.visual.asset.missing', 'Existing asset visual is missing an asset id.')]
        };
      }

      if (!asset) {
        return {
          status: 'invalid',
          source: { kind: scene.type, assetId: visual.assetId },
          issues: [createSceneIssue('scene.visual.asset.notFound', `Asset ${visual.assetId} does not exist.`)]
        };
      }

      if (!asset.localPath) {
        return {
          status: 'planned',
          source: { kind: scene.type, assetId: asset.id, assetType: asset.type },
          issues: [createSceneIssue('scene.visual.asset.notReady', `Asset ${asset.id} exists but has no local file path.`, 'warning')]
        };
      }

      return {
        status: 'renderable',
        source: { kind: scene.type, assetId: asset.id, assetPath: asset.localPath, assetType: asset.type, width: asset.width, height: asset.height, duration: asset.duration, mimeType: asset.mimeType },
        issues: []
      };
    }
    case 'generated_image':
    case 'generated_video': {
      const assetId = visual.assetId ?? visual.generation.assetId;
      const asset = findAsset(project, assetId);
      const generationInProgress = visual.generation.status === 'queued' || visual.generation.status === 'generating';
      if (assetId && asset) {
        if (!asset.localPath) {
          return {
            status: 'planned',
            source: { kind: scene.type, assetId: asset.id, assetType: asset.type },
            issues: [createSceneIssue('scene.visual.generatedAsset.notReady', 'Generated-linked asset exists but is not available locally yet.', 'warning')]
          };
        }

        return {
          status: 'renderable',
          source: { kind: scene.type, assetId: asset.id, assetPath: asset.localPath, assetType: asset.type, width: asset.width, height: asset.height, duration: asset.duration, mimeType: asset.mimeType },
          issues: [
            ...(visual.generation.status === 'generated' ? [] : [createSceneIssue('scene.visual.generation.latestNotGenerated', 'Latest generation attempt is not generated, using previously available asset.', 'warning')]),
            ...(generationInProgress ? [createSceneIssue('scene.visual.generation.inProgress', 'A newer generation attempt is still in progress.', 'warning')] : []),
            ...(visual.kind === 'generated_video' && asset.type === 'video' && typeof asset.duration === 'number' && Math.abs(asset.duration - scene.duration) > 0.25
              ? [createSceneIssue('scene.visual.generatedVideo.durationMismatch', `Generated video duration (${asset.duration.toFixed(2)}s) differs from scene duration (${scene.duration.toFixed(2)}s).`, 'warning')]
              : [])
          ]
        };
      }

      if (visual.generation.status === 'generated') {
        if (!assetId || !asset) {
          return {
            status: 'invalid',
            source: { kind: scene.type },
            issues: [createSceneIssue('scene.visual.generatedAsset.missing', 'Generation is marked generated but no resolved asset exists.')]
          };
        }
      }

      return {
        status: 'planned',
        source: { kind: scene.type },
        issues: [
          createSceneIssue('scene.visual.generation.planned', 'Generation is planned but no renderable asset exists yet.', 'warning'),
          ...(generationInProgress ? [createSceneIssue('scene.visual.generation.inProgress', 'Generation is currently in progress.', 'warning')] : [])
        ]
      };
    }
    case 'graphic':
      return {
        status: 'renderable',
        source: {
          kind: 'graphic',
          template: visual.template,
          templateData: visual.templateData
        },
        issues: []
      };
    case 'text':
      return {
        status: 'renderable',
        source: {
          kind: 'text',
          text: visual.text
        },
        issues: []
      };
    case 'blank':
      return {
        status: 'renderable',
        source: { kind: 'blank' },
        issues: []
      };
    default:
      return {
        status: 'invalid',
        source: { kind: scene.type },
        issues: [createSceneIssue('scene.visual.unsupported', `Visual kind ${(visual as VisualSpec).kind} is unsupported.`)]
      };
  }
}

export function resolveRenderPlan(project: Project): RenderPlan {
  const issues: RenderIssue[] = [];
  const scenes: RenderPlanScene[] = project.scenes
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((scene) => {
      const resolved = resolveVisualSource(project, scene);

      for (const issue of resolved.issues) {
        issues.push({
          severity: issue.severity,
          code: issue.code,
          path: `scenes.${scene.id}`,
          message: issue.message
        });
      }

      return {
        sceneId: scene.id,
        order: scene.order,
        duration: scene.duration,
        status: resolved.status,
        source: resolved.source,
        motion: scene.render.motion,
        transition: scene.render.transition,
        overlay: scene.overlay,
        narration: scene.narration,
        referenceIds: scene.referenceIds,
        issues: resolved.issues
      };
    });

  return {
    projectId: project.id,
    title: project.title,
    aspectRatio: project.aspectRatio,
    fps: project.fps,
    width: project.renderSettings.width,
    height: project.renderSettings.height,
    background: project.renderSettings.background,
    ready: scenes.every((scene) => scene.status === 'renderable'),
    scenes,
    narration: project.narration,
    issues,
    seed: project.renderSettings.seed
  };
}
