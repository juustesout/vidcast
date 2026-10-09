import type { ProductionPlannedAction } from './production-planner';
import type { ProductionRunnerEvent } from './production-runner';
import type { HeadlessRunAcceptedConfig, HeadlessRunLogPage, HeadlessRunSnapshot, HeadlessRunStatus, HeadlessRunSummary } from './run-types';

interface RegistryConfig {
  maxEventsPerRun: number;
  retentionMs: number;
  maxLogPageLimit: number;
}

export interface RunRegistryEntry extends HeadlessRunSnapshot {
  events: ProductionRunnerEvent[];
  eventOffset: number;
}

export interface RunRegistryOptions {
  // Invoked after any mutation of a run so callers can persist it. Never
  // invoked for imported runs (rehydration) to avoid write-on-load.
  onChange?: (runId: string) => void;
}

type StoredRun = RunRegistryEntry;

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeText(value: string): string {
  const flattened = value.replace(/[\r\n\t]+/g, ' ').trim();
  return flattened
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[redacted]');
}

function sanitizeEvent(event: ProductionRunnerEvent): ProductionRunnerEvent {
  return {
    ...event,
    message: sanitizeText(event.message),
    error: event.error
      ? {
          message: sanitizeText(event.error.message),
          code: event.error.code ? sanitizeText(event.error.code) : undefined,
          endpoint: event.error.endpoint ? sanitizeText(event.error.endpoint) : undefined,
          providerStatus: event.error.providerStatus ? sanitizeText(event.error.providerStatus) : undefined,
          providerError: event.error.providerError ? sanitizeText(event.error.providerError) : undefined,
          httpStatus: event.error.httpStatus,
          sceneId: event.error.sceneId ? sanitizeText(event.error.sceneId) : undefined,
          actionType: event.error.actionType,
          attemptId: event.error.attemptId ? sanitizeText(event.error.attemptId) : undefined,
          details: event.error.details ? sanitizeText(event.error.details) : undefined
        }
      : undefined
  };
}

function defaultSummary(): HeadlessRunSummary {
  return {
    completed: 0,
    failed: 0,
    running: 0,
    waiting: 0
  };
}

export class InMemoryRunRegistry {
  private readonly runs = new Map<string, StoredRun>();
  private readonly activeByProject = new Map<string, string>();
  private readonly config: RegistryConfig;
  private readonly onChange?: (runId: string) => void;

  constructor(config: RegistryConfig, options: RunRegistryOptions = {}) {
    this.config = {
      maxEventsPerRun: Math.max(100, config.maxEventsPerRun),
      retentionMs: Math.max(60_000, config.retentionMs),
      maxLogPageLimit: Math.max(10, config.maxLogPageLimit)
    };
    this.onChange = options.onChange;
  }

  private notify(runId: string): void {
    this.onChange?.(runId);
  }

  sweepExpired(referenceTime = Date.now()): void {
    for (const [runId, run] of this.runs.entries()) {
      if (run.status === 'queued' || run.status === 'running') {
        continue;
      }
      const finishedAt = run.finishedAt ? new Date(run.finishedAt).getTime() : NaN;
      if (!Number.isFinite(finishedAt)) {
        continue;
      }
      if (referenceTime - finishedAt > this.config.retentionMs) {
        this.runs.delete(runId);
      }
    }
  }

  createRun(input: { runId: string; projectId: string; acceptedConfig: HeadlessRunAcceptedConfig }): HeadlessRunSnapshot {
    this.sweepExpired();

    const createdAt = nowIso();
    const stored: StoredRun = {
      runId: input.runId,
      projectId: input.projectId,
      status: 'queued',
      createdAt,
      summary: defaultSummary(),
      completedActionIds: [],
      failedActionIds: [],
      unresolvedActions: [],
      acceptedConfig: input.acceptedConfig,
      events: [],
      eventOffset: 0
    };

    this.runs.set(input.runId, stored);
    this.activeByProject.set(input.projectId, input.runId);

    this.notify(input.runId);
    return this.snapshot(stored);
  }

  getRun(runId: string): HeadlessRunSnapshot | null {
    this.sweepExpired();
    const stored = this.runs.get(runId);
    return stored ? this.snapshot(stored) : null;
  }

  getRunUnsafe(runId: string): HeadlessRunSnapshot | null {
    const stored = this.runs.get(runId);
    return stored ? this.snapshot(stored) : null;
  }

  // Full durable representation, used for persistence.
  exportRun(runId: string): RunRegistryEntry | null {
    const run = this.runs.get(runId);
    if (!run) {
      return null;
    }
    return {
      ...this.snapshot(run),
      events: run.events.map((event) => ({ ...event, error: event.error ? { ...event.error } : undefined })),
      eventOffset: run.eventOffset
    };
  }

