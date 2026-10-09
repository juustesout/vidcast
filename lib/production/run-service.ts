import { generateSceneImage, SceneImageGenerationError } from '@/lib/generation/image-generation-service';
import { generateSceneNarration, SceneNarrationGenerationError } from '@/lib/generation/narration-service';
import { refreshVideoGenerationAttempt, SceneVideoGenerationError, submitSceneVideoGeneration } from '@/lib/generation/video-generation-service';
import { CompositionServiceError, videoCompositionService } from '@/lib/render/video-composition-service';
import { SceneRenderError } from '@/lib/render/renderer';
import { sceneRenderService } from '@/lib/render/scene-render-service';
import { projectStore, type ProjectStore } from '@/lib/storage/project-store';
import { createId } from '@/lib/utils/ids';
import type { ProductionActionType, ProductionPlannedAction } from './production-planner';
import { deriveProductionPlan } from './production-planner';
import { createProductionRunnerError, runProductionBatch, type ProductionActionExecutionOutcome, type ProductionRunnerEvent } from './production-runner';
import { assertRunPolicyPreflight, resolveRunPolicy, resolveRunPolicyServerConfig, type RunPolicyRequest, type RunPolicyServerConfig } from './run-policy';
import { InMemoryRunRegistry } from './run-registry';
import type { HeadlessRunAcceptedConfig, HeadlessRunLogPage, HeadlessRunSnapshot, RunMode, RunProviderSelection } from './run-types';

export interface StartProductionRunRequest {
  projectId: string;
  policy?: RunPolicyRequest;
  maxIterations?: number;
  limits?: Partial<Record<ProductionActionType, number>>;
}

export interface StartProductionRunResponse {
  run: HeadlessRunSnapshot;
  reused: boolean;
}

export interface RunServiceConfig {
  maxConcurrentRuns: number;
  runner: {
    maxIterations: number;
    maxActionExecutions: number;
    maxVideoPolls: number;
    limits: Record<ProductionActionType, number>;
  };
  registry: {
    maxEventsPerRun: number;
    retentionMs: number;
    maxLogPageLimit: number;
  };
  policy: RunPolicyServerConfig;
}

export class RunServiceError extends Error {
  readonly code:
    | 'INVALID_ARGUMENT'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'POLICY_DENIED'
    | 'PROVIDER_NOT_CONFIGURED'
    | 'PRECONDITION_FAILED'
    | 'INTERNAL_ERROR';
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code:
      | 'INVALID_ARGUMENT'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'POLICY_DENIED'
      | 'PROVIDER_NOT_CONFIGURED'
      | 'PRECONDITION_FAILED'
      | 'INTERNAL_ERROR',
    status: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'RunServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface ServiceDependencies {
  store: Pick<ProjectStore, 'getProject'>;
  runBatch: typeof runProductionBatch;
  derivePlan: typeof deriveProductionPlan;
  generateImage: typeof generateSceneImage;
  submitVideo: typeof submitSceneVideoGeneration;
  pollVideo: typeof refreshVideoGenerationAttempt;
  generateNarration: typeof generateSceneNarration;
  renderScene: typeof sceneRenderService.renderScene;
  composeProject: typeof videoCompositionService.composeProject;
  now: () => string;
}

const defaultDependencies: ServiceDependencies = {
  store: projectStore,
  runBatch: runProductionBatch,
  derivePlan: deriveProductionPlan,
  generateImage: generateSceneImage,
  submitVideo: submitSceneVideoGeneration,
  pollVideo: refreshVideoGenerationAttempt,
  generateNarration: generateSceneNarration,
  renderScene: sceneRenderService.renderScene.bind(sceneRenderService),
  composeProject: videoCompositionService.composeProject.bind(videoCompositionService),
  now: () => new Date().toISOString()
};

