import type { Project, RenderFit, RenderIssue, RenderPlan, RenderPlanCompositionLayer, RenderPlanLogoOverlay, RenderPlanScene, RenderPlanSceneComposition, RenderPlanSceneStateIssue, RenderPlanSceneStatus } from '@/lib/types/render';
import type { Asset } from '@/lib/types/asset';
import type { Scene, VisualSpec } from '@/lib/types/scene';
import { normalizeAudioMix } from './audio-mix';
import { describeFitWarning, resolveRenderFit } from './fit-policy';
import { formatSceneTiming, resolveMeasuredNarrationDuration, resolveSceneTiming } from './scene-timing';
import { MAX_SCENE_DURATION_SECONDS } from '@/lib/constants';
import { mergeGraphicStyles } from './graphic-style';
import { resolveStudioOverlay } from './studio-overlay';
import { isSafeAssetPath, sortCompositionLayers, STUDIO_COMPOSITION_CANVAS } from './scene-composition';
import { applyStudioPresetAssets } from './studio-asset-resolver';

function findAsset(project: Project, assetId?: string): Asset | undefined {
  if (!assetId) {
    return undefined;
  }

  return project.assets.find((entry) => entry.id === assetId);
}

function createSceneIssue(code: string, message: string, severity: 'error' | 'warning' = 'error'): RenderPlanSceneStateIssue {
  return { code, message, severity };
}