  // Rehydrates a run from persisted data without emitting change notifications.
  // If the run already exists this is a no-op. A non-terminal run becomes the
  // project's active run only when it does not already have one.
  importRun(entry: RunRegistryEntry): HeadlessRunSnapshot {
    const existing = this.runs.get(entry.runId);
    if (existing) {
      return this.snapshot(existing);
    }

    const stored: StoredRun = {
      runId: entry.runId,
      projectId: entry.projectId,
      status: entry.status,
      createdAt: entry.createdAt,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      summary: { ...defaultSummary(), ...entry.summary },
      completedActionIds: [...entry.completedActionIds],
      failedActionIds: [...entry.failedActionIds],
      unresolvedActions: [...entry.unresolvedActions],
      acceptedConfig: {
        policy: {
          mode: entry.acceptedConfig.policy.mode,
          allowRealProviders: entry.acceptedConfig.policy.allowRealProviders,
          providers: { ...entry.acceptedConfig.policy.providers }
        },
        limits: {
          maxIterations: entry.acceptedConfig.limits.maxIterations,
          maxActionExecutions: entry.acceptedConfig.limits.maxActionExecutions,
          maxVideoPolls: entry.acceptedConfig.limits.maxVideoPolls,
          perActionConcurrency: { ...entry.acceptedConfig.limits.perActionConcurrency }
        }
      },
      events: entry.events.map((event) => ({ ...event, error: event.error ? { ...event.error } : undefined })),
      eventOffset: entry.eventOffset
    };

    this.runs.set(stored.runId, stored);

    if (stored.status === 'queued' || stored.status === 'running') {
      const currentActiveId = this.activeByProject.get(stored.projectId);
      const currentActive = currentActiveId ? this.runs.get(currentActiveId) : undefined;
      const hasActive = Boolean(currentActive && (currentActive.status === 'queued' || currentActive.status === 'running'));
      if (!hasActive) {
        this.activeByProject.set(stored.projectId, stored.runId);
      }
    }

    return this.snapshot(stored);
  }

  getActiveRunByProject(projectId: string): HeadlessRunSnapshot | null {
    this.sweepExpired();
    const runId = this.activeByProject.get(projectId);
    if (!runId) {
      return null;
    }
    const run = this.runs.get(runId);
    if (!run) {
      this.activeByProject.delete(projectId);
      return null;
    }
    if (run.status !== 'queued' && run.status !== 'running') {
      this.activeByProject.delete(projectId);
      return null;
    }
    return this.snapshot(run);
  }

  updateRunStatus(runId: string, status: HeadlessRunStatus, patch: Partial<Pick<HeadlessRunSnapshot, 'startedAt' | 'finishedAt'>> = {}): HeadlessRunSnapshot | null {
    const run = this.runs.get(runId);
    if (!run) {
      return null;
    }

    run.status = status;
    if (patch.startedAt) {
      run.startedAt = patch.startedAt;
    }
    if (patch.finishedAt) {
      run.finishedAt = patch.finishedAt;
    }

    if (status !== 'queued' && status !== 'running') {
      this.activeByProject.delete(run.projectId);
    }

    this.notify(runId);
    return this.snapshot(run);
  }

  updateProgress(
    runId: string,
    patch: {
      summary?: Partial<HeadlessRunSummary>;
      completedActionIds?: string[];
      failedActionIds?: string[];
      unresolvedActions?: ProductionPlannedAction[];
    }
  ): HeadlessRunSnapshot | null {
    const run = this.runs.get(runId);
    if (!run) {
      return null;
    }

    if (patch.summary) {
      run.summary = {
        ...run.summary,
        ...patch.summary
      };
    }

    if (patch.completedActionIds) {
      run.completedActionIds = [...patch.completedActionIds];
    }

    if (patch.failedActionIds) {
      run.failedActionIds = [...patch.failedActionIds];
    }

    if (patch.unresolvedActions) {
      run.unresolvedActions = [...patch.unresolvedActions];
    }

    this.notify(runId);
    return this.snapshot(run);
  }

  appendEvent(runId: string, event: ProductionRunnerEvent): boolean {
    const run = this.runs.get(runId);
    if (!run) {
      return false;
    }

    run.events.push(sanitizeEvent(event));

    if (run.events.length > this.config.maxEventsPerRun) {
      const overflow = run.events.length - this.config.maxEventsPerRun;
      run.events.splice(0, overflow);
      run.eventOffset += overflow;
    }

    this.notify(runId);
    return true;
  }

  getLogPage(runId: string, options: { cursor?: number; limit?: number } = {}): HeadlessRunLogPage | null {
    this.sweepExpired();
    const run = this.runs.get(runId);
    if (!run) {
      return null;
    }

    const requestedCursor = Number.isFinite(options.cursor) ? Number(options.cursor) : run.eventOffset;
    const cursor = Math.max(run.eventOffset, Math.floor(requestedCursor));

    const requestedLimit = Number.isFinite(options.limit) ? Number(options.limit) : 100;
    const limit = Math.min(this.config.maxLogPageLimit, Math.max(1, Math.floor(requestedLimit)));

    const start = cursor - run.eventOffset;
    const items = run.events.slice(Math.max(0, start), Math.max(0, start) + limit).map((event, index) => ({
      cursor: cursor + index,
      event
    }));

    const nextCursor = items.length > 0 ? items[items.length - 1].cursor + 1 : cursor;
    const hasMore = nextCursor < run.eventOffset + run.events.length;

    return {
      runId,
      cursor,
      nextCursor,
      hasMore,
      items
    };
  }

  private snapshot(run: StoredRun): HeadlessRunSnapshot {
    return {
      runId: run.runId,
      projectId: run.projectId,
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      summary: { ...run.summary },
      completedActionIds: [...run.completedActionIds],
      failedActionIds: [...run.failedActionIds],
      unresolvedActions: [...run.unresolvedActions],
      acceptedConfig: {
        policy: {
          mode: run.acceptedConfig.policy.mode,
          allowRealProviders: run.acceptedConfig.policy.allowRealProviders,
          providers: { ...run.acceptedConfig.policy.providers }
        },
        limits: {
          maxIterations: run.acceptedConfig.limits.maxIterations,
          maxActionExecutions: run.acceptedConfig.limits.maxActionExecutions,
          maxVideoPolls: run.acceptedConfig.limits.maxVideoPolls,
          perActionConcurrency: { ...run.acceptedConfig.limits.perActionConcurrency }
        }
      }
    };
  }
}
