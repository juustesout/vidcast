import type { HeadlessRunLogItem, HeadlessRunSnapshot, HeadlessRunStatus } from '@/lib/production/run-types';
import { getProductionRun, getProductionRunLog, startProductionRun, type ProductionRunApiError, type ProductionRunApiResult, type StartProductionRunRequest, type StartProductionRunResponse } from './production-run-client';

export interface ProductionRunTrackerState {
  runId: string | null;
  run: HeadlessRunSnapshot | null;
  logItems: HeadlessRunLogItem[];
  nextCursor: number;
  hasMore: boolean;
  restartLost: boolean;
  transientError: string | null;
  lastError: ProductionRunApiError | null;
}

export interface StartServerRunFlowInput {
  projectId: string;
  payload?: StartProductionRunRequest;
  ensureSaved: () => Promise<boolean>;
  startRun?: (projectId: string, payload: StartProductionRunRequest) => Promise<ProductionRunApiResult<StartProductionRunResponse>>;
}

export type StartServerRunFlowResult =
  | {
      ok: true;
      result: ProductionRunApiResult<StartProductionRunResponse> & { ok: true };
    }
  | {
      ok: false;
      blockedBySave: boolean;
      error?: ProductionRunApiError;
    };

export interface ProductionRunTrackerApi {
  getProductionRun: typeof getProductionRun;
  getProductionRunLog: typeof getProductionRunLog;
}

export interface ProductionRunTrackerStepResult {
  kind: 'idle' | 'updated' | 'terminal' | 'restart_lost' | 'transient_error' | 'skipped' | 'stale';
  shouldContinue: boolean;
  nextDelayMs: number;
  state: ProductionRunTrackerState;
}

const DEFAULT_POLL_DELAY_MS = 2_500;
const MAX_POLL_DELAY_MS = 15_000;
const DEFAULT_LOG_PAGE_LIMIT = 100;
const MAX_CATCHUP_PAGES = 20;
const TERMINAL_STATUSES = new Set<HeadlessRunStatus>(['completed', 'partial', 'failed', 'unresolved']);

export function createInitialProductionRunTrackerState(): ProductionRunTrackerState {
  return {
    runId: null,
    run: null,
    logItems: [],
    nextCursor: 0,
    hasMore: false,
    restartLost: false,
    transientError: null,
    lastError: null
  };
}

