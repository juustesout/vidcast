import { deriveProductionPlan, groupProductionActionsByScene, type DeriveProductionPlanOptions, type ProductionPlan, type ProductionPlannedAction } from '@/lib/production/production-planner';
import type { Project } from '@/lib/types/render';

export interface ProductionPlanDerivedFlags {
  hasBlockingActions: boolean;
  hasWaitingDependencies: boolean;
  readyActionCount: number;
}

export interface ProductionPlanReport {
  projectId: string;
  generatedAt: string;
  plan: Pick<ProductionPlan, 'actions' | 'summary'>;
  groupedByScene: Array<{ sceneId: string; sceneOrder: number; actions: ProductionPlannedAction[] }>;
  derivedFlags: ProductionPlanDerivedFlags;
}

export function deriveProductionPlanReport(project: Project, options: DeriveProductionPlanOptions = {}): ProductionPlanReport {
  const plan = deriveProductionPlan(project, options);
  const groupedByScene = groupProductionActionsByScene(plan);

  return {
    projectId: project.id,
    generatedAt: new Date().toISOString(),
    plan: {
      actions: plan.actions,
      summary: plan.summary
    },
    groupedByScene,
    derivedFlags: {
      hasBlockingActions: plan.actions.some((action) => action.status === 'blocked'),
      hasWaitingDependencies: plan.actions.some((action) => action.status === 'waiting_dependency'),
      readyActionCount: plan.actions.filter((action) => action.status === 'ready' && action.execute).length
    }
  };
}
