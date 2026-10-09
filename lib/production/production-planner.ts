import { deriveNarrationFreshness } from '@/lib/generation/narration-freshness';
import { deriveCompositionArtifactStatus, deriveCompositionReadiness, deriveSceneRenderStatus } from '@/lib/render/render-status';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { Project } from '@/lib/types/render';
import type { Scene, VisualSpec } from '@/lib/types/scene';
import { validateProject } from '@/lib/validation/project-validation';

export type ProductionActionType =
  | 'image_generate'
  | 'video_submit'
  | 'video_poll'
  | 'narration_generate'
  | 'scene_render'
  | 'final_compose';

export type ProductionActionStatus =
  | 'current'
  | 'ready'
  | 'running'
  | 'failed'
  | 'waiting_dependency'
  | 'blocked'
  | 'skipped';

export interface ProductionPlannedAction {
  id: string;
  type: ProductionActionType;
  sceneId?: string;
  sceneOrder?: number;
  status: ProductionActionStatus;
  reason?: string;
  dependencyActionIds: string[];
  execute: boolean;
  payload?: Record<string, unknown>;
}

export interface ProductionPlanSummary {
  ready: number;
  running: number;
  current: number;
  failed: number;
  waiting: number;
  blocked: number;
  skipped: number;
}

export interface ProductionPlan {
  actions: ProductionPlannedAction[];
  summary: ProductionPlanSummary;
}

export interface ProductionPlannerRuntime {
  runningRenderSceneIds?: string[];
  runningNarrationSceneIds?: string[];
  runningGenerationSceneIds?: string[];
  composing?: boolean;
}

export interface DeriveProductionPlanOptions {
  runtime?: ProductionPlannerRuntime;
  failedActionIds?: string[];
  skippedActionIds?: string[];
  compositionAttempted?: boolean;
}

function actionId(type: ProductionActionType, sceneId?: string): string {
  if (type === 'final_compose') {
    return 'project:final_compose';
  }
  if (type === 'video_poll') {
    return `scene:${sceneId}:video_poll`;
  }
  return `scene:${sceneId}:${type}`;
}

function statusSummary(actions: ProductionPlannedAction[]): ProductionPlanSummary {
  return {
    ready: actions.filter((action) => action.status === 'ready' && action.execute).length,
    running: actions.filter((action) => action.status === 'running').length,
    current: actions.filter((action) => action.status === 'current').length,
    failed: actions.filter((action) => action.status === 'failed').length,
    waiting: actions.filter((action) => action.status === 'waiting_dependency').length,
    blocked: actions.filter((action) => action.status === 'blocked').length,
    skipped: actions.filter((action) => action.status === 'skipped').length
  };
}

function generationPromptMissing(visual: VisualSpec | undefined): boolean {
  if (!visual || (visual.kind !== 'generated_image' && visual.kind !== 'generated_video')) {
    return false;
  }
  return !visual.generation.prompt.trim();
}

function hasUsableGeneratedAsset(project: Project, scene: Scene): boolean {
  if (!scene.visual || (scene.visual.kind !== 'generated_image' && scene.visual.kind !== 'generated_video')) {
    return false;
  }

  const assetId = scene.visual.assetId ?? scene.visual.generation.assetId;
  if (!assetId) {
    return false;
  }

  const asset = project.assets.find((entry) => entry.id === assetId);
  return Boolean(asset && asset.status === 'available');
}

function isVisualGenerationRunning(scene: Scene): boolean {
  if (!scene.visual || (scene.visual.kind !== 'generated_image' && scene.visual.kind !== 'generated_video')) {
    return false;
  }
  return scene.visual.generation.status === 'queued' || scene.visual.generation.status === 'generating';
}