export function isTerminalHeadlessRunStatus(status: HeadlessRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function getProductionRunPollDelayMs(failureCount: number): number {
  if (failureCount <= 0) {
    return DEFAULT_POLL_DELAY_MS;
  }

  return Math.min(MAX_POLL_DELAY_MS, DEFAULT_POLL_DELAY_MS * (2 ** Math.min(failureCount, 3)));
}

export function mergeHeadlessRunLogItems(existing: HeadlessRunLogItem[], incoming: HeadlessRunLogItem[]): HeadlessRunLogItem[] {
  const deduped = new Map<number, HeadlessRunLogItem>();

  for (const item of existing) {
    deduped.set(item.cursor, item);
  }

  for (const item of incoming) {
    deduped.set(item.cursor, item);
  }

  return [...deduped.values()].sort((left, right) => left.cursor - right.cursor);
}

export async function startServerRunFlow({ projectId, payload = {}, ensureSaved, startRun = startProductionRun }: StartServerRunFlowInput): Promise<StartServerRunFlowResult> {
  const saved = await ensureSaved();
  if (!saved) {
    return {
      ok: false,
      blockedBySave: true
    };
  }

  const result = await startRun(projectId, payload);
  if (!result.ok) {
    return {
      ok: false,
      blockedBySave: false,
      error: result.error
    };
  }

  return {
    ok: true,
    result
  };
}

export class ProductionRunTracker {
  private readonly api: ProductionRunTrackerApi;
  private state = createInitialProductionRunTrackerState();
  private sessionToken = 0;
  private inFlight = false;
  private failureCount = 0;

  constructor(api?: Partial<ProductionRunTrackerApi>) {
    this.api = {
      getProductionRun,
      getProductionRunLog,
      ...api
    };
  }

  getState(): ProductionRunTrackerState {
    return {
      ...this.state,
      logItems: [...this.state.logItems],
      run: this.state.run
        ? {
            ...this.state.run,
            summary: { ...this.state.run.summary },
            completedActionIds: [...this.state.run.completedActionIds],
            failedActionIds: [...this.state.run.failedActionIds],
            unresolvedActions: [...this.state.run.unresolvedActions],
            acceptedConfig: {
              policy: {
                ...this.state.run.acceptedConfig.policy,
                providers: { ...this.state.run.acceptedConfig.policy.providers }
              },
              limits: {
                ...this.state.run.acceptedConfig.limits,
                perActionConcurrency: { ...this.state.run.acceptedConfig.limits.perActionConcurrency }
              }
            }
          }
        : null,
      lastError: this.state.lastError ? { ...this.state.lastError } : null
    };
  }

  trackRun(run: HeadlessRunSnapshot): ProductionRunTrackerState {
    this.sessionToken += 1;
    this.inFlight = false;
    this.failureCount = 0;
    this.state = {
      runId: run.runId,
      run,
      logItems: [],
      nextCursor: 0,
      hasMore: false,
      restartLost: false,
      transientError: null,
      lastError: null
    };
    return this.getState();
  }

  invalidate(): ProductionRunTrackerState {
    this.sessionToken += 1;
    this.inFlight = false;
    this.failureCount = 0;
    return this.getState();
  }

  reset(): ProductionRunTrackerState {
    this.sessionToken += 1;
    this.inFlight = false;
    this.failureCount = 0;
    this.state = createInitialProductionRunTrackerState();
    return this.getState();
  }

  async loadAvailableLogPages(limit = DEFAULT_LOG_PAGE_LIMIT, maxPages = MAX_CATCHUP_PAGES): Promise<ProductionRunTrackerStepResult> {
    const runId = this.state.runId;
    if (!runId) {
      return this.buildResult('idle');
    }

    const requestToken = this.beginRequest();
    if (requestToken === null) {
      return this.buildResult('skipped');
    }

    try {
      let cursor = 0;
      let hasMore = false;
      let merged: HeadlessRunLogItem[] = [];

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const result = await this.api.getProductionRunLog(runId, { cursor, limit });

        if (!this.isCurrentRequest(requestToken)) {
          return this.buildResult('stale');
        }

        if (!result.ok) {
          return this.applyApiError(result.error);
        }

        merged = mergeHeadlessRunLogItems(merged, result.data.log.items);
        cursor = result.data.log.nextCursor;
        hasMore = result.data.log.hasMore;

        if (!hasMore) {
          break;
        }
      }

      this.failureCount = 0;
      this.state = {
        ...this.state,
        logItems: merged,
        nextCursor: cursor,
        hasMore,
        transientError: null,
        lastError: null
      };

      return this.buildResult(this.state.run && isTerminalHeadlessRunStatus(this.state.run.status) ? 'terminal' : 'updated');
    } catch (error) {
      if (!this.isCurrentRequest(requestToken)) {
        return this.buildResult('stale');
      }
      return this.applyTransportError(error);
    } finally {
      this.endRequest(requestToken);
    }
  }

  async poll(limit = DEFAULT_LOG_PAGE_LIMIT): Promise<ProductionRunTrackerStepResult> {
    const runId = this.state.runId;
    if (!runId) {
      return this.buildResult('idle');
    }

    const requestToken = this.beginRequest();
    if (requestToken === null) {
      return this.buildResult('skipped');
    }

    try {
      const runResult = await this.api.getProductionRun(runId);

      if (!this.isCurrentRequest(requestToken)) {
        return this.buildResult('stale');
      }

      if (!runResult.ok) {
        return this.applyApiError(runResult.error);
      }

      const logResult = await this.api.getProductionRunLog(runId, {
        cursor: this.state.nextCursor,
        limit
      });

      if (!this.isCurrentRequest(requestToken)) {
        return this.buildResult('stale');
      }

      if (!logResult.ok) {
        return this.applyApiError(logResult.error);
      }

      this.failureCount = 0;
      this.state = {
        ...this.state,
        run: runResult.data.run,
        logItems: mergeHeadlessRunLogItems(this.state.logItems, logResult.data.log.items),
        nextCursor: logResult.data.log.nextCursor,
        hasMore: logResult.data.log.hasMore,
        restartLost: false,
        transientError: null,
        lastError: null
      };

      return this.buildResult(isTerminalHeadlessRunStatus(runResult.data.run.status) ? 'terminal' : 'updated');
    } catch (error) {
      if (!this.isCurrentRequest(requestToken)) {
        return this.buildResult('stale');
      }
      return this.applyTransportError(error);
    } finally {
      this.endRequest(requestToken);
    }
  }

  private beginRequest(): number | null {
    if (this.inFlight) {
      return null;
    }

    this.inFlight = true;
    return this.sessionToken;
  }

  private endRequest(requestToken: number | null): void {
    if (requestToken !== null && this.isCurrentRequest(requestToken)) {
      this.inFlight = false;
    }
  }

  private isCurrentRequest(requestToken: number): boolean {
    return requestToken === this.sessionToken;
  }

  private applyApiError(error: ProductionRunApiError): ProductionRunTrackerStepResult {
    if (error.code === 'NOT_FOUND') {
      this.failureCount = 0;
      this.state = {
        ...this.state,
        restartLost: true,
        transientError: null,
        lastError: error
      };
      return this.buildResult('restart_lost');
    }

    this.failureCount += 1;
    this.state = {
      ...this.state,
      transientError: `${error.message}${error.code ? ` (${error.code})` : ''}`,
      lastError: error
    };
    return this.buildResult('transient_error');
  }

  private applyTransportError(error: unknown): ProductionRunTrackerStepResult {
    this.failureCount += 1;
    const message = error instanceof Error ? error.message : 'Network error while polling server run.';
    this.state = {
      ...this.state,
      transientError: message,
      lastError: null
    };
    return this.buildResult('transient_error');
  }

  private buildResult(kind: ProductionRunTrackerStepResult['kind']): ProductionRunTrackerStepResult {
    const runStatus = this.state.run?.status;
    const shouldContinue = Boolean(this.state.runId) && !this.state.restartLost && !!runStatus && !isTerminalHeadlessRunStatus(runStatus) && kind !== 'stale';

    return {
      kind,
      shouldContinue,
      nextDelayMs: getProductionRunPollDelayMs(this.failureCount),
      state: this.getState()
    };
  }
}