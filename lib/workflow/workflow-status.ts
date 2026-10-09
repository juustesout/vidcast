import { deriveCompositionArtifactStatus, deriveCompositionReadiness, deriveSceneRenderStatus } from '@/lib/render/render-status';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { Project } from '@/lib/types/render';
import { validateProject } from '@/lib/validation/project-validation';
import { deriveGenerationTasks } from '@/lib/projects/generation-tasks';
import { deriveNarrationFreshness } from '@/lib/generation/narration-freshness';

export type WorkflowStepId =
  | 'brief'
  | 'story'
  | 'scene_plan'
  | 'scenes'
  | 'visuals'
  | 'narration'
  | 'preview'
  | 'final_render';

export type WorkflowStepStatus = 'blocked' | 'needs_attention' | 'ready' | 'complete';

export type WorkflowNavigationTarget = 'story' | 'scenes' | 'assets' | 'references' | 'generation';

export interface WorkflowNextAction {
  label: string;
  target: WorkflowNavigationTarget;
}

export interface WorkflowAdvisory {
  id: string;
  kind: 'beat_to_intent' | 'intent_to_scene' | 'limitation';
  severity: 'warning' | 'info';
  message: string;
  target: WorkflowNavigationTarget;
  intentId?: string;
  beatId?: string;
  sceneId?: string;
}

export interface WorkflowStepState {
  id: WorkflowStepId;
  label: string;
  status: WorkflowStepStatus;
  complete: boolean;
  blockers: string[];
  warnings: string[];
  nextAction: WorkflowNextAction;
  navigationTarget: WorkflowNavigationTarget;
}

export interface DerivedWorkflowStatus {
  steps: WorkflowStepState[];
  recommendedStepId: WorkflowStepId;
  recommendedAction: WorkflowNextAction;
  advisories: WorkflowAdvisory[];
}

export interface WorkflowRuntimeState {
  generatingSceneIds?: string[];
  narratingSceneIds?: string[];
  renderingSceneIds?: string[];
  composing?: boolean;
  compositionFailed?: boolean;
}