export function deriveProductionPlan(project: Project, options: DeriveProductionPlanOptions = {}): ProductionPlan {
  const runtime = options.runtime ?? {};
  const failedActionIds = new Set(options.failedActionIds ?? []);
  const skippedActionIds = new Set(options.skippedActionIds ?? []);

  const renderPlan = resolveRenderPlan(project);
  const validation = validateProject(project);
  const compositionReadiness = deriveCompositionReadiness(project, renderPlan, runtime.runningRenderSceneIds ?? []);
  const compositionStatus = deriveCompositionArtifactStatus(project, renderPlan);

  const actions: ProductionPlannedAction[] = [];

  const sceneActionsByScene = new Map<string, ProductionPlannedAction[]>();
  const register = (action: ProductionPlannedAction) => {
    actions.push(action);
    if (action.sceneId) {
      const list = sceneActionsByScene.get(action.sceneId) ?? [];
      list.push(action);
      sceneActionsByScene.set(action.sceneId, list);
    }
  };

  for (const scene of project.scenes.slice().sort((a, b) => a.order - b.order)) {
    const runningGeneration = runtime.runningGenerationSceneIds?.includes(scene.id) ?? false;
    const runningNarration = runtime.runningNarrationSceneIds?.includes(scene.id) ?? false;

    if (scene.visual?.kind === 'generated_image') {
      const id = actionId('image_generate', scene.id);
      const usableAsset = hasUsableGeneratedAsset(project, scene);
      const running = runningGeneration || isVisualGenerationRunning(scene);
      const status = scene.visual.generation.status;

      let actionStatus: ProductionActionStatus = 'ready';
      let reason = 'Image generation is ready.';
      let execute = true;
      const dependencyActionIds: string[] = [];

      if (skippedActionIds.has(id)) {
        actionStatus = 'skipped';
        execute = false;
        reason = 'Skipped by user.';
      } else if (failedActionIds.has(id)) {
        actionStatus = 'failed';
        execute = false;
        reason = 'Failed earlier in this run.';
      } else if (running) {
        actionStatus = 'running';
        execute = false;
        reason = 'Image generation is currently running.';
      } else if (status === 'generated' && usableAsset) {
        actionStatus = 'current';
        execute = false;
        reason = 'Generated image asset is current.';
      } else if (generationPromptMissing(scene.visual)) {
        actionStatus = 'blocked';
        execute = false;
        reason = 'Generation prompt is required.';
      } else if (status === 'failed' || status === 'rejected') {
        actionStatus = 'ready';
        reason = 'Retry image generation.';
      }

      register({
        id,
        type: 'image_generate',
        sceneId: scene.id,
        sceneOrder: scene.order,
        status: actionStatus,
        reason,
        dependencyActionIds,
        execute,
        payload: {
          regenerate: Boolean(usableAsset || status === 'failed' || status === 'rejected')
        }
      });
    }

    if (scene.visual?.kind === 'generated_video') {
      const submitId = actionId('video_submit', scene.id);
      const pollId = actionId('video_poll', scene.id);
      const usableAsset = hasUsableGeneratedAsset(project, scene);
      const status = scene.visual.generation.status;
      const providerJobId = scene.visual.generation.providerJobId;
      const running = runningGeneration || status === 'queued' || status === 'generating';

      let submitStatus: ProductionActionStatus = 'ready';
      let submitReason = 'Video generation submit is ready.';
      let submitExecute = true;

      if (skippedActionIds.has(submitId)) {
        submitStatus = 'skipped';
        submitExecute = false;
        submitReason = 'Skipped by user.';
      } else if (failedActionIds.has(submitId)) {
        submitStatus = 'failed';
        submitExecute = false;
        submitReason = 'Failed earlier in this run.';
      } else if (running) {
        submitStatus = 'running';
        submitExecute = false;
        submitReason = 'Video generation job is already running.';
      } else if (status === 'generated' && usableAsset) {
        submitStatus = 'current';
        submitExecute = false;
        submitReason = 'Generated video asset is current.';
      } else if (generationPromptMissing(scene.visual)) {
        submitStatus = 'blocked';
        submitExecute = false;
        submitReason = 'Generation prompt is required.';
      } else if (status === 'failed' || status === 'rejected') {
        submitStatus = 'ready';
        submitReason = 'Retry video generation submit.';
      }

      register({
        id: submitId,
        type: 'video_submit',
        sceneId: scene.id,
        sceneOrder: scene.order,
        status: submitStatus,
        reason: submitReason,
        dependencyActionIds: [],
        execute: submitExecute,
        payload: {
          regenerate: Boolean(usableAsset || status === 'failed' || status === 'rejected')
        }
      });

      if (running && scene.visual.generation.id && providerJobId) {
        register({
          id: pollId,
          type: 'video_poll',
          sceneId: scene.id,
          sceneOrder: scene.order,
          status: failedActionIds.has(pollId) ? 'failed' : 'ready',
          reason: failedActionIds.has(pollId) ? 'Polling failed earlier in this run.' : 'Poll existing video generation job status.',
          dependencyActionIds: [],
          execute: !failedActionIds.has(pollId),
          payload: {
            attemptId: scene.visual.generation.id
          }
        });
      }
    }

    const narrationState = deriveNarrationFreshness(project, scene);
    const narrationId = actionId('narration_generate', scene.id);
    let narrationStatus: ProductionActionStatus = 'ready';
    let narrationReason = 'Narration generation is ready.';
    let narrationExecute = true;
    let narrationMode: 'generate' | 'regenerate' | 'retry' = 'generate';

    if (skippedActionIds.has(narrationId)) {
      narrationStatus = 'skipped';
      narrationExecute = false;
      narrationReason = 'Skipped by user.';
    } else if (failedActionIds.has(narrationId)) {
      narrationStatus = 'failed';
      narrationExecute = false;
      narrationReason = 'Failed earlier in this run.';
    } else if (runningNarration || narrationState.state === 'generating') {
      narrationStatus = 'running';
      narrationExecute = false;
      narrationReason = 'Narration generation is running.';
    } else if (narrationState.state === 'no_narration') {
      narrationStatus = 'blocked';
      narrationExecute = false;
      narrationReason = 'Narration text is missing.';
    } else if (narrationState.state === 'current') {
      narrationStatus = 'current';
      narrationExecute = false;
      narrationReason = 'Narration audio is current.';
    } else if (narrationState.state === 'failed') {
      narrationStatus = 'ready';
      narrationMode = 'retry';
      narrationReason = narrationState.reason || 'Retry narration generation.';
    } else if (narrationState.state === 'stale') {
      narrationStatus = 'ready';
      narrationMode = 'regenerate';
      narrationReason = narrationState.reason || 'Regenerate stale narration audio.';
    } else if (narrationState.state === 'no_audio') {
      narrationStatus = 'ready';
      narrationMode = 'generate';
      narrationReason = narrationState.reason || 'Generate narration audio.';
    }

    register({
      id: narrationId,
      type: 'narration_generate',
      sceneId: scene.id,
      sceneOrder: scene.order,
      status: narrationStatus,
      reason: narrationReason,
      dependencyActionIds: [],
      execute: narrationExecute,
      payload: { mode: narrationMode }
    });

    const renderId = actionId('scene_render', scene.id);
    const renderStatus = deriveSceneRenderStatus(project, scene, renderPlan, {
      isRendering: Boolean(runtime.runningRenderSceneIds?.includes(scene.id))
    });

    let renderActionStatus: ProductionActionStatus = 'ready';
    let renderReason = 'Scene render is ready.';
    let renderExecute = true;
    const renderDependencies: string[] = [];

    if (skippedActionIds.has(renderId)) {
      renderActionStatus = 'skipped';
      renderExecute = false;
      renderReason = 'Skipped by user.';
    } else if (failedActionIds.has(renderId)) {
      renderActionStatus = 'failed';
      renderExecute = false;
      renderReason = 'Failed earlier in this run.';
    } else if (renderStatus.status === 'rendering') {
      renderActionStatus = 'running';
      renderExecute = false;
      renderReason = 'Scene render is currently running.';
    } else if (renderStatus.status === 'rendered') {
      renderActionStatus = 'current';
      renderExecute = false;
      renderReason = 'Scene render is current.';
    } else if (!renderStatus.isRenderable) {
      renderActionStatus = 'blocked';
      renderExecute = false;
      renderReason = renderStatus.problems[0]?.message || 'Scene is not renderable yet.';
    }

    const visualSubmit = actions.find((action) => action.sceneId === scene.id && (action.type === 'image_generate' || action.type === 'video_submit'));
    const videoPoll = actions.find((action) => action.sceneId === scene.id && action.type === 'video_poll');
    const visualPending = Boolean(
      (visualSubmit && (visualSubmit.status === 'ready' || visualSubmit.status === 'running' || visualSubmit.status === 'waiting_dependency')) ||
      (videoPoll && (videoPoll.status === 'ready' || videoPoll.status === 'running'))
    );

    if (renderExecute && visualPending) {
      renderActionStatus = 'waiting_dependency';
      renderExecute = false;
      renderReason = 'Waiting for visual generation to become current.';
      if (visualSubmit) {
        renderDependencies.push(visualSubmit.id);
      }
      if (videoPoll) {
        renderDependencies.push(videoPoll.id);
      }
    }

    register({
      id: renderId,
      type: 'scene_render',
      sceneId: scene.id,
      sceneOrder: scene.order,
      status: renderActionStatus,
      reason: renderReason,
      dependencyActionIds: renderDependencies,
      execute: renderExecute
    });
  }

  const composeId = actionId('final_compose');
  const hasBlockingValidation = validation.errors.length > 0;
  const hasSceneActionsPending = actions.some((action) =>
    action.type !== 'video_poll' && action.type !== 'final_compose' &&
    (action.status === 'ready' || action.status === 'running' || action.status === 'waiting_dependency')
  );

  let composeStatus: ProductionActionStatus = 'ready';
  let composeReason = 'Final composition is ready.';
  let composeExecute = true;
  const composeDependencies: string[] = [];

  if (skippedActionIds.has(composeId)) {
    composeStatus = 'skipped';
    composeExecute = false;
    composeReason = 'Skipped by user.';
  } else if (options.compositionAttempted) {
    composeStatus = 'current';
    composeExecute = false;
    composeReason = 'Composition already attempted in this run.';
  } else if (failedActionIds.has(composeId)) {
    composeStatus = 'failed';
    composeExecute = false;
    composeReason = 'Composition failed earlier in this run.';
  } else if (runtime.composing) {
    composeStatus = 'running';
    composeExecute = false;
    composeReason = 'Final composition is currently running.';
  } else if (compositionStatus.status === 'current') {
    composeStatus = 'current';
    composeExecute = false;
    composeReason = 'Final composition is current.';
  } else if (hasBlockingValidation) {
    composeStatus = 'blocked';
    composeExecute = false;
    composeReason = 'Validation blockers must be resolved before composing.';
  } else if (!compositionReadiness.canCompose) {
    composeStatus = 'blocked';
    composeExecute = false;
    composeReason = 'Composition readiness is blocked by scene or narration issues.';
  } else if (compositionReadiness.needsSceneRenderIds.length > 0 || compositionReadiness.staleSceneIds.length > 0 || hasSceneActionsPending) {
    composeStatus = 'waiting_dependency';
    composeExecute = false;
    composeReason = 'Waiting for required scene outputs to become current.';
    for (const sceneId of [...compositionReadiness.needsSceneRenderIds, ...compositionReadiness.staleSceneIds]) {
      composeDependencies.push(actionId('scene_render', sceneId));
    }
  }

  register({
    id: composeId,
    type: 'final_compose',
    status: composeStatus,
    reason: composeReason,
    dependencyActionIds: composeDependencies,
    execute: composeExecute
  });

  const sorted = actions.sort((left, right) => {
    const leftOrder = left.sceneOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.sceneOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;

    const actionOrder: ProductionActionType[] = ['image_generate', 'video_submit', 'video_poll', 'narration_generate', 'scene_render', 'final_compose'];
    return actionOrder.indexOf(left.type) - actionOrder.indexOf(right.type);
  });

  return {
    actions: sorted,
    summary: statusSummary(sorted)
  };
}

export function deriveReadyProductionActions(plan: ProductionPlan): ProductionPlannedAction[] {
  return plan.actions.filter((action) => action.status === 'ready' && action.execute);
}

export function groupProductionActionsByScene(plan: ProductionPlan): Array<{ sceneId: string; sceneOrder: number; actions: ProductionPlannedAction[] }> {
  const grouped = new Map<string, { sceneId: string; sceneOrder: number; actions: ProductionPlannedAction[] }>();
  for (const action of plan.actions) {
    if (!action.sceneId || typeof action.sceneOrder !== 'number') {
      continue;
    }

    const entry = grouped.get(action.sceneId) ?? { sceneId: action.sceneId, sceneOrder: action.sceneOrder, actions: [] };
    entry.actions.push(action);
    grouped.set(action.sceneId, entry);
  }

  return Array.from(grouped.values()).sort((left, right) => left.sceneOrder - right.sceneOrder);
}
