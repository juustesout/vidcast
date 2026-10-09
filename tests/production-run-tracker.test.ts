import { describe, expect, it, vi } from 'vitest';

import { ProductionRunTracker, getProductionRunPollDelayMs, isTerminalHeadlessRunStatus, mergeHeadlessRunLogItems, startServerRunFlow } from '@/lib/client/production-run-tracker';
import type { HeadlessRunSnapshot } from '@/lib/production/run-types';

function makeRun(status: HeadlessRunSnapshot['status'] = 'running', runId = 'run-1'): HeadlessRunSnapshot {
  const now = new Date().toISOString();

  return {
    runId,
    projectId: 'project-1',
    status,
    createdAt: now,
    startedAt: now,
    summary: {
      completed: 1,
      failed: status === 'failed' ? 1 : 0,
      running: status === 'running' ? 1 : 0,
      waiting: status === 'queued' ? 1 : 0
    },
    completedActionIds: ['scene:1:image_generate'],
    failedActionIds: status === 'failed' ? ['scene:1:scene_render'] : [],
    unresolvedActions: [],
    acceptedConfig: {
      policy: {
        mode: 'mock',
        allowRealProviders: false,
        providers: {
          image: 'fake',
          video: 'local',
          narration: 'fake'
        }
      },
      limits: {
        maxIterations: 20,
        maxActionExecutions: 100,
        maxVideoPolls: 40,
        perActionConcurrency: {
          image_generate: 2,
          video_submit: 2,
          video_poll: 4,
          narration_generate: 2,
          scene_render: 1,
          final_compose: 1
        }
      }
    }
  };
}

function makeLogItem(cursor: number, message: string) {
  return {
    cursor,
    event: {
      timestamp: new Date().toISOString(),
      iteration: 1,
      code: 'action_completed' as const,
      status: 'completed' as const,
      message,
      actionId: `action-${cursor}`,
      actionType: 'image_generate' as const
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

describe('production run tracker helpers', () => {
  it('recognizes terminal lifecycle states', () => {
    expect(isTerminalHeadlessRunStatus('queued')).toBe(false);
    expect(isTerminalHeadlessRunStatus('running')).toBe(false);
    expect(isTerminalHeadlessRunStatus('completed')).toBe(true);
    expect(isTerminalHeadlessRunStatus('partial')).toBe(true);
    expect(isTerminalHeadlessRunStatus('failed')).toBe(true);
    expect(isTerminalHeadlessRunStatus('unresolved')).toBe(true);
  });

  it('backs off transient poll retries and merges log pages without duplicates', () => {
    expect(getProductionRunPollDelayMs(0)).toBe(2500);
    expect(getProductionRunPollDelayMs(1)).toBe(5000);
    expect(getProductionRunPollDelayMs(3)).toBe(15000);
    expect(getProductionRunPollDelayMs(5)).toBe(15000);

    const merged = mergeHeadlessRunLogItems([makeLogItem(0, 'first')], [makeLogItem(0, 'first-updated'), makeLogItem(1, 'second')]);

    expect(merged.map((item) => ({ cursor: item.cursor, message: item.event.message }))).toEqual([
      { cursor: 0, message: 'first-updated' },
      { cursor: 1, message: 'second' }
    ]);
  });
});

describe('startServerRunFlow', () => {
  it('prevents a start request when save fails', async () => {
    const startRun = vi.fn();

    const result = await startServerRunFlow({
      projectId: 'project-1',
      ensureSaved: async () => false,
      startRun
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockedBySave).toBe(true);
    }
    expect(startRun).not.toHaveBeenCalled();
  });

  it('returns reused-run success without rewriting the response', async () => {
    const startRun = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: {
        run: makeRun('running', 'run-reused'),
        reused: true
      }
    }));

    const result = await startServerRunFlow({
      projectId: 'project-1',
      ensureSaved: async () => true,
      startRun
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.data.reused).toBe(true);
      expect(result.result.data.run.runId).toBe('run-reused');
    }
  });
});