function required(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

function sceneIntentWarnings(project: Project): WorkflowAdvisory[] {
  const advisories: WorkflowAdvisory[] = [];
  const beats = project.explainer?.story.beats ?? [];
  const intents = project.explainer?.sceneIntents ?? [];

  for (const intent of intents) {
    if (intent.status !== 'approved') {
      continue;
    }

    if (intent.beatIds.length === 1) {
      const beat = beats.find((entry) => entry.id === intent.beatIds[0]);
      if (beat && beat.text.trim() && intent.narrationDraft.trim() && beat.text.trim() !== intent.narrationDraft.trim()) {
        advisories.push({
          id: `beat-intent-${intent.id}-${beat.id}`,
          kind: 'beat_to_intent',
          severity: 'warning',
          message: `Approved scene intent ${intent.order} differs from linked beat ${beat.order}. Review intent before continuing.` ,
          target: 'story',
          intentId: intent.id,
          beatId: beat.id
        });
      }
    }

    if (intent.materializedSceneId) {
      const scene = project.scenes.find((entry) => entry.id === intent.materializedSceneId);
      if (!scene) {
        continue;
      }

      const differsNarration = (scene.narration?.text ?? '').trim() !== intent.narrationDraft.trim();
      const differsDuration = Math.abs(scene.duration - intent.timing.durationSeconds) > 0.01;

      if (differsNarration || differsDuration) {
        advisories.push({
          id: `intent-scene-${intent.id}-${scene.id}`,
          kind: 'intent_to_scene',
          severity: 'warning',
          message: `Materialized scene ${scene.order} no longer matches scene intent ${intent.order}. Consider reviewing intent and scene together.`,
          target: 'scenes',
          intentId: intent.id,
          sceneId: scene.id
        });
      }
    }
  }

  if (advisories.some((entry) => entry.kind === 'beat_to_intent' || entry.kind === 'intent_to_scene')) {
    advisories.push({
      id: 'advisory-limitation-no-timestamps',
      kind: 'limitation',
      severity: 'info',
      message: 'Upstream stale advisories are state-diff based. Exact change order is not persisted yet.',
      target: 'story'
    });
  }

  return advisories;
}

function step(id: WorkflowStepId, label: string, status: WorkflowStepStatus, blockers: string[], warnings: string[], nextAction: WorkflowNextAction, navigationTarget: WorkflowNavigationTarget): WorkflowStepState {
  return {
    id,
    label,
    status,
    complete: status === 'complete',
    blockers,
    warnings,
    nextAction,
    navigationTarget
  };
}

export function deriveWorkflowStatus(project: Project, runtime: WorkflowRuntimeState = {}): DerivedWorkflowStatus {
  const explainer = project.explainer;
  const validation = validateProject(project);
  const renderPlan = resolveRenderPlan(project);
  const compositionReadiness = deriveCompositionReadiness(project, renderPlan, runtime.renderingSceneIds ?? []);
  const compositionArtifactStatus = deriveCompositionArtifactStatus(project, renderPlan);
  const generationTasks = deriveGenerationTasks(project);
  const advisories = sceneIntentWarnings(project);

  const briefBlockers: string[] = [];
  const briefWarnings: string[] = [];
  const brief = explainer?.brief;
  const briefFieldsReady = Boolean(
    brief &&
    required(brief.topic) &&
    required(brief.goal) &&
    required(brief.audience) &&
    required(brief.tone) &&
    brief.targetDurationSeconds > 0
  );

  if (!briefFieldsReady) {
    const hasAnyBriefInput = Boolean(
      brief &&
      (required(brief.topic) || required(brief.goal) || required(brief.audience) || required(brief.tone) || brief.targetDurationSeconds > 0)
    );
    if (!hasAnyBriefInput) {
      briefBlockers.push('Brief is empty.');
    } else {
      briefWarnings.push('Brief is partially complete.');
    }
  }

  const briefStatus: WorkflowStepStatus = briefFieldsReady ? 'complete' : briefBlockers.length > 0 ? 'blocked' : 'needs_attention';

  const storyBlockers: string[] = [];
  const storyWarnings: string[] = [];
  const script = explainer?.story.script ?? '';
  const beats = explainer?.story.beats ?? [];
  const hasScript = required(script);
  const hasBeats = beats.length > 0;

  if (!hasScript && !hasBeats) {
    storyBlockers.push('Add script text or at least one beat.');
  }
  if (hasScript && !hasBeats) {
    storyWarnings.push('Script exists but beats are missing.');
  }

  const storyStatus: WorkflowStepStatus = hasScript && hasBeats ? 'complete' : storyBlockers.length > 0 ? 'blocked' : hasScript || hasBeats ? 'ready' : 'blocked';

  const intents = explainer?.sceneIntents ?? [];
  const scenePlanBlockers: string[] = [];
  const scenePlanWarnings: string[] = [];
  if (!hasBeats) {
    scenePlanBlockers.push('Beats are required before scene planning.');
  }
  if (hasBeats && intents.length === 0) {
    scenePlanWarnings.push('No scene intents yet. Create intents from beats.');
  }
  const unapprovedCount = intents.filter((intent) => intent.status !== 'approved').length;
  if (unapprovedCount > 0) {
    scenePlanWarnings.push(`${unapprovedCount} scene intent(s) are not approved.`);
  }

  for (const advisory of advisories) {
    if (advisory.kind === 'beat_to_intent' && advisory.severity === 'warning') {
      scenePlanWarnings.push(advisory.message);
    }
  }

  const scenePlanStatus: WorkflowStepStatus = scenePlanBlockers.length > 0
    ? 'blocked'
    : intents.length > 0 && unapprovedCount === 0
      ? scenePlanWarnings.length > 0
        ? 'needs_attention'
        : 'complete'
      : intents.length > 0
        ? 'needs_attention'
        : 'ready';

  const sceneValidationErrors = validation.errors.filter((entry) => entry.path.startsWith('scenes.'));
  const sceneValidationWarnings = validation.warnings.filter((entry) => entry.path.startsWith('scenes.'));
  const scenesBlockers: string[] = [];
  const scenesWarnings: string[] = [];

  if (project.scenes.length === 0) {
    scenesBlockers.push('No scenes exist yet. Materialize approved scene intents.');
  }
  if (sceneValidationErrors.length > 0) {
    scenesBlockers.push(`${sceneValidationErrors.length} scene validation issue(s) must be fixed.`);
  }
  if (sceneValidationWarnings.length > 0) {
    scenesWarnings.push(`${sceneValidationWarnings.length} scene warning(s) need review.`);
  }

  const scenesStatus: WorkflowStepStatus = scenesBlockers.length > 0
    ? 'blocked'
    : scenesWarnings.length > 0
      ? 'needs_attention'
      : project.scenes.length > 0
        ? 'complete'
        : 'blocked';

  const visualBlockers: string[] = [];
  const visualWarnings: string[] = [];

  if (project.scenes.length === 0) {
    visualBlockers.push('No scenes available for visual setup.');
  }

  const invalidVisualScenes = renderPlan.scenes.filter((scene) => scene.status === 'invalid').length;
  const plannedVisualScenes = renderPlan.scenes.filter((scene) => scene.status === 'planned').length;
  const runningGenerationCount = generationTasks.filter((task) => task.generation.status === 'queued' || task.generation.status === 'generating').length;
  const failedGenerationCount = generationTasks.filter((task) => task.generation.status === 'failed' || task.generation.status === 'rejected').length;

  if (invalidVisualScenes > 0) {
    visualBlockers.push(`${invalidVisualScenes} scene(s) have invalid visual configuration.`);
  }
  if (plannedVisualScenes > 0) {
    visualWarnings.push(`${plannedVisualScenes} scene(s) still need concrete visual assets or generation output.`);
  }
  if (runningGenerationCount > 0) {
    visualWarnings.push(`${runningGenerationCount} generation job(s) are currently running.`);
  }
  if (failedGenerationCount > 0) {
    visualWarnings.push(`${failedGenerationCount} generation job(s) failed and need retry.`);
  }

  const visualsStatus: WorkflowStepStatus = visualBlockers.length > 0
    ? 'blocked'
    : plannedVisualScenes > 0 || runningGenerationCount > 0 || failedGenerationCount > 0
      ? 'needs_attention'
      : renderPlan.scenes.length > 0
        ? 'complete'
        : 'blocked';

  const narrationBlockers: string[] = [];
  const narrationWarnings: string[] = [];

  if (project.scenes.length === 0) {
    narrationBlockers.push('No scenes available for narration.');
  }

  const scenesMissingNarrationText = project.scenes.filter((scene) => !required(scene.narration?.text)).length;
  if (scenesMissingNarrationText > 0) {
    narrationWarnings.push(`${scenesMissingNarrationText} scene(s) are missing narration text.`);
  }

  const narrationErrors = validation.errors.filter((entry) => entry.code.startsWith('scene.narration.'));
  if (narrationErrors.length > 0) {
    narrationWarnings.push(`${narrationErrors.length} narration issue(s) need attention.`);
  }

  const narrationFreshness = project.scenes.map((scene) => deriveNarrationFreshness(project, scene));
  const staleNarrationCount = narrationFreshness.filter((entry) => entry.state === 'stale').length;
  const noAudioCount = narrationFreshness.filter((entry) => entry.state === 'no_audio').length;
  const narrationFailedCount = narrationFreshness.filter((entry) => entry.state === 'failed').length;
  const narrationGeneratingCount = narrationFreshness.filter((entry) => entry.state === 'generating').length + (runtime.narratingSceneIds?.length ?? 0);

  if (staleNarrationCount > 0) {
    narrationWarnings.push(`${staleNarrationCount} scene(s) need narration regeneration after input changes.`);
  }
  if (noAudioCount > 0) {
    narrationWarnings.push(`${noAudioCount} scene(s) have narration text but no linked audio.`);
  }
  if (narrationFailedCount > 0) {
    narrationWarnings.push(`${narrationFailedCount} narration generation attempt(s) failed.`);
  }
  if (narrationGeneratingCount > 0) {
    narrationWarnings.push(`${narrationGeneratingCount} narration generation job(s) are running.`);
  }

  const narrationStatus: WorkflowStepStatus = narrationBlockers.length > 0
    ? 'blocked'
    : scenesMissingNarrationText > 0 || narrationErrors.length > 0 || staleNarrationCount > 0 || noAudioCount > 0 || narrationFailedCount > 0 || narrationGeneratingCount > 0
      ? 'needs_attention'
      : project.scenes.length > 0
        ? 'complete'
        : 'blocked';

  const previewBlockers: string[] = [];
  const previewWarnings: string[] = [];

  if (project.scenes.length === 0) {
    previewBlockers.push('No scenes available for preview.');
  }

  let renderedCount = 0;
  for (const scene of project.scenes) {
    const status = deriveSceneRenderStatus(project, scene, renderPlan, {
      isRendering: Boolean(runtime.renderingSceneIds?.includes(scene.id))
    });
    if (status.status === 'rendered') {
      renderedCount += 1;
    }
    if (status.status === 'rendering') {
      previewWarnings.push(`Scene ${scene.order} is rendering now.`);
    }
    if (status.status === 'not_rendered') {
      previewWarnings.push(`Scene ${scene.order} has not been rendered yet.`);
    }
    if (status.status === 'render_failed') {
      previewWarnings.push(`Scene ${scene.order} has a failed render.`);
    }
    if (status.status === 'stale') {
      previewWarnings.push(`Scene ${scene.order} render is stale.`);
    }
  }

  const previewStatus: WorkflowStepStatus = previewBlockers.length > 0
    ? 'blocked'
    : project.scenes.length > 0 && renderedCount === project.scenes.length && previewWarnings.length === 0
      ? 'complete'
      : project.scenes.length > 0
        ? 'needs_attention'
        : 'blocked';

  const finalRenderBlockers: string[] = [];
  const finalRenderWarnings: string[] = [];

  if (!compositionReadiness.canCompose) {
    finalRenderBlockers.push('Project is not composition-ready yet. Resolve scene blockers first.');
  }

  if (compositionReadiness.needsSceneRenderIds.length > 0) {
    finalRenderWarnings.push(`${compositionReadiness.needsSceneRenderIds.length} scene(s) still need a first render.`);
  }
  if (compositionReadiness.staleSceneIds.length > 0) {
    finalRenderWarnings.push(`${compositionReadiness.staleSceneIds.length} scene render(s) are stale.`);
  }
  if (compositionReadiness.invalidNarrationAudioSceneIds.length > 0) {
    finalRenderBlockers.push(`${compositionReadiness.invalidNarrationAudioSceneIds.length} scene(s) link invalid narration audio assets.`);
  }
  if (runtime.composing) {
    finalRenderWarnings.push('Final composition is running.');
  }
  if (runtime.compositionFailed) {
    finalRenderWarnings.push('Latest composition attempt failed.');
  }

  if (compositionArtifactStatus.status === 'missing') {
    finalRenderWarnings.push('No final composition has been generated yet.');
  }
  if (compositionArtifactStatus.status === 'stale') {
    finalRenderWarnings.push('Final composition is stale relative to current scene renders.');
  }

  const finalRenderStatus: WorkflowStepStatus = finalRenderBlockers.length > 0
    ? 'blocked'
    : compositionArtifactStatus.status === 'current' && finalRenderWarnings.length === 0
      ? 'complete'
      : 'needs_attention';

  const steps: WorkflowStepState[] = [
    step('brief', 'Brief', briefStatus, briefBlockers, briefWarnings, { label: briefStatus === 'complete' ? 'Review brief' : 'Complete brief fields', target: 'story' }, 'story'),
    step('story', 'Story', storyStatus, storyBlockers, storyWarnings, { label: hasBeats ? 'Review story and beats' : 'Add script or beats', target: 'story' }, 'story'),
    step('scene_plan', 'Scene Plan', scenePlanStatus, scenePlanBlockers, scenePlanWarnings, { label: intents.length === 0 ? 'Create scene intents from beats' : 'Review and approve scene intents', target: 'story' }, 'story'),
    step('scenes', 'Scenes', scenesStatus, scenesBlockers, scenesWarnings, { label: project.scenes.length === 0 ? 'Materialize scenes from approved intents' : 'Open scene editor', target: 'scenes' }, 'scenes'),
    step('visuals', 'Visuals', visualsStatus, visualBlockers, visualWarnings, { label: failedGenerationCount > 0 ? 'Retry failed generation tasks' : runningGenerationCount > 0 ? 'Monitor active generation jobs' : 'Configure visuals and assets', target: failedGenerationCount > 0 ? 'generation' : 'scenes' }, 'scenes'),
    step('narration', 'Narration', narrationStatus, narrationBlockers, narrationWarnings, { label: staleNarrationCount > 0 || noAudioCount > 0 ? 'Regenerate or link narration audio' : narrationFailedCount > 0 ? 'Retry narration generation' : 'Complete narration content', target: 'scenes' }, 'scenes'),
    step('preview', 'Preview', previewStatus, previewBlockers, previewWarnings, { label: 'Render scenes for preview', target: 'scenes' }, 'scenes'),
    step('final_render', 'Final Render', finalRenderStatus, finalRenderBlockers, finalRenderWarnings, { label: runtime.compositionFailed ? 'Retry final composition' : 'Compose final video', target: 'scenes' }, 'scenes')
  ];

  const recommended = steps.find((entry) => entry.status !== 'complete') ?? steps[steps.length - 1];

  return {
    steps,
    recommendedStepId: recommended.id,
    recommendedAction: recommended.nextAction,
    advisories
  };
}
