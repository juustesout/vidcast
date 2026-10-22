import type { Project } from '@/lib/types/render';
import { deriveReadyProductionActions, type DeriveProductionPlanOptions, type ProductionActionType, type ProductionPlan, type ProductionPlannedAction } from './production-planner';

export interface ProductionRunnerConfig {
  // Partial for backward compatibility: callers that predate a newly added
  // action type keep working and fall back to one execution at a time.
  limits: Partial<Record<ProductionActionType, number>>;
  maxIterations: number;
}

export type ProductionRunnerResultStatus = 'completed' | 'partial' | 'unresolved' | 'failed';

export type ProductionRunnerEventCode =
  | 'run_started'
  | 'plan_created'
  | 'action_scheduled'
  | 'action_started'
  | 'action_completed'
  | 'action_failed'
  | 'action_skipped'
  | 'action_waiting'
  | 'action_blocked'
  | 'action_current'
  | 'action_running'
  | 'video_poll_scheduled'
  | 'video_poll_completed'
  | 'refresh_started'
  | 'refresh_completed'
  | 'composition_started'
  | 'composition_completed'
  | 'composition_failed'
  | 'run_recovered'
  | 'run_superseded'
  | 'run_completed'
  | 'run_stopped_unresolved'
  | 'run_failed';

export type ProductionRunnerEventStatus = 'info' | 'scheduled' | 'started' | 'completed' | 'failed' | 'skipped' | 'waiting' | 'blocked' | 'running' | 'current' | 'stopped';

export interface ProductionRunnerEventError {
  message: string;
  code?: string;
  endpoint?: string;
  providerStatus?: string;
  providerError?: string;
  httpStatus?: number;
  sceneId?: string;
  actionType?: ProductionActionType;
  attemptId?: string;
  details?: string;
}

export interface ProductionRunnerEvent {
  timestamp: string;
  iteration: number;
  code: ProductionRunnerEventCode;
  status: ProductionRunnerEventStatus;
  actionType?: ProductionActionType;
  actionId?: string;
  sceneId?: string;
  message: string;
  error?: ProductionRunnerEventError;
}

export interface ProductionActionExecutionOutcome {
  message?: string;
  code?: string;
  endpoint?: string;
  providerStatus?: string;
  providerError?: string;
  httpStatus?: number;
  sceneId?: string;
  attemptId?: string;
  details?: string;
}

export class ProductionRunnerExecutionError extends Error {
  diagnostics?: ProductionActionExecutionOutcome;

  constructor(message: string, diagnostics?: ProductionActionExecutionOutcome) {
    super(message);
    this.name = 'ProductionRunnerExecutionError';
    this.diagnostics = diagnostics;
  }
}

export interface ProductionRunnerProgress {
  iteration: number;
  project: Project;
  plan: ProductionPlan;
  completedActionIds: string[];
  failedActionIds: string[];
  runningActionIds: string[];
  events: ProductionRunnerEvent[];
}

export interface ProductionRunnerResult {
  status: ProductionRunnerResultStatus;
  project: Project;
  iterations: number;
  completedActionIds: string[];
  failedActionIds: string[];
  unresolvedActions: ProductionPlannedAction[];
  events: ProductionRunnerEvent[];
}

export interface RunProductionBatchInput {
  initialProject: Project;
  derivePlan: (project: Project, options: DeriveProductionPlanOptions) => ProductionPlan;
  executeAction: (action: ProductionPlannedAction) => Promise<ProductionActionExecutionOutcome | void>;
  refreshProject: () => Promise<Project>;
  skippedActionIds?: string[];
  // Action ids already completed before the batch starts (for example restored
  // from a recovered run). They are seeded into the planner's completed set so a
  // forced run does not re-execute work that already produced its artifacts, but
  // they are NOT treated as executed in this batch: if an artifact is missing or
  // stale the planner still re-derives the action as ready and it runs.
  initialCompletedActionIds?: string[];
  // Action ids already known to be failed before the batch starts (for example
  // interrupted work restored during recovery). They are treated as failed and
  // never executed.
  initialFailedActionIds?: string[];
  config?: Partial<ProductionRunnerConfig>;
  onProgress?: (progress: ProductionRunnerProgress) => void;
  onEvent?: (event: ProductionRunnerEvent) => void;
}

