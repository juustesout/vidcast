import { deriveCompositionArtifactStatus, deriveCompositionReadiness, deriveSceneRenderStatus } from '@/lib/render/render-status';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { Project } from '@/lib/types/render';
import { validateProject } from '@/lib/validation/project-validation';
import { deriveWorkflowStatus } from '@/lib/workflow/workflow-status';

export interface ProjectValidationReport {
  projectId: string;
  generatedAt: string;
  validation: {
    valid: boolean;
    errorCount: number;
    warningCount: number;
    errors: ReturnType<typeof validateProject>['errors'];
    warnings: ReturnType<typeof validateProject>['warnings'];
  };
  workflow: {
    recommendedStepId: string;
    blockedSteps: string[];
    steps: Array<{
      id: string;
      status: string;
      blockers: string[];
      warnings: string[];
    }>;
  };
  renderPlan: {
    ready: boolean;
    sceneCount: number;
    renderableSceneCount: number;
    plannedSceneCount: number;
    invalidSceneCount: number;
    issueCount: number;
  };
  scenes: Array<{
    sceneId: string;
    order: number;
    status: ReturnType<typeof deriveSceneRenderStatus>['status'];
    isRenderable: boolean;
    isStale: boolean;
    problemCount: number;
    problems: ReturnType<typeof deriveSceneRenderStatus>['problems'];
  }>;
  composition: {
    canCompose: boolean;
    needsSceneRenderIds: string[];
    staleSceneIds: string[];
    blockingSceneIds: string[];
    invalidNarrationAudioSceneIds: string[];
    artifactStatus: ReturnType<typeof deriveCompositionArtifactStatus>['status'];
    artifactReasons: string[];
  };
  blockers: string[];
}

export function deriveProjectValidationReport(project: Project): ProjectValidationReport {
  const validation = validateProject(project);
  const renderPlan = resolveRenderPlan(project);
  const workflow = deriveWorkflowStatus(project);
  const compositionReadiness = deriveCompositionReadiness(project, renderPlan);
  const compositionArtifactStatus = deriveCompositionArtifactStatus(project, renderPlan);

  const sceneStatuses = project.scenes
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((scene) => {
      const status = deriveSceneRenderStatus(project, scene, renderPlan);
      return {
        sceneId: scene.id,
        order: scene.order,
        status: status.status,
        isRenderable: status.isRenderable,
        isStale: status.isStale,
        problemCount: status.problems.length,
        problems: status.problems
      };
    });

  const blockers = [
    ...validation.errors.map((entry) => entry.message),
    ...workflow.steps.filter((step) => step.status === 'blocked').flatMap((step) => step.blockers),
    ...compositionReadiness.blockingSceneIds.map((sceneId) => `Scene ${sceneId} is blocked for composition.`),
    ...compositionReadiness.invalidNarrationAudioSceneIds.map((sceneId) => `Scene ${sceneId} has invalid narration audio.`)
  ];

  return {
    projectId: project.id,
    generatedAt: new Date().toISOString(),
    validation: {
      valid: validation.valid,
      errorCount: validation.errors.length,
      warningCount: validation.warnings.length,
      errors: validation.errors,
      warnings: validation.warnings
    },
    workflow: {
      recommendedStepId: workflow.recommendedStepId,
      blockedSteps: workflow.steps.filter((step) => step.status === 'blocked').map((step) => step.id),
      steps: workflow.steps.map((step) => ({
        id: step.id,
        status: step.status,
        blockers: step.blockers,
        warnings: step.warnings
      }))
    },
    renderPlan: {
      ready: renderPlan.ready,
      sceneCount: renderPlan.scenes.length,
      renderableSceneCount: renderPlan.scenes.filter((scene) => scene.status === 'renderable').length,
      plannedSceneCount: renderPlan.scenes.filter((scene) => scene.status === 'planned').length,
      invalidSceneCount: renderPlan.scenes.filter((scene) => scene.status === 'invalid').length,
      issueCount: renderPlan.issues.length
    },
    scenes: sceneStatuses,
    composition: {
      canCompose: compositionReadiness.canCompose,
      needsSceneRenderIds: compositionReadiness.needsSceneRenderIds,
      staleSceneIds: compositionReadiness.staleSceneIds,
      blockingSceneIds: compositionReadiness.blockingSceneIds,
      invalidNarrationAudioSceneIds: compositionReadiness.invalidNarrationAudioSceneIds,
      artifactStatus: compositionArtifactStatus.status,
      artifactReasons: compositionArtifactStatus.reasons
    },
    blockers: Array.from(new Set(blockers))
  };
}
