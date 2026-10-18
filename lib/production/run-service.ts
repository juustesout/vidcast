import { generateSceneImage, SceneImageGenerationError } from '@/lib/generation/image-generation-service';
import { generateProjectMusic, ProjectMusicGenerationError, selectProjectMusic } from '@/lib/generation/music-service';
import { generateSceneNarration, SceneNarrationGenerationError } from '@/lib/generation/narration-service';
import { refreshVideoGenerationAttempt, SceneVideoGenerationError, submitSceneVideoGeneration } from '@/lib/generation/video-generation-service';
import { selectSceneStockImage, StockImageSelectionError } from '@/lib/generation/stock-image-service';
import { getFfmpegConcurrencyLimit } from '@/lib/render/ffmpeg-limiter';
import { isMusicAsset, resolveSelectedMusicAsset, resolveTimelineMusicLengthMs } from '@/lib/render/music-mix';
import { resolveProjectTimelineDurationSeconds } from '@/lib/render/scene-resolver';
import { CompositionServiceError, videoCompositionService } from '@/lib/render/video-composition-service';
import { SceneRenderError } from '@/lib/render/renderer';
import { sceneRenderService } from '@/lib/render/scene-render-service';
import { projectStore, type ProjectStore } from '@/lib/storage/project-store';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import { createId } from '@/lib/utils/ids';
import type { ProductionActionType, ProductionPlannedAction } from './production-planner';
import { deriveProductionPlan } from './production-planner';
import { createProductionRunnerError, runProductionBatch, type ProductionActionExecutionOutcome, type ProductionRunnerEvent } from './production-runner';
import { assertRunPolicyPreflight, resolveRunPolicy, resolveRunPolicyServerConfig, type RunPolicyRequest, type RunPolicyServerConfig } from './run-policy';
import { reconcileInterruptedGenerations } from './run-recovery';
import { InMemoryRunRegistry } from './run-registry';
import { FileRunStore, type PersistedRun, type RunStore } from './run-store';
import type { HeadlessRunAcceptedConfig, HeadlessRunLogPage, HeadlessRunSnapshot, RunPolicySnapshot } from './run-types';

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
  // Bounded retry applied when a mid-run project refresh reads `null` or
  // throws. Keeps transient read failures from aborting an otherwise healthy
  // run while guaranteeing the retry loop always terminates.
  refreshRetry?: {
    attempts: number;
    delayMs: number;
  };
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

const DEFAULT_REFRESH_RETRY = { attempts: 3, delayMs: 100 };

type ProjectReadResult =
  | { ok: true; project: Project }
  | { ok: false; reason: 'not_found' | 'error'; error?: unknown };

interface ServiceDependencies {
  store: Pick<ProjectStore, 'getProject'> & Partial<Pick<ProjectStore, 'updateProject' | 'mutateProject'>>;
  runBatch: typeof runProductionBatch;
  derivePlan: typeof deriveProductionPlan;
  generateImage: typeof generateSceneImage;
  selectStockImage: typeof selectSceneStockImage;
  submitVideo: typeof submitSceneVideoGeneration;
  pollVideo: typeof refreshVideoGenerationAttempt;
  generateNarration: typeof generateSceneNarration;
  renderScene: typeof sceneRenderService.renderScene;
  composeProject: typeof videoCompositionService.composeProject;
  generateMusic: typeof generateProjectMusic;
  selectMusic: typeof selectProjectMusic;
  now: () => string;
  delay: (ms: number) => Promise<void>;
}

const defaultDependencies: ServiceDependencies = {
  store: projectStore,
  runBatch: runProductionBatch,
  derivePlan: deriveProductionPlan,
  generateImage: generateSceneImage,
  selectStockImage: selectSceneStockImage,
  submitVideo: submitSceneVideoGeneration,
  pollVideo: refreshVideoGenerationAttempt,
  generateNarration: generateSceneNarration,
  renderScene: sceneRenderService.renderScene.bind(sceneRenderService),
  composeProject: videoCompositionService.composeProject.bind(videoCompositionService),
  generateMusic: generateProjectMusic,
  selectMusic: selectProjectMusic,
  now: () => new Date().toISOString(),
  delay: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))
};

