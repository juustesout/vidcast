import { describe, expect, it } from 'vitest';

import { describeRecommendedStep, deriveActiveWorkflowStepId } from '@/lib/workflow/workflow-navigation';
import type { DerivedWorkflowStatus, WorkflowStepState } from '@/lib/workflow/workflow-status';

function createStep(overrides: Partial<WorkflowStepState> & Pick<WorkflowStepState, 'id' | 'label' | 'navigationTarget'>): WorkflowStepState {
  return {
    id: overrides.id,
    label: overrides.label,
    status: overrides.status ?? 'ready',
    complete: overrides.complete ?? false,
    blockers: overrides.blockers ?? [],
    warnings: overrides.warnings ?? [],
    nextAction: overrides.nextAction ?? { label: 'Do next', target: overrides.navigationTarget },
    navigationTarget: overrides.navigationTarget
  };
}

function createWorkflow(steps: WorkflowStepState[], recommendedStepId: DerivedWorkflowStatus['recommendedStepId']): DerivedWorkflowStatus {
  return {
    steps,
    recommendedStepId,
    recommendedAction: steps.find((step) => step.id === recommendedStepId)?.nextAction ?? steps[0].nextAction,
    advisories: []
  };
}

describe('workflow navigation helpers', () => {
  it('keeps step to workspace target mapping on existing tabs', () => {
    const workflow = createWorkflow([
      createStep({ id: 'brief', label: 'Brief', navigationTarget: 'story' }),
      createStep({ id: 'story', label: 'Story', navigationTarget: 'story' }),
      createStep({ id: 'scene_plan', label: 'Scene Plan', navigationTarget: 'story' }),
      createStep({ id: 'scenes', label: 'Scenes', navigationTarget: 'scenes' }),
      createStep({ id: 'visuals', label: 'Visuals', navigationTarget: 'scenes' }),
      createStep({ id: 'narration', label: 'Narration', navigationTarget: 'scenes' }),
      createStep({ id: 'preview', label: 'Preview', navigationTarget: 'scenes' }),
      createStep({ id: 'final_render', label: 'Final Render', navigationTarget: 'scenes' })
    ], 'visuals');

    expect(workflow.steps.find((step) => step.id === workflow.recommendedStepId)?.navigationTarget).toBe('scenes');
    expect(workflow.steps.every((step) => step.navigationTarget === 'story' || step.navigationTarget === 'scenes')).toBe(true);
  });

  it('chooses recommended step as active when multiple steps share the active scenes tab', () => {
    const workflow = createWorkflow([
      createStep({ id: 'scenes', label: 'Scenes', navigationTarget: 'scenes', status: 'complete', complete: true }),
      createStep({ id: 'visuals', label: 'Visuals', navigationTarget: 'scenes', status: 'needs_attention' }),
      createStep({ id: 'narration', label: 'Narration', navigationTarget: 'scenes', status: 'ready' })
    ], 'visuals');

    expect(deriveActiveWorkflowStepId(workflow, 'scenes')).toBe('visuals');
  });

  it('does not auto-redirect active step when user is in an unrelated tab', () => {
    const workflow = createWorkflow([
      createStep({ id: 'brief', label: 'Brief', navigationTarget: 'story', status: 'complete', complete: true }),
      createStep({ id: 'story', label: 'Story', navigationTarget: 'story', status: 'complete', complete: true }),
      createStep({ id: 'scenes', label: 'Scenes', navigationTarget: 'scenes', status: 'needs_attention' })
    ], 'scenes');

    expect(deriveActiveWorkflowStepId(workflow, 'assets')).toBeNull();
    expect(workflow.recommendedStepId).toBe('scenes');
  });

  it('provides blocker-focused copy for blocked recommended steps', () => {
    const blocked = createStep({
      id: 'scene_plan',
      label: 'Scene Plan',
      navigationTarget: 'story',
      status: 'blocked',
      blockers: ['Beats are required before scene planning.']
    });

    const copy = describeRecommendedStep(blocked);
    expect(copy.description).toBe('Beats are required before scene planning.');
    expect(copy.buttonLabel).toBe('Open blocker context');
  });

  it('does not advertise completed step as a next action', () => {
    const completeStep = createStep({
      id: 'brief',
      label: 'Brief',
      navigationTarget: 'story',
      status: 'complete',
      complete: true,
      nextAction: { label: 'Complete brief fields', target: 'story' }
    });

    const copy = describeRecommendedStep(completeStep);
    expect(copy.description).toContain('Step complete.');
    expect(copy.buttonLabel).toBe('Review step');
  });

  it('keeps derived workflow status independent from active tab visualization', () => {
    const workflow = createWorkflow([
      createStep({ id: 'brief', label: 'Brief', navigationTarget: 'story', status: 'complete', complete: true }),
      createStep({ id: 'story', label: 'Story', navigationTarget: 'story', status: 'needs_attention' }),
      createStep({ id: 'scenes', label: 'Scenes', navigationTarget: 'scenes', status: 'blocked', blockers: ['No scenes yet.'] })
    ], 'story');

    const storyActive = deriveActiveWorkflowStepId(workflow, 'story');
    const scenesActive = deriveActiveWorkflowStepId(workflow, 'scenes');

    expect(storyActive).toBe('story');
    expect(scenesActive).toBe('scenes');
    expect(workflow.steps.find((step) => step.id === 'scenes')?.status).toBe('blocked');
  });
});