function envInt(value: string | undefined, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function defaultActionLimits(): Record<ProductionActionType, number> {
  return {
    image_generate: envInt(process.env.PRODUCTION_RUN_CONCURRENCY_IMAGE, 2, 1, 16),
    video_submit: envInt(process.env.PRODUCTION_RUN_CONCURRENCY_VIDEO_SUBMIT, 2, 1, 16),
    video_poll: envInt(process.env.PRODUCTION_RUN_CONCURRENCY_VIDEO_POLL, 4, 1, 32),
    narration_generate: envInt(process.env.PRODUCTION_RUN_CONCURRENCY_NARRATION, 2, 1, 16),
    scene_render: envInt(process.env.PRODUCTION_RUN_CONCURRENCY_RENDER, 1, 1, 8),
    final_compose: envInt(process.env.PRODUCTION_RUN_CONCURRENCY_COMPOSE, 1, 1, 4)
  };
}

function buildDefaultConfig(): RunServiceConfig {
  return {
    maxConcurrentRuns: envInt(process.env.PRODUCTION_RUN_MAX_ACTIVE, 2, 1, 32),
    runner: {
      maxIterations: envInt(process.env.PRODUCTION_RUN_MAX_ITERATIONS, 24, 1, 500),
      maxActionExecutions: envInt(process.env.PRODUCTION_RUN_MAX_ACTIONS, 500, 1, 50_000),
      maxVideoPolls: envInt(process.env.PRODUCTION_RUN_MAX_VIDEO_POLLS, 120, 1, 50_000),
      limits: defaultActionLimits()
    },
    registry: {
      maxEventsPerRun: envInt(process.env.PRODUCTION_RUN_MAX_EVENTS, 4000, 100, 200_000),
      retentionMs: envInt(process.env.PRODUCTION_RUN_RETENTION_MS, 6 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000),
      maxLogPageLimit: envInt(process.env.PRODUCTION_RUN_MAX_LOG_PAGE_LIMIT, 250, 10, 2000)
    },
    policy: resolveRunPolicyServerConfig()
  };
}

function mergePerActionLimits(
  defaults: Record<ProductionActionType, number>,
  override: Partial<Record<ProductionActionType, number>> | undefined
): Record<ProductionActionType, number> {
  if (!override) {
    return { ...defaults };
  }

  return {
    image_generate: envInt(String(override.image_generate ?? defaults.image_generate), defaults.image_generate, 1, 64),
    video_submit: envInt(String(override.video_submit ?? defaults.video_submit), defaults.video_submit, 1, 64),
    video_poll: envInt(String(override.video_poll ?? defaults.video_poll), defaults.video_poll, 1, 64),
    narration_generate: envInt(String(override.narration_generate ?? defaults.narration_generate), defaults.narration_generate, 1, 64),
    scene_render: envInt(String(override.scene_render ?? defaults.scene_render), defaults.scene_render, 1, 64),
    final_compose: envInt(String(override.final_compose ?? defaults.final_compose), defaults.final_compose, 1, 64)
  };
}

function resolveRunConfig(config: RunServiceConfig, input: StartProductionRunRequest, policy: HeadlessRunAcceptedConfig['policy']): HeadlessRunAcceptedConfig {
  const requestedIterations = input.maxIterations;
  const maxIterations = typeof requestedIterations === 'number'
    ? Math.min(config.runner.maxIterations, Math.max(1, Math.floor(requestedIterations)))
    : config.runner.maxIterations;

  const perActionConcurrency = mergePerActionLimits(config.runner.limits, input.limits);

  return {
    policy,
    limits: {
      maxIterations,
      maxActionExecutions: config.runner.maxActionExecutions,
      maxVideoPolls: config.runner.maxVideoPolls,
      perActionConcurrency
    }
  };
}

function statusFromSceneRenderCode(code: SceneRenderError['code']): number {
  if (code === 'MISSING_ASSET') {
    return 404;
  }
  if (code === 'INVALID_PLAN' || code === 'UNSUPPORTED_RENDER') {
    return 422;
  }
  if (code === 'FFMPEG_UNAVAILABLE') {
    return 503;
  }
  return 500;
}

function statusFromCompositionCode(code: CompositionServiceError['code']): number {
  if (code === 'PROJECT_NOT_FOUND') {
    return 404;
  }
  if (code === 'SCENE_MISSING' || code === 'SCENE_RENDER_MISSING' || code === 'RENDER_FILE_MISSING' || code === 'INCOMPATIBLE_RENDER') {
    return 422;
  }
  if (code === 'FFMPEG_UNAVAILABLE') {
    return 503;
  }
  return 500;
}

export class HeadlessProductionRunService {
  private readonly config: RunServiceConfig;
  private readonly dependencies: ServiceDependencies;
  private readonly registry: InMemoryRunRegistry;
  private readonly queue: string[] = [];
  private activeWorkers = 0;
  private dispatchLoopScheduled = false;

  constructor(config: RunServiceConfig = buildDefaultConfig(), dependencies: Partial<ServiceDependencies> = {}) {
    this.config = config;
    this.dependencies = {
      ...defaultDependencies,
      ...dependencies
    };
    this.registry = new InMemoryRunRegistry(this.config.registry);
  }

  async startOrReuseRun(input: StartProductionRunRequest): Promise<StartProductionRunResponse> {
    const projectId = input.projectId?.trim();
    if (!projectId) {
      throw new RunServiceError('projectId is required.', 'INVALID_ARGUMENT', 400);
    }

    this.registry.sweepExpired();

    const existing = this.registry.getActiveRunByProject(projectId);
    if (existing) {
      return {
        run: existing,
        reused: true
      };
    }

    const project = await this.dependencies.store.getProject(projectId);
    if (!project) {
      throw new RunServiceError('Project not found.', 'NOT_FOUND', 404, { projectId });
    }

    let policy;
    try {
      policy = resolveRunPolicy(input.policy, this.config.policy);
      assertRunPolicyPreflight(project, policy);
    } catch (error) {
      if (error instanceof Error && 'code' in error && 'status' in error) {
        const typed = error as Error & { code?: string; status?: number; details?: Record<string, unknown> };
        if (typed.code === 'POLICY_DENIED' || typed.code === 'PROVIDER_NOT_ALLOWED') {
          throw new RunServiceError(typed.message, 'POLICY_DENIED', typed.status ?? 403, typed.details);
        }
        if (typed.code === 'PROVIDER_NOT_CONFIGURED') {
          throw new RunServiceError(typed.message, 'PROVIDER_NOT_CONFIGURED', typed.status ?? 409, typed.details);
        }
        throw new RunServiceError(typed.message, 'PRECONDITION_FAILED', typed.status ?? 409, typed.details);
      }
      throw new RunServiceError('Run policy preflight failed.', 'PRECONDITION_FAILED', 409);
    }

    const acceptedConfig = resolveRunConfig(this.config, input, policy);
    const runId = createId('run');
    const run = this.registry.createRun({
      runId,
      projectId,
      acceptedConfig
    });

    this.queue.push(runId);
    this.scheduleDispatchLoop();

    return {
      run,
      reused: false
    };
  }

  getRun(runId: string): HeadlessRunSnapshot {
    const value = this.registry.getRun(runId);
    if (!value) {
      throw this.notFoundRunError(runId);
    }
    return value;
  }

  getRunLog(runId: string, options: { cursor?: number; limit?: number } = {}): HeadlessRunLogPage {
    const page = this.registry.getLogPage(runId, options);
    if (!page) {
      throw this.notFoundRunError(runId);
    }
    return page;
  }

  // Exposed for tests to emulate process lifecycle boundaries.
  clearStateForTests(): void {
    this.queue.splice(0, this.queue.length);
  }

  private notFoundRunError(runId: string): RunServiceError {
    return new RunServiceError(
      'Run not found. It may have expired from memory or been lost after a process restart.',
      'NOT_FOUND',
      404,
      { runId }
    );
  }

  private scheduleDispatchLoop(): void {
    if (this.dispatchLoopScheduled) {
      return;
    }

    this.dispatchLoopScheduled = true;
    queueMicrotask(() => {
      this.dispatchLoopScheduled = false;
      this.dispatchQueue();
    });
  }

  private dispatchQueue(): void {
    while (this.activeWorkers < this.config.maxConcurrentRuns) {
      const runId = this.queue.shift();
      if (!runId) {
        break;
      }

      const snapshot = this.registry.getRunUnsafe(runId);
      if (!snapshot || snapshot.status !== 'queued') {
        continue;
      }

      this.activeWorkers += 1;
      void this.executeRun(runId).finally(() => {
        this.activeWorkers -= 1;
        this.scheduleDispatchLoop();
      });
    }
  }

  private async executeRun(runId: string): Promise<void> {
    const startedAt = this.dependencies.now();
    this.registry.updateRunStatus(runId, 'running', { startedAt });

    const run = this.registry.getRunUnsafe(runId);
    if (!run) {
      return;
    }

    const initialProject = await this.dependencies.store.getProject(run.projectId);
    if (!initialProject) {
      this.registry.updateRunStatus(runId, 'failed', { finishedAt: this.dependencies.now() });
      this.registry.appendEvent(runId, {
        timestamp: this.dependencies.now(),
        iteration: 0,
        code: 'run_failed',
        status: 'failed',
        message: `Production run failed: project ${run.projectId} no longer exists.`
      });
      return;
    }

    let actionExecutionCount = 0;
    let videoPollCount = 0;

    try {
      const result = await this.dependencies.runBatch({
        initialProject,
        derivePlan: this.dependencies.derivePlan,
        config: {
          maxIterations: run.acceptedConfig.limits.maxIterations,
          limits: run.acceptedConfig.limits.perActionConcurrency
        },
        executeAction: async (action) => {
          if (actionExecutionCount >= run.acceptedConfig.limits.maxActionExecutions) {
            throw createProductionRunnerError('Run action limit reached.', {
              code: 'ACTION_LIMIT_REACHED',
              details: `Configured max actions: ${run.acceptedConfig.limits.maxActionExecutions}`
            });
          }

          if (action.type === 'video_poll') {
            if (videoPollCount >= run.acceptedConfig.limits.maxVideoPolls) {
              throw createProductionRunnerError('Run video poll limit reached.', {
                code: 'VIDEO_POLL_LIMIT_REACHED',
                details: `Configured max video polls: ${run.acceptedConfig.limits.maxVideoPolls}`
              });
            }
            videoPollCount += 1;
          }

          actionExecutionCount += 1;
          return this.executeAction(run.projectId, action, run.acceptedConfig.policy.providers, run.acceptedConfig.policy.mode);
        },
        refreshProject: async () => {
          const refreshed = await this.dependencies.store.getProject(run.projectId);
          if (!refreshed) {
            throw new RunServiceError(`Project ${run.projectId} disappeared during run refresh.`, 'NOT_FOUND', 404, {
              projectId: run.projectId
            });
          }
          return refreshed;
        },
        onProgress: (progress) => {
          this.registry.updateProgress(runId, {
            summary: {
              completed: progress.completedActionIds.length,
              failed: progress.failedActionIds.length,
              running: progress.runningActionIds.length,
              waiting: progress.plan.summary.waiting
            },
            completedActionIds: progress.completedActionIds,
            failedActionIds: progress.failedActionIds
          });
        },
        onEvent: (event: ProductionRunnerEvent) => {
          this.registry.appendEvent(runId, event);
        }
      });

      this.registry.updateProgress(runId, {
        summary: {
          completed: result.completedActionIds.length,
          failed: result.failedActionIds.length,
          running: 0,
          waiting: result.unresolvedActions.filter((action) => action.status === 'waiting_dependency').length
        },
        completedActionIds: result.completedActionIds,
        failedActionIds: result.failedActionIds,
        unresolvedActions: result.unresolvedActions
      });
      this.registry.updateRunStatus(runId, result.status, {
        finishedAt: this.dependencies.now()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected production run failure.';
      this.registry.appendEvent(runId, {
        timestamp: this.dependencies.now(),
        iteration: 0,
        code: 'run_failed',
        status: 'failed',
        message: `Production run failed: ${message}`
      });
      this.registry.updateRunStatus(runId, 'failed', {
        finishedAt: this.dependencies.now()
      });
    }
  }

  private async executeAction(
    projectId: string,
    action: ProductionPlannedAction,
    providers: RunProviderSelection,
    mode: RunMode
  ): Promise<ProductionActionExecutionOutcome | void> {
    if (!action.execute) {
      return;
    }

    if (action.type === 'image_generate') {
      if (!action.sceneId) {
        throw createProductionRunnerError('Image generation action is missing sceneId.', {
          code: 'INVALID_ACTION',
          endpoint: `/api/projects/${projectId}/scenes/:sceneId/generate-image`
        });
      }

      const endpoint = `/api/projects/${projectId}/scenes/${action.sceneId}/generate-image`;
      try {
        const regenerate = Boolean(action.payload?.regenerate);
        const result = await this.dependencies.generateImage(projectId, action.sceneId, {
          regenerate,
          provider: providers.image,
          mode
        });

        return {
          message: result.status === 'generated' ? 'Image generation completed.' : `Image generation status: ${result.status}`,
          endpoint,
          sceneId: action.sceneId,
          attemptId: result.generationAttemptId
        };
      } catch (error) {
        if (error instanceof SceneImageGenerationError) {
          throw createProductionRunnerError(error.message, {
            message: error.message,
            code: error.code,
            httpStatus: error.status,
            endpoint,
            sceneId: action.sceneId
          });
        }
        throw error;
      }
    }

    if (action.type === 'video_submit') {
      if (!action.sceneId) {
        throw createProductionRunnerError('Video submit action is missing sceneId.', {
          code: 'INVALID_ACTION',
          endpoint: `/api/projects/${projectId}/scenes/:sceneId/generate-video`
        });
      }

      const endpoint = `/api/projects/${projectId}/scenes/${action.sceneId}/generate-video`;
      try {
        const regenerate = Boolean(action.payload?.regenerate);
        const result = await this.dependencies.submitVideo(projectId, action.sceneId, {
          regenerate,
          provider: providers.video,
          mode
        });

        return {
          message: `Video submit accepted (${result.status}).`,
          endpoint,
          sceneId: action.sceneId,
          attemptId: result.generationAttemptId,
          providerStatus: result.providerStatus
        };
      } catch (error) {
        if (error instanceof SceneVideoGenerationError) {
          throw createProductionRunnerError(error.message, {
            message: error.message,
            code: error.code,
            httpStatus: error.status,
            endpoint,
            sceneId: action.sceneId
          });
        }
        throw error;
      }
    }

    if (action.type === 'video_poll') {
      const attemptId = typeof action.payload?.attemptId === 'string' ? action.payload.attemptId : '';
      if (!attemptId) {
        throw createProductionRunnerError('Video poll action is missing attemptId.', {
          code: 'INVALID_ACTION',
          endpoint: `/api/projects/${projectId}/generation-jobs/:attemptId`
        });
      }

      const endpoint = `/api/projects/${projectId}/generation-jobs/${attemptId}`;
      try {
        const result = await this.dependencies.pollVideo(projectId, attemptId, undefined, { mode });
        return {
          message: `Video poll returned ${result.status}.`,
          endpoint,
          sceneId: action.sceneId,
          attemptId,
          providerStatus: result.providerStatus
        };
      } catch (error) {
        if (error instanceof SceneVideoGenerationError) {
          throw createProductionRunnerError(error.message, {
            message: error.message,
            code: error.code,
            httpStatus: error.status,
            endpoint,
            sceneId: action.sceneId,
            attemptId
          });
        }
        throw error;
      }
    }

    if (action.type === 'narration_generate') {
      if (!action.sceneId) {
        throw createProductionRunnerError('Narration action is missing sceneId.', {
          code: 'INVALID_ACTION',
          endpoint: `/api/projects/${projectId}/scenes/:sceneId/generate-narration`
        });
      }

      const endpoint = `/api/projects/${projectId}/scenes/${action.sceneId}/generate-narration`;
      const narrationMode = String(action.payload?.mode ?? 'generate');
      try {
        const result = await this.dependencies.generateNarration(projectId, action.sceneId, {
          regenerate: narrationMode === 'regenerate' || narrationMode === 'retry',
          provider: providers.narration,
          mode
        });

        return {
          message: 'Narration generation completed.',
          endpoint,
          sceneId: action.sceneId,
          attemptId: result.generationAttemptId
        };
      } catch (error) {
        if (error instanceof SceneNarrationGenerationError) {
          throw createProductionRunnerError(error.message, {
            message: error.message,
            code: error.code,
            httpStatus: error.status,
            endpoint,
            sceneId: action.sceneId
          });
        }
        throw error;
      }
    }

    if (action.type === 'scene_render') {
      if (!action.sceneId) {
        throw createProductionRunnerError('Render action is missing sceneId.', {
          code: 'INVALID_ACTION',
          endpoint: `/api/projects/${projectId}/scenes/:sceneId/render`
        });
      }

      const endpoint = `/api/projects/${projectId}/scenes/${action.sceneId}/render`;
      try {
        const result = await this.dependencies.renderScene(projectId, action.sceneId);
        return {
          message: 'Scene render completed.',
          endpoint,
          sceneId: action.sceneId,
          details: result.render.renderId
        };
      } catch (error) {
        if (error instanceof SceneRenderError) {
          throw createProductionRunnerError(error.message, {
            message: error.message,
            code: error.code,
            httpStatus: statusFromSceneRenderCode(error.code),
            endpoint,
            sceneId: action.sceneId,
            details: error.details
          });
        }
        throw error;
      }
    }

    if (action.type === 'final_compose') {
      const endpoint = `/api/projects/${projectId}/compose`;
      try {
        const result = await this.dependencies.composeProject(projectId);
        return {
          message: 'Final composition completed.',
          endpoint,
          details: result.artifact.compositionId
        };
      } catch (error) {
        if (error instanceof CompositionServiceError) {
          throw createProductionRunnerError(error.message, {
            message: error.message,
            code: error.code,
            httpStatus: statusFromCompositionCode(error.code),
            endpoint,
            details: error.details
          });
        }
        throw error;
      }
    }
  }
}

export const headlessProductionRunService = new HeadlessProductionRunService();
