import type { DerivedWorkflowStatus, WorkflowNavigationTarget, WorkflowStepId, WorkflowStepState } from '@/lib/workflow/workflow-status';

export interface RecommendedStepPresentation {
  description: string;
  buttonLabel: string;
}

export function deriveActiveWorkflowStepId(workflow: DerivedWorkflowStatus, activeTarget: WorkflowNavigationTarget): WorkflowStepId | null {
  const matching = workflow.steps.filter((step) => step.navigationTarget === activeTarget);
  if (matching.length === 0) {
    return null;
  }
  if (matching.length === 1) {
    return matching[0].id;
  }

  const recommendedMatch = matching.find((step) => step.id === workflow.recommendedStepId);
  if (recommendedMatch) {
    return recommendedMatch.id;
  }

  const actionable = matching.find((step) => step.status !== 'complete');
  return actionable?.id ?? matching[0].id;
}

export function describeRecommendedStep(step: WorkflowStepState): RecommendedStepPresentation {
  if (step.status === 'blocked') {
    return {
      description: step.blockers[0] ?? 'This step is blocked and needs upstream changes first.',
      buttonLabel: 'Open blocker context'
    };
  }

  if (step.status === 'complete') {
    return {
      description: 'Step complete. You can review or continue to the next incomplete step.',
      buttonLabel: 'Review step'
    };
  }

  return {
    description: step.nextAction.label,
    buttonLabel: 'Open recommended step'
  };
}