const DEFAULT_CONFIG: ProductionRunnerConfig = {
  limits: {
    image_generate: 2,
    stock_select: 2,
    html_render: 1,
    video_submit: 2,
    video_poll: 4,
    narration_generate: 2,
    presenter_submit: 1,
    presenter_poll: 2,
    scene_render: 1,
    final_compose: 1
  },
  maxIterations: 24
};

function mergeConfig(config?: Partial<ProductionRunnerConfig>): ProductionRunnerConfig {
  return {
    limits: {
      ...DEFAULT_CONFIG.limits,
      ...(config?.limits ?? {})
    },
    maxIterations: config?.maxIterations ?? DEFAULT_CONFIG.maxIterations
  };
}

function statusSignature(plan: ProductionPlan): string {
  return plan.actions.map((action) => `${action.id}:${action.status}:${action.reason ?? ''}`).join('|');
}

// Polls are repeatable: the planner keeps deriving them as ready while the
// external job is still running, so they must not be suppressed by the
// within-batch dedup set.
function isRepeatablePoll(type: ProductionActionType): boolean {
  return type === 'video_poll' || type === 'presenter_poll';
}

function sanitizeDiagnostics(outcome?: Partial<ProductionActionExecutionOutcome>): ProductionRunnerEventError | undefined {
  if (!outcome) {
    return undefined;
  }

  const message = typeof outcome.message === 'string' && outcome.message.trim() ? outcome.message : undefined;
  if (!message && !outcome.code && !outcome.endpoint && !outcome.providerStatus && !outcome.providerError && !outcome.httpStatus && !outcome.sceneId && !outcome.attemptId && !outcome.details) {
    return undefined;
  }

  return {
    message: message ?? 'Action failed.',
    code: typeof outcome.code === 'string' ? outcome.code : undefined,
    endpoint: typeof outcome.endpoint === 'string' ? outcome.endpoint : undefined,
    providerStatus: typeof outcome.providerStatus === 'string' ? outcome.providerStatus : undefined,
    providerError: typeof outcome.providerError === 'string' ? outcome.providerError : undefined,
    httpStatus: typeof outcome.httpStatus === 'number' ? outcome.httpStatus : undefined,
    sceneId: typeof outcome.sceneId === 'string' ? outcome.sceneId : undefined,
    attemptId: typeof outcome.attemptId === 'string' ? outcome.attemptId : undefined,
    details: typeof outcome.details === 'string' ? outcome.details : undefined
  };
}

function normalizeExecutionError(error: unknown): ProductionRunnerEventError {
  if (error instanceof ProductionRunnerExecutionError) {
    return sanitizeDiagnostics({
      message: error.message,
      ...(error.diagnostics ?? {})
    }) ?? { message: error.message };
  }

  if (error instanceof Error) {
    return { message: error.message };
  }

  if (typeof error === 'string') {
    return { message: error };
  }

  return { message: 'Action failed unexpectedly.' };
}

function createActionLabel(action: ProductionPlannedAction): string {
  const sceneLabel = action.sceneId ? `Scene ${action.sceneOrder ?? '?'} ` : '';
  switch (action.type) {
    case 'image_generate':
      return `${sceneLabel}Image`;
    case 'stock_select':
      return `${sceneLabel}Stock`;
    case 'html_render':
      return `${sceneLabel}HTML still`;
    case 'video_submit':
      return `${sceneLabel}Video`;
    case 'video_poll':
      return `${sceneLabel}Video poll`;
    case 'narration_generate':
      return `${sceneLabel}TTS`;
    case 'presenter_submit':
      return `${sceneLabel}Presenter`;
    case 'presenter_poll':
      return `${sceneLabel}Presenter poll`;
    case 'scene_render':
      return `${sceneLabel}Render`;
    case 'final_compose':
      return 'Compose';
    default:
      return action.type;
  }
}

function determineResultStatus(unresolvedActions: ProductionPlannedAction[], failedCount: number): ProductionRunnerResultStatus {
  if (unresolvedActions.length === 0 && failedCount === 0) {
    return 'completed';
  }
  if (unresolvedActions.length === 0 && failedCount > 0) {
    return 'partial';
  }
  if (failedCount > 0) {
    return 'failed';
  }
  return 'unresolved';
}