// A source with a known size that does not match the canvas aspect ratio is
// cropped by the `cover` fit, discarding part of the image. This surfaces that
// as an existing warning-level RenderPlan issue so the loss is visible in
// validation/production reporting instead of silent. Under `contain` nothing is
// cropped (the source is letterboxed), so no warning is emitted.
function resolveFitIssues(project: Project, source: RenderPlanScene['source'], fit: RenderFit): RenderPlanSceneStateIssue[] {
  if (
    (source.kind !== 'image' && source.kind !== 'video') ||
    typeof source.width !== 'number' ||
    typeof source.height !== 'number' ||
    source.width <= 0 ||
    source.height <= 0
  ) {
    return [];
  }

  const warning = describeFitWarning({
    sourceWidth: source.width,
    sourceHeight: source.height,
    canvasWidth: project.renderSettings.width,
    canvasHeight: project.renderSettings.height,
    fit,
    aspectRatio: project.aspectRatio
  });

  return warning ? [createSceneIssue('scene.visual.fit.crop', warning, 'warning')] : [];
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
    case 'stock_image': {
      const selection = visual.selection;
      const asset = findAsset(project, visual.assetId);

      if (asset && asset.localPath) {
        return {
          status: 'renderable',
          source: {
            kind: scene.type,
            assetId: asset.id,
            assetPath: asset.localPath,
            assetType: asset.type,
            width: asset.width,
            height: asset.height,
            duration: asset.duration,
            mimeType: asset.mimeType
          },
          issues: []
        };
      }

      if (asset && !asset.localPath) {
        return {
          status: 'planned',
          source: { kind: scene.type, assetId: asset.id, assetType: asset.type },
          issues: [createSceneIssue('scene.visual.stockAsset.notReady', 'Stock image asset exists but has no local file path.', 'warning')]
        };
      }

      // Hotlink-policy selections (e.g. Unsplash) must be referenced by URL, not
      // stored locally; the render step fetches the bytes transiently.
      if (selection && selection.usagePolicy === 'hotlink') {
        return {
          status: 'renderable',
          source: {
            kind: scene.type,
            remoteUrl: selection.imageUrl,
            width: selection.width,
            height: selection.height,
            mimeType: 'image/jpeg'
          },
          issues: []
        };
      }

      return {
        status: 'planned',
        source: { kind: scene.type },
        issues: [createSceneIssue('scene.visual.stock.planned', 'Stock image has not been selected yet.', 'warning')]
      };
    }
    case 'graphic':
      return {
        status: 'renderable',
        source: {
          kind: 'graphic',
          template: visual.template,
          templateData: visual.templateData,
          style: mergeGraphicStyles(project.renderSettings.graphicStyle, visual.style)
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

function resolveSceneLogo(project: Project, scene: Scene): {
  logo?: RenderPlanLogoOverlay;
  issues: RenderPlanSceneStateIssue[];
} {
  // `null` is an explicit per-scene opt-out; only an absent field inherits the
  // project-level default.
  if (scene.logo === null) {
    return { issues: [] };
  }

  const candidate = scene.logo ?? project.renderSettings.logo;
  if (candidate === undefined) {
    return { issues: [] };
  }

  if (!candidate || typeof candidate !== 'object') {
    return { issues: [createSceneIssue('scene.logo.invalid', 'Logo overlay configuration must be an object.', 'warning')] };
  }

  const assetId = typeof candidate.assetId === 'string' ? candidate.assetId.trim() : '';
  if (!assetId) {
    return { issues: [createSceneIssue('scene.logo.asset.required', 'Logo overlay requires an asset id.', 'warning')] };
  }

  const asset = findAsset(project, assetId);
  if (!asset) {
    return { issues: [createSceneIssue('scene.logo.asset.notFound', `Logo asset ${assetId} does not exist.`, 'warning')] };
  }

  if (asset.type !== 'image' && asset.type !== 'graphic') {
    return { issues: [createSceneIssue('scene.logo.asset.invalidType', `Logo asset ${asset.id} is not an image asset.`, 'warning')] };
  }

  if (!asset.localPath) {
    return { issues: [createSceneIssue('scene.logo.asset.notReady', `Logo asset ${asset.id} has no local file path.`, 'warning')] };
  }

  return {
    logo: {
      ...candidate,
      assetId,
      assetPath: asset.localPath
    },
    issues: []
  };
}

function resolveCompositionAssetPath(project: Project, assetId?: string, localPath?: string): { assetId?: string; assetPath?: string; issues: RenderPlanSceneStateIssue[] } {
  const issues: RenderPlanSceneStateIssue[] = [];
  if (assetId) {
    const asset = findAsset(project, assetId);
    if (!asset?.localPath) {
      issues.push(createSceneIssue('scene.composition.asset.missing', `Composition asset ${assetId} does not exist.`, 'warning'));
      return { assetId, issues };
    }
    if (!isSafeAssetPath(asset.localPath)) {
      issues.push(createSceneIssue('scene.composition.asset.path.unsafe', `Composition asset ${assetId} path is not project-relative under assets/.`, 'error'));
      return { assetId, issues };
    }
    return { assetId, assetPath: asset.localPath, issues };
  }

  if (localPath) {
    if (!isSafeAssetPath(localPath)) {
      issues.push(createSceneIssue('scene.composition.asset.path.unsafe', 'Composition asset path must be project-relative under assets/.', 'error'));
      return { issues };
    }
    return { assetPath: localPath, issues };
  }

  return { issues };
}

function resolveScenePresenterClip(project: Project, scene: Scene): { assetId?: string; assetPath?: string; duration?: number; startOffsetSeconds: number; issues: RenderPlanSceneStateIssue[] } {
  const clip = project.presenterClips?.find((entry) => entry.sceneId === scene.id);
  const startOffsetSeconds = Math.max(0, project.presenter?.sceneSettings.find((entry) => entry.sceneId === scene.id)?.startOffsetSeconds ?? 0);
  if (!clip || clip.status !== 'generated' || !clip.assetId) {
    return {
      startOffsetSeconds,
      issues: [createSceneIssue('scene.composition.presenter.missing', 'Enabled presenter layer has no generated clip; rendering without it.', 'warning')]
    };
  }

  const asset = findAsset(project, clip.assetId);
  if (!asset?.localPath || !isSafeAssetPath(asset.localPath)) {
    return {
      startOffsetSeconds,
      issues: [createSceneIssue('scene.composition.presenter.missing', 'Presenter clip asset is missing or unsafe; rendering without it.', 'warning')]
    };
  }

  return {
    assetId: clip.assetId,
    assetPath: asset.localPath,
    duration: clip.duration,
    startOffsetSeconds,
    issues: []
  };
}

function resolveSceneComposition(project: Project, scene: Scene): { composition?: RenderPlanSceneComposition; issues: RenderPlanSceneStateIssue[] } {
  const composition = applyStudioPresetAssets(scene.composition, project.assets) ?? scene.composition;
  if (!composition) {
    return { issues: [] };
  }

  const issues: RenderPlanSceneStateIssue[] = [];
  const canvas = composition.canvas ?? (composition.preset === 'studio' ? STUDIO_COMPOSITION_CANVAS : {
    width: project.renderSettings.width,
    height: project.renderSettings.height
  });
  const layers: RenderPlanCompositionLayer[] = [];
  let presenterAssetId: string | undefined;
  let presenterClipDuration: number | undefined;
  let presenterStartOffsetSeconds: number | undefined;

  for (const layer of sortCompositionLayers(composition.layers)) {
    if (layer.type === 'presenter') {
      const clip = layer.enabled !== false ? resolveScenePresenterClip(project, scene) : { startOffsetSeconds: 0, issues: [] as RenderPlanSceneStateIssue[] };
      issues.push(...clip.issues);
      if (clip.assetId) {
        presenterAssetId = clip.assetId;
        presenterClipDuration = clip.duration;
        presenterStartOffsetSeconds = clip.startOffsetSeconds;
      }
      layers.push({
        id: layer.id,
        type: 'presenter',
        enabled: layer.enabled !== false && Boolean(clip.assetPath),
        zIndex: layer.zIndex,
        rect: layer.rect ?? { x: 0, y: 0, width: canvas.width, height: canvas.height },
        fit: layer.fit ?? 'contain',
        assetId: clip.assetId,
        assetPath: clip.assetPath,
        mediaKind: clip.assetPath ? 'video' : undefined,
        mode: layer.mode
      });
      continue;
    }

    const boundStock = layer.type === 'image' && !layer.assetId && !layer.localPath && scene.visual?.kind === 'stock_image'
      ? scene.visual.assetId
      : undefined;
    const resolved = resolveCompositionAssetPath(project, layer.assetId ?? boundStock, layer.localPath);
    issues.push(...resolved.issues);
    if (
      layer.enabled !== false &&
      !resolved.assetPath &&
      resolved.issues.length === 0 &&
      layer.type === 'image' &&
      scene.visual?.kind === 'stock_image' &&
      scene.visual.selection?.usagePolicy === 'hotlink' &&
      !scene.visual.assetId
    ) {
      issues.push(createSceneIssue(
        'scene.composition.asset.hotlinkUnsupported',
        'Composition bigscreen requires a downloaded stock asset; hotlinked photos are not copied into assets/.',
        'warning'
      ));
    } else if (layer.enabled !== false && !resolved.assetPath && resolved.issues.length === 0) {
      issues.push(createSceneIssue('scene.composition.asset.missing', `Enabled ${layer.type} layer has no assetId or localPath.`, 'warning'));
    }
    const mediaKind = resolved.assetPath && /\.(mp4|webm|mov|mkv)$/i.test(resolved.assetPath) ? 'video' : 'image';
    const timed = layer.type === 'overlay' || layer.type === 'image'
      ? {
          startSeconds: layer.startSeconds,
          durationSeconds: layer.durationSeconds
        }
      : {};
    layers.push({
      id: layer.id,
      type: layer.type,
      enabled: layer.enabled !== false && Boolean(resolved.assetPath) && resolved.issues.every((issue) => issue.severity !== 'error'),
      zIndex: layer.zIndex,
      rect: layer.rect,
      fit: layer.fit,
      assetId: resolved.assetId,
      assetPath: resolved.assetPath,
      mediaKind: resolved.assetPath ? mediaKind : undefined,
      ...timed
    });
  }

  return {
    composition: {
      version: composition.version,
      preset: composition.preset,
      canvas,
      layers,
      presenterAssetId,
      presenterClipDuration,
      presenterStartOffsetSeconds
    },
    issues
  };
}

export function resolveRenderPlan(project: Project): RenderPlan {
  const issues: RenderIssue[] = [];
  const fit = resolveRenderFit(project.renderSettings.fit);
  const studio = resolveStudioOverlay(
    project.renderSettings.studio,
    project.renderSettings.width,
    project.renderSettings.height
  );
  const scenes: RenderPlanScene[] = project.scenes
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((scene) => {
      const resolved = resolveVisualSource(project, scene);
      const timing = resolveSceneTiming({
        duration: scene.duration,
        narrationDuration: resolveMeasuredNarrationDuration(scene.narration, project.assets)
      });
      const timingIssues = timing.exceedsMax
        ? [
            createSceneIssue(
              'scene.narration.duration.exceedsMax',
              `Scene timing requires ${timing.effectiveDuration.toFixed(2)}s (${formatSceneTiming(timing)}), which exceeds the ${MAX_SCENE_DURATION_SECONDS}s scene limit.`,
              'error'
            )
          ]
        : [];
      const logo = resolveSceneLogo(project, scene);
      const composition = resolveSceneComposition(project, scene);
      const sceneIssues = [...resolved.issues, ...timingIssues, ...resolveFitIssues(project, resolved.source, fit), ...logo.issues, ...composition.issues];
      const compositionBlocked = composition.issues.some((issue) => issue.severity === 'error');

      for (const issue of sceneIssues) {
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
        duration: timing.effectiveDuration,
        timing,
        status: timing.exceedsMax || compositionBlocked ? 'invalid' : resolved.status,
        source: resolved.source,
        motion: scene.render.motion,
        transition: scene.render.transition,
        overlay: scene.overlay,
        logo: logo.logo,
        composition: composition.composition,
        narration: scene.narration,
        referenceIds: scene.referenceIds,
        issues: sceneIssues
      };
    });

  return {
    projectId: project.id,
    title: project.title,
    aspectRatio: project.aspectRatio,
    fps: project.fps,
    width: project.renderSettings.width,
    height: project.renderSettings.height,
    fit,
    background: project.renderSettings.background,
    studio,
    ready: scenes.every((scene) => scene.status === 'renderable'),
    scenes,
    narration: project.narration,
    issues,
    seed: project.renderSettings.seed,
    audio: normalizeAudioMix(project.renderSettings.audio),
    subtitlesEnabled: project.renderSettings.subtitlesEnabled
  };
}

// The single authoritative video timeline. P32.1 resolves each scene's effective
// duration; everything that needs "how long is the final video" (music length,
// UI defaults, run diagnostics) must sum this plan instead of recalculating from
// authored scene durations or render settings.
export function resolveRenderPlanDurationSeconds(plan: RenderPlan): number {
  return plan.scenes.reduce((sum, scene) => sum + scene.duration, 0);
}

export function resolveProjectTimelineDurationSeconds(project: Project): number {
  return resolveRenderPlanDurationSeconds(resolveRenderPlan(project));
}