function envInt(value: string | undefined, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function clampLocalFfmpegConcurrency(value: number): number {
  // Scene renders and final compose share one local FFmpeg semaphore. A run
  // request may lower the action fan-out but can never raise it above the
  // server-managed local ceiling.
  return Math.max(1, Math.min(value, getFfmpegConcurrencyLimit()));
}

function defaultActionLimits(): Record<ProductionActionType, number> {
  return {
    image_generate: envInt(process.env.PRODUCTION_RUN_CONCURRENCY_IMAGE, 2, 1, 16),
    stock_select: envInt(process.env.PRODUCTION_RUN_CONCURRENCY_STOCK, 2, 1, 16),
    video_submit: envInt(process.env.PRODUCTION_RUN_CONCURRENCY_VIDEO_SUBMIT, 2, 1, 16),
    video_poll: envInt(process.env.PRODUCTION_RUN_CONCURRENCY_VIDEO_POLL, 4, 1, 32),
    narration_generate: envInt(process.env.PRODUCTION_RUN_CONCURRENCY_NARRATION, 2, 1, 16),
    scene_render: clampLocalFfmpegConcurrency(envInt(process.env.PRODUCTION_RUN_CONCURRENCY_RENDER, 1, 1, 8)),
    final_compose: clampLocalFfmpegConcurrency(envInt(process.env.PRODUCTION_RUN_CONCURRENCY_COMPOSE, 1, 1, 4))
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
    return {
      ...defaults,
      scene_render: clampLocalFfmpegConcurrency(defaults.scene_render),
      final_compose: clampLocalFfmpegConcurrency(defaults.final_compose)
    };
  }

  return {
    image_generate: envInt(String(override.image_generate ?? defaults.image_generate), defaults.image_generate, 1, 64),
    stock_select: envInt(String(override.stock_select ?? defaults.stock_select), defaults.stock_select, 1, 64),
    video_submit: envInt(String(override.video_submit ?? defaults.video_submit), defaults.video_submit, 1, 64),
    video_poll: envInt(String(override.video_poll ?? defaults.video_poll), defaults.video_poll, 1, 64),
    narration_generate: envInt(String(override.narration_generate ?? defaults.narration_generate), defaults.narration_generate, 1, 64),
    scene_render: clampLocalFfmpegConcurrency(
      envInt(String(override.scene_render ?? defaults.scene_render), defaults.scene_render, 1, 64)
    ),
    final_compose: clampLocalFfmpegConcurrency(
      envInt(String(override.final_compose ?? defaults.final_compose), defaults.final_compose, 1, 64)
    )
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
  if (code === 'FFMPEG_TIMEOUT') {
    return 504;
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
  if (code === 'FFMPEG_TIMEOUT') {
    return 504;
  }
  return 500;
}

// A selected music asset is "usable" when it exists, is a music/audio asset and
// has a local file — the exact condition composition's `resolveProjectMusic`
// uses. Such a track is reused without any provider request.
function resolveUsableMusicAsset(project: Project): Asset | undefined {
  const asset = resolveSelectedMusicAsset(project);
  if (!asset || !isMusicAsset(asset) || !asset.localPath) {
    return undefined;
  }
  return asset;
}

function describeMusicError(error: unknown): string {
  if (error instanceof ProjectMusicGenerationError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : 'unknown error';
}

export interface RunServiceOptions {
  // Optional durable store. When provided, run state is persisted and can be
  // recovered after a process restart.
  runStore?: RunStore;
  // When true and a store is provided, recovery runs once on construction.
  autoRecover?: boolean;
}

export class HeadlessProductionRunService {
  private readonly config: RunServiceConfig;
  private readonly dependencies: ServiceDependencies;
  private readonly registry: InMemoryRunRegistry;
  private readonly runStore?: RunStore;
  private readonly queue: string[] = [];
  private activeWorkers = 0;
  private dispatchLoopScheduled = false;
  private readonly persistDebounceMs = 150;
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly persistQueue = new Map<string, Promise<void>>();
  private readonly recoveredRunIds = new Set<string>();
  private readonly recoveringRunIds = new Set<string>();
  private readonly executingRunIds = new Set<string>();
  // In-flight start requests keyed by projectId. Set synchronously before the
  // first await so concurrent starts for the same project coalesce onto one run.
  private readonly pendingStarts = new Map<string, Promise<StartProductionRunResponse>>();

  constructor(
    config: RunServiceConfig = buildDefaultConfig(),
    dependencies: Partial<ServiceDependencies> = {},
    options: RunServiceOptions = {}
  ) {
    this.config = config;
    this.dependencies = {
      ...defaultDependencies,
      ...dependencies
    };
    this.runStore = options.runStore;
    this.registry = new InMemoryRunRegistry(this.config.registry, {
      onChange: (runId) => this.handleRegistryChange(runId)
    });

    if (options.autoRecover && this.runStore) {
      void this.recoverRuns().catch(() => {});
    }
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

    // Coalesce concurrent starts for the same project onto a single run. The
    // reservation is inserted synchronously (no await before it), so a second
    // caller that arrives while the first is still validating sees it and
    // reuses the resulting run instead of starting a duplicate.
    const pending = this.pendingStarts.get(projectId);
    if (pending) {
      const result = await pending;
      return {
        run: result.run,
        reused: true
      };
    }

    const startPromise = this.performStart(projectId, input);
    this.pendingStarts.set(projectId, startPromise);
    try {
      return await startPromise;
    } finally {
      if (this.pendingStarts.get(projectId) === startPromise) {
        this.pendingStarts.delete(projectId);
      }
    }
  }

  private async performStart(projectId: string, input: StartProductionRunRequest): Promise<StartProductionRunResponse> {
    const persistedActive = this.runStore ? await this.findPersistedActiveRun(projectId) : null;
    if (persistedActive) {
      this.registry.refreshRun(persistedActive);
      const snapshot = this.registry.getRunUnsafe(persistedActive.runId);
      if (snapshot) {
        await this.ensureRunActive(persistedActive);
        return {
          run: this.registry.getRunUnsafe(persistedActive.runId) ?? snapshot,
          reused: true
        };
      }
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

    // Make the run discoverable by other route instances before the start
    // response returns. Without this, a status request in another instance can
    // race the debounced first save and report NOT_FOUND for an active run.
    await this.flushRun(runId);

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

  // Read path for HTTP status routes. The local registry is only a cache: if
  // this route instance never saw the run, or its snapshot is older than the
  // durable copy, load/refresh from the run store. A non-terminal run with no
  // live owner is resumed here, using the existing execution lock for dedupe.
  async getRunForRead(runId: string): Promise<HeadlessRunSnapshot> {
    const persisted = await this.loadPersistedRun(runId);

    if (!persisted) {
      const local = this.registry.getRun(runId);
      if (local) {
        return local;
      }
      throw this.notFoundRunError(runId);
    }

    if (this.isPersistedRunExpired(persisted)) {
      throw this.notFoundRunError(runId);
    }

    this.registry.refreshRun(persisted);
    const snapshot = this.registry.getRunUnsafe(runId);
    if (!snapshot) {
      throw this.notFoundRunError(runId);
    }

    if (snapshot.status === 'queued' || snapshot.status === 'running') {
      await this.ensureRunActive(persisted);
      return this.registry.getRunUnsafe(runId) ?? snapshot;
    }

    return snapshot;
  }

  async getRunLogForRead(runId: string, options: { cursor?: number; limit?: number } = {}): Promise<HeadlessRunLogPage> {
    await this.getRunForRead(runId);
    return this.getRunLog(runId, options);
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
    this.recoveredRunIds.clear();
    this.recoveringRunIds.clear();
    this.executingRunIds.clear();
  }

  private async findPersistedActiveRun(projectId: string): Promise<PersistedRun | null> {
    if (!this.runStore) {
      return null;
    }
    let entries: PersistedRun[];
    try {
      entries = await this.runStore.listAll();
    } catch {
      return null;
    }
    return entries
      .filter((entry) => entry.projectId === projectId && (entry.status === 'queued' || entry.status === 'running'))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  private async loadPersistedRun(runId: string): Promise<PersistedRun | null> {
    if (!this.runStore?.findByRunId) {
      return null;
    }
    try {
      return await this.runStore.findByRunId(runId);
    } catch {
      return null;
    }
  }

  private isPersistedRunExpired(entry: PersistedRun): boolean {
    if (entry.status === 'queued' || entry.status === 'running') {
      return false;
    }
    if (!entry.finishedAt) {
      return false;
    }
    const finishedAt = Date.parse(entry.finishedAt);
    if (!Number.isFinite(finishedAt)) {
      return false;
    }
    return Date.now() - finishedAt > this.config.registry.retentionMs;
  }

  private async ensureRunActive(entry: PersistedRun): Promise<void> {
    const runId = entry.runId;
    if (entry.status !== 'queued' && entry.status !== 'running') {
      return;
    }
    if (
      this.recoveredRunIds.has(runId)
      || this.recoveringRunIds.has(runId)
      || this.executingRunIds.has(runId)
      || this.queue.includes(runId)
    ) {
      return;
    }

    if (this.runStore?.isExecutionLocked && (await this.runStore.isExecutionLocked(entry.projectId, runId))) {
      return;
    }

    this.recoveringRunIds.add(runId);
    try {
      const snapshot = await this.recoverRun(entry);
      if (snapshot) {
        this.recoveredRunIds.add(runId);
      }
    } catch {
      // A status/log read must remain readable even if recovery cannot start.
    } finally {
      this.recoveringRunIds.delete(runId);
    }
  }

  // Rehydrates persisted runs and resumes any that were non-terminal when the
  // process stopped. Idempotent: repeated calls do not re-import or re-enqueue.
  async recoverRuns(): Promise<HeadlessRunSnapshot[]> {
    if (!this.runStore) {
      return [];
    }

    let entries: PersistedRun[];
    try {
      entries = await this.runStore.listAll();
    } catch {
      return [];
    }

    for (const entry of entries) {
      this.registry.refreshRun(entry);
    }

    const recovered: HeadlessRunSnapshot[] = [];
    const handledProjects = new Set<string>();

    for (const entry of entries) {
      if (entry.status !== 'queued' && entry.status !== 'running') {
        continue;
      }
      if (this.recoveredRunIds.has(entry.runId)) {
        continue;
      }
      this.recoveredRunIds.add(entry.runId);

      if (handledProjects.has(entry.projectId)) {
        this.registry.appendEvent(entry.runId, {
          timestamp: this.dependencies.now(),
          iteration: 0,
          code: 'run_superseded',
          status: 'stopped',
          message: 'Superseded by an earlier recovered run for the same project.'
        });
        this.registry.updateRunStatus(entry.runId, 'failed', { finishedAt: this.dependencies.now() });
        await this.flushRun(entry.runId);
        continue;
      }

      handledProjects.add(entry.projectId);
      const snapshot = await this.recoverRun(entry);
      if (snapshot) {
        recovered.push(snapshot);
      }
    }

    return recovered;
  }

  // Persists any pending run writes. Useful for tests and orderly shutdown.
  async flushPersists(): Promise<void> {
    const runIds = new Set<string>([...this.persistTimers.keys(), ...this.persistQueue.keys()]);
    await Promise.all(Array.from(runIds, (runId) => this.flushRun(runId)));
  }

  private handleRegistryChange(runId: string): void {
    if (!this.runStore) {
      return;
    }

    const snapshot = this.registry.getRunUnsafe(runId);
    if (!snapshot) {
      return;
    }

    if (snapshot.status !== 'queued' && snapshot.status !== 'running') {
      void this.flushRun(runId);
      return;
    }

    this.schedulePersist(runId);
  }

  private schedulePersist(runId: string): void {
    if (!this.runStore || this.persistTimers.has(runId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.persistTimers.delete(runId);
      void this.flushRun(runId);
    }, this.persistDebounceMs);
    (timer as { unref?: () => void }).unref?.();
    this.persistTimers.set(runId, timer);
  }

  private flushRun(runId: string): Promise<void> {
    if (!this.runStore) {
      return Promise.resolve();
    }

    const timer = this.persistTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(runId);
    }

    const previous = this.persistQueue.get(runId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const entry = this.registry.exportRun(runId);
        if (!entry || !this.runStore) {
          return;
        }
        try {
          await this.runStore.save(entry);
        } catch {
          // Persistence failures are non-fatal; the in-memory run continues.
        }
      });
    const guarded = next.catch(() => {});
    this.persistQueue.set(runId, guarded);
    void guarded.finally(() => {
      if (this.persistQueue.get(runId) === guarded) {
        this.persistQueue.delete(runId);
      }
    });
    return guarded;
  }

  private async recoverRun(entry: PersistedRun): Promise<HeadlessRunSnapshot | null> {
    const runId = entry.runId;
    const at = this.dependencies.now();

    // A live owner in another process/worker is executing this run. Leave its
    // project and state untouched; the imported snapshot still makes the run
    // readable through this instance.
    if (this.runStore?.isExecutionLocked && (await this.runStore.isExecutionLocked(entry.projectId, runId))) {
      return this.registry.getRunUnsafe(runId);
    }

    const project = await this.dependencies.store.getProject(entry.projectId);
    if (!project) {
      this.registry.appendEvent(runId, {
        timestamp: at,
        iteration: 0,
        code: 'run_failed',
        status: 'failed',
        message: `Production run failed on recovery: project ${entry.projectId} no longer exists.`
      });
      this.registry.updateRunStatus(runId, 'failed', { finishedAt: at });
      await this.flushRun(runId);
      return this.registry.getRunUnsafe(runId);
    }

    const reconciliation = reconcileInterruptedGenerations(project, entry.acceptedConfig.policy.mode);

    if (reconciliation.updatedProject) {
      try {
        if (this.dependencies.store.mutateProject) {
          await this.dependencies.store.mutateProject(entry.projectId, (current) => {
            const fresh = reconcileInterruptedGenerations(current, entry.acceptedConfig.policy.mode);
            return fresh.updatedProject ?? current;
          });
        } else if (this.dependencies.store.updateProject) {
          await this.dependencies.store.updateProject(reconciliation.updatedProject);
        }
      } catch (error) {
        this.registry.appendEvent(runId, {
          timestamp: at,
          iteration: 0,
          code: 'run_recovered',
          status: 'info',
          message: `Failed to reconcile interrupted scene state: ${error instanceof Error ? error.message : 'unknown error'}.`
        });
      }
    }

    for (const note of reconciliation.notes) {
      this.registry.appendEvent(runId, {
        timestamp: at,
        iteration: 0,
        code: 'run_recovered',
        status: 'info',
        actionType: note.actionType,
        sceneId: note.sceneId,
        message: note.message
      });
    }

    if (reconciliation.suppressedActionIds.length > 0) {
      const current = this.registry.getRunUnsafe(runId);
      const failed = new Set(current?.failedActionIds ?? []);
      for (const actionId of reconciliation.suppressedActionIds) {
        failed.add(actionId);
      }
      this.registry.updateProgress(runId, { failedActionIds: Array.from(failed) });
    }

    this.registry.appendEvent(runId, {
      timestamp: at,
      iteration: 0,
      code: 'run_recovered',
      status: 'info',
      message: 'Recovered run after process restart; resuming from persisted state.'
    });
    this.registry.updateRunStatus(runId, 'queued');
    this.queue.push(runId);
    this.scheduleDispatchLoop();
    await this.flushRun(runId);
    return this.registry.getRunUnsafe(runId);
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
      void this.executeRun(runId)
        .catch(() => {})
        .finally(() => {
          this.activeWorkers -= 1;
          this.scheduleDispatchLoop();
        });
    }
  }

  private resolveRefreshRetry(): { attempts: number; delayMs: number } {
    const configured = this.config.refreshRetry;
    return {
      attempts: Math.max(1, Math.floor(configured?.attempts ?? DEFAULT_REFRESH_RETRY.attempts)),
      delayMs: Math.max(0, Math.floor(configured?.delayMs ?? DEFAULT_REFRESH_RETRY.delayMs))
    };
  }

  // Reads a project with a bounded number of attempts so a transient read
  // failure (null or thrown) does not immediately abort a run. The loop is
  // finite: it performs at most `attempts` reads and never polls indefinitely.
  private async readProjectWithRetry(projectId: string): Promise<ProjectReadResult> {
    const { attempts, delayMs } = this.resolveRefreshRetry();
    let reason: 'not_found' | 'error' = 'not_found';
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const project = await this.dependencies.store.getProject(projectId);
        if (project) {
          return { ok: true, project };
        }
        reason = 'not_found';
      } catch (error) {
        reason = 'error';
        lastError = error;
      }

      if (attempt < attempts - 1) {
        await this.dependencies.delay(delayMs);
      }
    }

    return { ok: false, reason, error: lastError };
  }

  private async executeRun(runId: string): Promise<void> {
    const snapshot = this.registry.getRunUnsafe(runId);
    const projectId = snapshot?.projectId;
    const lock = projectId && this.runStore?.tryAcquireExecutionLock
      ? await this.runStore.tryAcquireExecutionLock(projectId, runId)
      : undefined;

    // Another process/worker owns this run's execution. Bail out without
    // touching the project so the owner's in-flight work is never duplicated.
    if (projectId && this.runStore?.tryAcquireExecutionLock && !lock) {
      return;
    }

    try {
      // The lock may have been acquired after another worker already completed
      // this run (for example two route instances both recovered the same
      // queued run). Refresh from durable state and never execute terminal work
      // a second time.
      const persisted = await this.loadPersistedRun(runId);
      if (persisted) {
        this.registry.refreshRun(persisted);
        const current = this.registry.getRunUnsafe(runId);
        if (current && current.status !== 'queued' && current.status !== 'running') {
          return;
        }
      }

      this.executingRunIds.add(runId);
      await this.executeRunInternal(runId);
    } finally {
      this.executingRunIds.delete(runId);
      await lock?.release();
    }
  }

  private async executeRunInternal(runId: string): Promise<void> {
    const startedAt = this.dependencies.now();
    this.registry.updateRunStatus(runId, 'running', { startedAt });

    const run = this.registry.getRunUnsafe(runId);
    if (!run) {
      return;
    }

    let actionExecutionCount = 0;
    let videoPollCount = 0;

    try {
      const initial = await this.readProjectWithRetry(run.projectId);
      if (!initial.ok) {
        const at = this.dependencies.now();
        this.registry.updateRunStatus(runId, 'failed', { finishedAt: at });
        this.registry.appendEvent(runId, {
          timestamp: at,
          iteration: 0,
          code: 'run_failed',
          status: 'failed',
          message: initial.reason === 'error'
            ? `Production run failed: project ${run.projectId} could not be read.`
            : `Production run failed: project ${run.projectId} no longer exists.`
        });
        return;
      }

      const result = await this.dependencies.runBatch({
        initialProject: initial.project,
        derivePlan: (project, options) =>
          this.dependencies.derivePlan(project, {
            ...options,
            force: run.acceptedConfig.policy.force === true,
            mode: run.acceptedConfig.policy.mode
          }),
        config: {
          maxIterations: run.acceptedConfig.limits.maxIterations,
          limits: run.acceptedConfig.limits.perActionConcurrency
        },
        initialFailedActionIds: run.failedActionIds,
        // Completed actions are restored so a forced recovered run does not
        // re-execute generation that already produced its artifacts. The planner
        // still re-derives any action whose artifact is missing or stale.
        initialCompletedActionIds: run.completedActionIds,
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
          return this.executeAction(run.projectId, action, run.acceptedConfig.policy);
        },
        refreshProject: async () => {
          const refreshed = await this.readProjectWithRetry(run.projectId);
          if (!refreshed.ok) {
            throw new RunServiceError(
              refreshed.reason === 'error'
                ? `Project ${run.projectId} could not be read during run refresh.`
                : `Project ${run.projectId} disappeared during run refresh.`,
              refreshed.reason === 'error' ? 'PRECONDITION_FAILED' : 'NOT_FOUND',
              refreshed.reason === 'error' ? 409 : 404,
              { projectId: run.projectId, reason: refreshed.reason }
            );
          }
          return refreshed.project;
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

  // Opt-in, fail-soft background-music step, run immediately before
  // composition. It never throws: any failure is returned as a diagnostic note
  // so the run and its composition still complete. Returns undefined when there
  // is nothing to report (opt-in absent, or an existing usable track was reused
  // without any provider request).
  private async prepareRunMusic(projectId: string, policy: RunPolicySnapshot): Promise<string | undefined> {
    const plan = policy.music;
    if (!plan) {
      return undefined;
    }

    try {
      const project = await this.dependencies.store.getProject(projectId);
      if (!project) {
        return 'Background music skipped: project could not be read.';
      }

      // Reuse an existing usable track; never issue a new generation request.
      if (resolveUsableMusicAsset(project)) {
        return undefined;
      }

      // A generation is already in flight; do not start another.
      if (project.music?.status === 'generating') {
        return 'Background music skipped: generation already in progress.';
      }

      if (plan.selectAssetId) {
        await this.dependencies.selectMusic(projectId, plan.selectAssetId);
        return 'Background music selected from an existing asset.';
      }

      // The final timeline (P32.1) is the only source for the requested track
      // length. An explicit run-plan length still wins; otherwise a track is
      // requested for the full timeline, clamped to provider bounds and looped
      // by the compositor when the timeline is longer than the maximum.
      const musicLengthMs =
        plan.musicLengthMs ?? resolveTimelineMusicLengthMs(resolveProjectTimelineDurationSeconds(project));

      await this.dependencies.generateMusic(projectId, {
        prompt: plan.prompt,
        musicLengthMs,
        instrumental: plan.instrumental,
        model: plan.model,
        seed: plan.seed,
        outputFormat: plan.outputFormat,
        regenerate: plan.regenerate === true,
        provider: policy.providers.music,
        mode: policy.mode
      });
      return 'Background music generated.';
    } catch (error) {
      // Fail-soft: an optional music failure must never block the video.
      return `Background music skipped: ${describeMusicError(error)}.`;
    }
  }

  private async executeAction(
    projectId: string,
    action: ProductionPlannedAction,
    policy: RunPolicySnapshot
  ): Promise<ProductionActionExecutionOutcome | void> {
    const { providers, mode } = policy;

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

    if (action.type === 'stock_select') {
      if (!action.sceneId) {
        throw createProductionRunnerError('Stock selection action is missing sceneId.', {
          code: 'INVALID_ACTION',
          endpoint: `/api/projects/${projectId}/scenes/:sceneId/select-stock-image`
        });
      }

      const endpoint = `/api/projects/${projectId}/scenes/${action.sceneId}/select-stock-image`;
      try {
        const regenerate = Boolean(action.payload?.regenerate);
        const result = await this.dependencies.selectStockImage(projectId, action.sceneId, {
          regenerate,
          mode
        });

        return {
          message: result.status === 'selected' ? 'Stock image selected.' : 'Stock image selection is current.',
          endpoint,
          sceneId: action.sceneId,
          details: `${result.provider}:${result.photoId}`
        };
      } catch (error) {
        if (error instanceof StockImageSelectionError) {
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
      const musicNote = await this.prepareRunMusic(projectId, policy);
      try {
        const result = await this.dependencies.composeProject(projectId);
        return {
          message: musicNote ? `Final composition completed. ${musicNote}` : 'Final composition completed.',
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

function autoRecoverEnabled(): boolean {
  if (process.env.NODE_ENV === 'test') {
    return false;
  }
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return false;
  }
  return true;
}

export const headlessProductionRunService = new HeadlessProductionRunService(
  buildDefaultConfig(),
  {},
  {
    runStore: new FileRunStore(),
    autoRecover: autoRecoverEnabled()
  }
);
