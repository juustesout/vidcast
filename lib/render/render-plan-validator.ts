import type { RenderIssue, RenderPlan } from '@/lib/types/render';

export interface RenderPlanValidationResult {
  valid: boolean;
  errors: RenderIssue[];
  warnings: RenderIssue[];
}

export function validateRenderPlan(plan: RenderPlan): RenderPlanValidationResult {
  const errors: RenderIssue[] = [];
  const warnings: RenderIssue[] = [];

  if (!plan.ready) {
    errors.push({
      severity: 'error',
      code: 'render.plan.notReady',
      path: 'ready',
      message: 'Render plan is not ready.'
    });
  }

  if (plan.scenes.length !== 1) {
    errors.push({
      severity: 'error',
      code: 'render.plan.sceneCount.invalid',
      path: 'scenes',
      message: 'P5 renderer expects exactly one resolved scene.'
    });
  }

  const scene = plan.scenes[0];
  if (scene) {
    if (scene.status !== 'renderable') {
      errors.push({
        severity: 'error',
        code: 'render.scene.notRenderable',
        path: `scenes.${scene.sceneId}`,
        message: 'Scene is not renderable.'
      });
    }

    for (const issue of scene.issues) {
      if (issue.severity === 'error') {
        errors.push({
          severity: 'error',
          code: issue.code,
          path: `scenes.${scene.sceneId}`,
          message: issue.message
        });
      } else {
        warnings.push({
          severity: 'warning',
          code: issue.code,
          path: `scenes.${scene.sceneId}`,
          message: issue.message
        });
      }
    }
  }

  for (const issue of plan.issues) {
    if (issue.severity === 'error') {
      errors.push(issue);
    } else {
      warnings.push(issue);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