interface ExecutionItemResult {
  action: ProductionPlannedAction;
  ok: boolean;
  outcome?: ProductionActionExecutionOutcome;
  error?: ProductionRunnerEventError;
}

async function executeBounded(
  actions: ProductionPlannedAction[],
  limit: number,
  execute: (action: ProductionPlannedAction) => Promise<ProductionActionExecutionOutcome | void>,
  onSettled?: (item: ExecutionItemResult) => void
): Promise<ExecutionItemResult[]> {
  if (actions.length === 0) {
    return [];
  }

  // A worker pool (rather than fixed sequential slices) reports every settled
  // action immediately. This matters for long `scene_render` groups: with the
  // old slice loop, ten completed renders produced no run progress at all until
  // the final render in the group finished, so a slow or stuck render looked
  // exactly like a run that had stopped.
  const results: ExecutionItemResult[] = new Array(actions.length);
  const safeLimit = Math.max(1, Math.floor(limit) || 1);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= actions.length) {
        return;
      }

      const action = actions[index];
      let item: ExecutionItemResult;
      try {
        const outcome = await execute(action);
        item = { action, ok: true, outcome: outcome ?? undefined };
      } catch (error) {
        item = { action, ok: false, error: normalizeExecutionError(error) };
      }

      results[index] = item;
      onSettled?.(item);
    }
  };

  const workers = Array.from({ length: Math.min(safeLimit, actions.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function runProductionBatch(input: RunProductionBatchInput): Promise<ProductionRunnerResult> {
  const config = mergeConfig(input.config);
  const skippedActionIds = new Set(input.skippedActionIds ?? []);
  const completedActionIds = new Set<string>(input.initialCompletedActionIds ?? []);
  // Ids completed by *this* batch execution only. Used to avoid re-running an
  // action within the batch without suppressing a genuine re-run of a recovered
  // action whose artifact turned out to be missing (see `initialCompletedActionIds`).
  const executedActionIds = new Set<string>();
  const failedActionIds = new Set<string>(input.initialFailedActionIds ?? []);
  const runningActionIds = new Set<string>();
  const events: ProductionRunnerEvent[] = [];
  const emittedObservationKeys = new Set<string>();
  let compositionAttempted = false;

  const emit = (event: Omit<ProductionRunnerEvent, 'timestamp'>): void => {
    const withTimestamp: ProductionRunnerEvent = {
      timestamp: new Date().toISOString(),
      ...event
    };
    events.push(withTimestamp);
    input.onEvent?.(withTimestamp);
  };

  let project = input.initialProject;
  let previousSignature = '';
  let iteration = 0;

  emit({
    iteration,
    code: 'run_started',
    status: 'started',
    message: 'Production run started.'
  });

  while (iteration < config.maxIterations) {
    iteration += 1;

    const plan = input.derivePlan(project, {
      skippedActionIds: Array.from(skippedActionIds),
      failedActionIds: Array.from(failedActionIds),
      completedActionIds: Array.from(completedActionIds),
      compositionAttempted
    });

    emit({
      iteration,
      code: 'plan_created',
      status: 'info',
      message: `${plan.summary.ready} actions ready. ${plan.summary.waiting} waiting. ${plan.summary.blocked} blocked.`
    });

    for (const action of plan.actions) {
      if (action.status === 'waiting_dependency' || action.status === 'blocked' || action.status === 'skipped' || action.status === 'current' || action.status === 'running') {
        const key = `${action.id}:${action.status}:${action.reason ?? ''}`;
        if (emittedObservationKeys.has(key)) {
          continue;
        }
        emittedObservationKeys.add(key);

        const actionLabel = createActionLabel(action);
        if (action.status === 'waiting_dependency') {
          emit({
            iteration,
            code: 'action_waiting',
            status: 'waiting',
            actionType: action.type,
            actionId: action.id,
            sceneId: action.sceneId,
            message: `${actionLabel} waiting${action.reason ? `: ${action.reason}` : '.'}`
          });
        } else if (action.status === 'blocked') {
          emit({
            iteration,
            code: 'action_blocked',
            status: 'blocked',
            actionType: action.type,
            actionId: action.id,
            sceneId: action.sceneId,
            message: `${actionLabel} blocked${action.reason ? `: ${action.reason}` : '.'}`
          });
        } else if (action.status === 'skipped') {
          emit({
            iteration,
            code: 'action_skipped',
            status: 'skipped',
            actionType: action.type,
            actionId: action.id,
            sceneId: action.sceneId,
            message: `${actionLabel} skipped${action.reason ? `: ${action.reason}` : '.'}`
          });
        } else if (action.status === 'current') {
          emit({
            iteration,
            code: 'action_current',
            status: 'current',
            actionType: action.type,
            actionId: action.id,
            sceneId: action.sceneId,
            message: `${actionLabel} already current${action.reason ? `: ${action.reason}` : '.'}`
          });
        } else if (action.status === 'running') {
          emit({
            iteration,
            code: 'action_running',
            status: 'running',
            actionType: action.type,
            actionId: action.id,
            sceneId: action.sceneId,
            message: `${actionLabel} currently running${action.reason ? `: ${action.reason}` : '.'}`
          });
        }
      }
    }

    input.onProgress?.({
      iteration,
      project,
      plan,
      completedActionIds: Array.from(completedActionIds),
      failedActionIds: Array.from(failedActionIds),
      runningActionIds: Array.from(runningActionIds),
      events: [...events]
    });

    const readyActions = deriveReadyProductionActions(plan)
      .filter((action) => !executedActionIds.has(action.id))
      .filter((action) => !failedActionIds.has(action.id));

    if (readyActions.length === 0) {
      const unresolved = plan.actions.filter((action) => action.status === 'running' || action.status === 'waiting_dependency' || action.status === 'ready');
      if (unresolved.length === 0 || statusSignature(plan) === previousSignature) {
        const unresolvedActions = plan.actions.filter((action) => action.status !== 'current' && action.status !== 'skipped');
        const status = determineResultStatus(unresolvedActions, failedActionIds.size);
        emit({
          iteration,
          code: unresolvedActions.length === 0 ? 'run_completed' : 'run_stopped_unresolved',
          status: unresolvedActions.length === 0 ? 'completed' : 'stopped',
          message: unresolvedActions.length === 0
            ? `Production run completed. ${completedActionIds.size} action(s) completed.`
            : `Production run stopped with ${unresolvedActions.length} unresolved action(s).`
        });

        return {
          status,
          project,
          iterations: iteration,
          completedActionIds: Array.from(completedActionIds),
          failedActionIds: Array.from(failedActionIds),
          unresolvedActions,
          events
        };
      }

      previousSignature = statusSignature(plan);
      emit({ iteration, code: 'refresh_started', status: 'info', message: 'Refreshing project state for replan.' });
      project = await input.refreshProject();
      emit({ iteration, code: 'refresh_completed', status: 'info', message: 'Project state refreshed.' });
      continue;
    }

    previousSignature = statusSignature(plan);

    const executionOrder: ProductionActionType[] = ['stock_select', 'image_generate', 'html_render', 'video_submit', 'video_poll', 'narration_generate', 'presenter_submit', 'presenter_poll', 'scene_render', 'final_compose'];
    let executed = 0;

    for (const type of executionOrder) {
      const matching = readyActions.filter((action) => action.type === type);
      if (matching.length === 0) {
        continue;
      }

      for (const action of matching) {
        emit({
          iteration,
          code: action.type === 'video_poll' ? 'video_poll_scheduled' : 'action_scheduled',
          status: 'scheduled',
          actionType: action.type,
          actionId: action.id,
          sceneId: action.sceneId,
          message: `${createActionLabel(action)} scheduled.`
        });
      }

      const handleSettled = (item: ExecutionItemResult): void => {
        executed += 1;
        if (item.ok) {
          completedActionIds.add(item.action.id);
          // `video_poll` and `presenter_poll` are repeatable actions: the
          // planner keeps deriving them as ready while the external job is
          // still running, so they must not be suppressed by the within-batch
          // dedup set. They stay bounded by the run's poll/action limits.
          if (!isRepeatablePoll(item.action.type)) {
            executedActionIds.add(item.action.id);
          }
          if (type === 'final_compose') {
            compositionAttempted = true;
          }

          emit({
            iteration,
            code: item.action.type === 'video_poll' ? 'video_poll_completed' : item.action.type === 'final_compose' ? 'composition_completed' : 'action_completed',
            status: 'completed',
            actionType: item.action.type,
            actionId: item.action.id,
            sceneId: item.action.sceneId,
            message: item.outcome?.message?.trim()
              ? `${createActionLabel(item.action)} completed: ${item.outcome.message}`
              : `${createActionLabel(item.action)} completed.`
          });
        } else {
          failedActionIds.add(item.action.id);
          if (type === 'final_compose') {
            compositionAttempted = true;
          }

          emit({
            iteration,
            code: item.action.type === 'final_compose' ? 'composition_failed' : 'action_failed',
            status: 'failed',
            actionType: item.action.type,
            actionId: item.action.id,
            sceneId: item.action.sceneId,
            message: `${createActionLabel(item.action)} failed: ${item.error?.message ?? 'Unknown error.'}`,
            error: item.error
              ? {
                  ...item.error,
                  sceneId: item.action.sceneId ?? item.error.sceneId,
                  actionType: item.action.type
                }
              : undefined
          });
        }

        input.onProgress?.({
          iteration,
          project,
          plan,
          completedActionIds: Array.from(completedActionIds),
          failedActionIds: Array.from(failedActionIds),
          runningActionIds: Array.from(runningActionIds),
          events: [...events]
        });
      };

      await executeBounded(
        matching,
        config.limits[type] ?? 1,
        async (action) => {
          runningActionIds.add(action.id);
          emit({
            iteration,
            code: action.type === 'final_compose' ? 'composition_started' : 'action_started',
            status: 'started',
            actionType: action.type,
            actionId: action.id,
            sceneId: action.sceneId,
            message: `${createActionLabel(action)} started.`
          });
          input.onProgress?.({
            iteration,
            project,
            plan,
            completedActionIds: Array.from(completedActionIds),
            failedActionIds: Array.from(failedActionIds),
            runningActionIds: Array.from(runningActionIds),
            events: [...events]
          });

          try {
            return await input.executeAction(action);
          } finally {
            runningActionIds.delete(action.id);
          }
        },
        handleSettled
      );
    }

    if (executed === 0) {
      const finalPlan = input.derivePlan(project, {
        skippedActionIds: Array.from(skippedActionIds),
        failedActionIds: Array.from(failedActionIds),
        completedActionIds: Array.from(completedActionIds),
        compositionAttempted
      });
      const unresolvedActions = finalPlan.actions.filter((action) => action.status !== 'current' && action.status !== 'skipped');
      const status = determineResultStatus(unresolvedActions, failedActionIds.size);
      emit({
        iteration,
        code: unresolvedActions.length === 0 ? 'run_completed' : 'run_stopped_unresolved',
        status: unresolvedActions.length === 0 ? 'completed' : 'stopped',
        message: unresolvedActions.length === 0
          ? `Production run completed. ${completedActionIds.size} action(s) completed.`
          : `Production run stopped with ${unresolvedActions.length} unresolved action(s).`
      });

      return {
        status,
        project,
        iterations: iteration,
        completedActionIds: Array.from(completedActionIds),
        failedActionIds: Array.from(failedActionIds),
        unresolvedActions,
        events
      };
    }

    emit({ iteration, code: 'refresh_started', status: 'info', message: 'Refreshing project state for replan.' });
    project = await input.refreshProject();
    emit({ iteration, code: 'refresh_completed', status: 'info', message: 'Project state refreshed.' });
  }

  const finalPlan = input.derivePlan(project, {
    skippedActionIds: Array.from(skippedActionIds),
    failedActionIds: Array.from(failedActionIds),
    completedActionIds: Array.from(completedActionIds),
    compositionAttempted
  });
  const unresolvedActions = finalPlan.actions.filter((action) => action.status !== 'current' && action.status !== 'skipped');
  const status = determineResultStatus(unresolvedActions, failedActionIds.size);
  emit({
    iteration,
    code: 'run_stopped_unresolved',
    status: 'stopped',
    message: `Production run stopped after reaching max iterations (${config.maxIterations}).`
  });

  return {
    status,
    project,
    iterations: iteration,
    completedActionIds: Array.from(completedActionIds),
    failedActionIds: Array.from(failedActionIds),
    unresolvedActions,
    events
  };
}

export function createProductionRunnerError(message: string, diagnostics?: ProductionActionExecutionOutcome): ProductionRunnerExecutionError {
  return new ProductionRunnerExecutionError(message, sanitizeDiagnostics(diagnostics));
}
