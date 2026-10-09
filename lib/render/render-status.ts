import type { CompositionArtifact, Project, RenderPlan } from '@/lib/types/render';
import type { Scene, SceneRenderArtifact } from '@/lib/types/scene';
import { createSceneRenderFingerprint } from './render-fingerprint';
import { audioMixesEqual, normalizeAudioMix } from './audio-mix';
import { deriveNarrationFreshness } from '@/lib/generation/narration-freshness';

export type SceneRenderLifecycleStatus = 'not_rendered' | 'rendering' | 'rendered' | 'render_failed' | 'stale';
export type SceneRenderProblemSeverity = 'info' | 'warning' | 'blocking';

export interface SceneRenderStatus {
  status: SceneRenderLifecycleStatus;
  latestRender?: SceneRenderArtifact;
  currentFingerprint?: string;
  latestCompletedRender?: SceneRenderArtifact;
  isRenderable: boolean;
  isStale: boolean;
  problems: Array<{
    severity: SceneRenderProblemSeverity;
    message: string;
    action: 'open_scene' | 'render_scene' | 'fix_inputs';
  }>;
}

export interface CompositionReadiness {
  canCompose: boolean;
  needsSceneRenderIds: string[];
  staleSceneIds: string[];
  blockingSceneIds: string[];
  invalidNarrationAudioSceneIds: string[];
  scenesWithNarrationAudio: number;
  totalScenes: number;
}

export interface CompositionArtifactStatus {
  status: 'missing' | 'current' | 'stale';
  artifact?: CompositionArtifact;
  reasons: string[];
}

function latestRender(scene: Scene) {
  return (scene.renders ?? [])[0];
}

function latestCompletedRender(scene: Scene) {
  return (scene.renders ?? []).find((entry) => entry.status === 'completed');
}

export function deriveSceneRenderStatus(project: Project, scene: Scene, renderPlan: RenderPlan, options: { isRendering?: boolean } = {}): SceneRenderStatus {
  const planScene = renderPlan.scenes.find((entry) => entry.sceneId === scene.id);
  const currentFingerprint = planScene ? createSceneRenderFingerprint(renderPlan, planScene) : undefined;
  const latest = latestRender(scene);
  const completed = latestCompletedRender(scene);
  const isRenderable = planScene?.status === 'renderable';
  const isStale = Boolean(completed && currentFingerprint && completed.renderFingerprint && completed.renderFingerprint !== currentFingerprint);
  const problems: SceneRenderStatus['problems'] = [];

  if (options.isRendering) {
    return {
      status: 'rendering',
      latestRender: latest,
      latestCompletedRender: completed,
      currentFingerprint,
      isRenderable,
      isStale,
      problems
    };
  }

  if (!isRenderable) {
    for (const issue of planScene?.issues ?? []) {
      problems.push({
        severity: issue.severity === 'error' ? 'blocking' : 'warning',
        message: issue.message,
        action: 'fix_inputs'
      });
    }
  }

  if (!latest) {
    if (isRenderable) {
      problems.push({ severity: 'info', message: 'Scene has not been rendered yet.', action: 'render_scene' });
    }
    return {
      status: 'not_rendered',
      latestRender: latest,
      latestCompletedRender: completed,
      currentFingerprint,
      isRenderable,
      isStale: false,
      problems
    };
  }

  if (latest.status === 'failed') {
    problems.push({ severity: 'warning', message: latest.message || 'Latest render failed.', action: 'render_scene' });
    return {
      status: 'render_failed',
      latestRender: latest,
      latestCompletedRender: completed,
      currentFingerprint,
      isRenderable,
      isStale,
      problems
    };
  }

  if (isStale) {
    problems.push({ severity: 'warning', message: 'Scene changed after the latest completed render.', action: 'render_scene' });
    return {
      status: 'stale',
      latestRender: latest,
      latestCompletedRender: completed,
      currentFingerprint,
      isRenderable,
      isStale: true,
      problems
    };
  }

  return {
    status: completed ? 'rendered' : 'not_rendered',
    latestRender: latest,
    latestCompletedRender: completed,
    currentFingerprint,
    isRenderable,
    isStale,
    problems
  };
}

