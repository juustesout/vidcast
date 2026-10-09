import type { ProductionPlannedAction } from './production-planner';
import type { ProductionRunnerEvent } from './production-runner';
import type { HeadlessRunAcceptedConfig, HeadlessRunLogPage, HeadlessRunSnapshot, HeadlessRunStatus, HeadlessRunSummary } from './run-types';

interface RegistryConfig {
  maxEventsPerRun: number;
  retentionMs: number;
  maxLogPageLimit: number;
}

interface StoredRun extends HeadlessRunSnapshot {
  events: ProductionRunnerEvent[];
  eventOffset: number;
}

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

  constructor(config: RegistryConfig) {
    this.config = {
      maxEventsPerRun: Math.max(100, config.maxEventsPerRun),
      retentionMs: Math.max(60_000, config.retentionMs),
      maxLogPageLimit: Math.max(10, config.maxLogPageLimit)
    };
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