describe('ProductionRunTracker', () => {
  it('stops polling on terminal statuses and appends incremental logs', async () => {
    const tracker = new ProductionRunTracker({
      getProductionRun: async () => ({
        ok: true,
        status: 200,
        data: { run: makeRun('completed') }
      }),
      getProductionRunLog: async (_runId, request) => ({
        ok: true,
        status: 200,
        data: {
          log: {
            runId: 'run-1',
            cursor: request?.cursor ?? 0,
            nextCursor: 2,
            hasMore: false,
            items: [makeLogItem(0, 'started'), makeLogItem(1, 'finished')]
          }
        }
      })
    });

    tracker.trackRun(makeRun('running'));
    const result = await tracker.poll();

    expect(result.kind).toBe('terminal');
    expect(result.shouldContinue).toBe(false);
    expect(result.state.run?.status).toBe('completed');
    expect(result.state.logItems).toHaveLength(2);
  });

  it('retries transient transport failures without marking the run failed', async () => {
    const tracker = new ProductionRunTracker({
      getProductionRun: async () => {
        throw new Error('network down');
      },
      getProductionRunLog: async () => ({
        ok: true,
        status: 200,
        data: {
          log: {
            runId: 'run-1',
            cursor: 0,
            nextCursor: 0,
            hasMore: false,
            items: []
          }
        }
      })
    });

    tracker.trackRun(makeRun('running'));
    const result = await tracker.poll();

    expect(result.kind).toBe('transient_error');
    expect(result.shouldContinue).toBe(true);
    expect(result.state.transientError).toContain('network down');
    expect(result.nextDelayMs).toBeGreaterThan(2500);
  });

  it('prevents overlapping polls and ignores stale responses after invalidation', async () => {
    const pendingRun = deferred<{ ok: true; status: number; data: { run: HeadlessRunSnapshot } }>();
    const getRun = vi.fn(async () => pendingRun.promise);
    const getRunLog = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: {
        log: {
          runId: 'run-1',
          cursor: 0,
          nextCursor: 0,
          hasMore: false,
          items: []
        }
      }
    }));

    const tracker = new ProductionRunTracker({ getProductionRun: getRun, getProductionRunLog: getRunLog });
    tracker.trackRun(makeRun('running'));

    const firstPoll = tracker.poll();
    const secondPoll = await tracker.poll();

    expect(secondPoll.kind).toBe('skipped');

    tracker.invalidate();
    pendingRun.resolve({
      ok: true,
      status: 200,
      data: { run: makeRun('running') }
    });

    const firstResult = await firstPoll;

    expect(firstResult.kind).toBe('stale');
    expect(getRunLog).not.toHaveBeenCalled();
  });

  it('handles restart-loss with NOT_FOUND without continuing to poll', async () => {
    const tracker = new ProductionRunTracker({
      getProductionRun: async () => ({
        ok: false,
        status: 404,
        error: {
          message: 'Run not found. It may have expired from memory or been lost after a process restart.',
          code: 'NOT_FOUND',
          httpStatus: 404
        }
      }),
      getProductionRunLog: async () => ({
        ok: true,
        status: 200,
        data: {
          log: {
            runId: 'run-1',
            cursor: 0,
            nextCursor: 0,
            hasMore: false,
            items: []
          }
        }
      })
    });

    tracker.trackRun(makeRun('running'));
    const result = await tracker.poll();

    expect(result.kind).toBe('restart_lost');
    expect(result.shouldContinue).toBe(false);
    expect(result.state.restartLost).toBe(true);
    expect(result.state.lastError?.code).toBe('NOT_FOUND');
  });

  it('loads multiple retained log pages for catch-up and older-page availability', async () => {
    const getRunLog = vi.fn(async (_runId: string, request?: { cursor?: number; limit?: number }) => {
      const cursor = request?.cursor ?? 0;

      if (cursor === 0) {
        return {
          ok: true as const,
          status: 200,
          data: {
            log: {
              runId: 'run-1',
              cursor: 0,
              nextCursor: 2,
              hasMore: true,
              items: [makeLogItem(0, 'oldest'), makeLogItem(1, 'older')]
            }
          }
        };
      }

      return {
        ok: true as const,
        status: 200,
        data: {
          log: {
            runId: 'run-1',
            cursor: 2,
            nextCursor: 4,
            hasMore: false,
            items: [makeLogItem(2, 'newer'), makeLogItem(3, 'newest')]
          }
        }
      };
    });

    const tracker = new ProductionRunTracker({
      getProductionRun: async () => ({
        ok: true,
        status: 200,
        data: { run: makeRun('running') }
      }),
      getProductionRunLog: getRunLog
    });

    tracker.trackRun(makeRun('running'));
    const result = await tracker.loadAvailableLogPages(2, 4);

    expect(result.kind).toBe('updated');
    expect(result.state.logItems.map((item) => item.cursor)).toEqual([0, 1, 2, 3]);
    expect(result.state.nextCursor).toBe(4);
    expect(getRunLog).toHaveBeenCalledTimes(2);
  });
});