export function deriveCompositionReadiness(project: Project, renderPlan: RenderPlan, renderingSceneIds: string[] = []): CompositionReadiness {
  const needsSceneRenderIds: string[] = [];
  const staleSceneIds: string[] = [];
  const blockingSceneIds: string[] = [];
  const invalidNarrationAudioSceneIds: string[] = [];
  let scenesWithNarrationAudio = 0;

  for (const scene of project.scenes) {
    const status = deriveSceneRenderStatus(project, scene, renderPlan, { isRendering: renderingSceneIds.includes(scene.id) });
    if (scene.narration?.audioAssetId) {
      scenesWithNarrationAudio += 1;

      const audioAsset = project.assets.find((asset) => asset.id === scene.narration?.audioAssetId);
      const isAudioType = audioAsset ? audioAsset.type === 'audio' || audioAsset.type === 'music' || audioAsset.type === 'voice' : false;
      if (!audioAsset || !isAudioType) {
        invalidNarrationAudioSceneIds.push(scene.id);
      }
    }

    if (!status.isRenderable) {
      blockingSceneIds.push(scene.id);
      continue;
    }

    if (status.status === 'not_rendered' || status.status === 'render_failed') {
      needsSceneRenderIds.push(scene.id);
    }

    if (status.status === 'stale') {
      staleSceneIds.push(scene.id);
    }
  }

  return {
    canCompose: blockingSceneIds.length === 0 && invalidNarrationAudioSceneIds.length === 0,
    needsSceneRenderIds,
    staleSceneIds,
    blockingSceneIds,
    invalidNarrationAudioSceneIds,
    scenesWithNarrationAudio,
    totalScenes: project.scenes.length
  };
}

export function deriveCompositionArtifactStatus(project: Project, renderPlan: RenderPlan): CompositionArtifactStatus {
  const artifact = (project.compositions ?? [])[0];
  if (!artifact) {
    return {
      status: 'missing',
      reasons: ['Project has no final composition yet.']
    };
  }

  const reasons: string[] = [];
  for (const scene of project.scenes) {
    const renderStatus = deriveSceneRenderStatus(project, scene, renderPlan);
    if (renderStatus.status === 'stale') {
      reasons.push(`Scene ${scene.order} changed after its latest render.`);
    }
    if (renderStatus.status === 'not_rendered' || renderStatus.status === 'render_failed') {
      reasons.push(`Scene ${scene.order} has no current completed render.`);
    }

    const narrationFreshness = deriveNarrationFreshness(project, scene);
    if (narrationFreshness.state === 'stale') {
      reasons.push(`Scene ${scene.order} narration audio no longer matches current narration inputs.`);
    }

    if (artifact.inputFingerprint?.version === 'p10.1') {
      const fingerprintScene = artifact.inputFingerprint.scenes.find((entry) => entry.sceneId === scene.id);
      if (fingerprintScene && fingerprintScene.narrationSignature !== narrationFreshness.narrationSignature) {
        reasons.push(`Scene ${scene.order} narration changed since the final composition was created.`);
      }
    }
  }

  const recordedAudioMix = artifact.inputFingerprint?.audioMix;
  if (recordedAudioMix && !audioMixesEqual(recordedAudioMix, normalizeAudioMix(project.renderSettings.audio))) {
    reasons.push('Audio mix settings changed since the final composition was created.');
  }

  if (reasons.length > 0) {
    return {
      status: 'stale',
      artifact,
      reasons
    };
  }

  return {
    status: 'current',
    artifact,
    reasons: []
  };
}

export function formatRenderStatusLabel(status: SceneRenderLifecycleStatus): string {
  if (status === 'not_rendered') return 'Not rendered';
  if (status === 'rendering') return 'Rendering';
  if (status === 'rendered') return 'Rendered';
  if (status === 'render_failed') return 'Render failed';
  return 'Stale';
}
