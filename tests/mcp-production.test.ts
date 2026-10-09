import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductionApiClient } from '@/mcp/production/api-client';
import { HttpProductionApiClient } from '@/mcp/production/api-client';
import { PRODUCTION_TOOL_DEFINITIONS, createProductionToolService } from '@/mcp/production/tools';

function makeRun(runId = 'run-1') {
  const now = new Date().toISOString();
  return {
    runId,
    projectId: 'project-1',
    status: 'running' as const,
    createdAt: now,
    startedAt: now,
    summary: {
      completed: 1,
      failed: 0,
      running: 1,
      waiting: 0
    },
    completedActionIds: ['a1'],
    failedActionIds: [],
    unresolvedActions: [],
    acceptedConfig: {
      policy: {
        mode: 'mock' as const,
        allowRealProviders: false,
        providers: {
          image: 'fake' as const,
          video: 'local' as const,
          narration: 'fake' as const
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

function makeClient(overrides: Partial<ProductionApiClient> = {}): ProductionApiClient {
  return {
    runProduction: async () => ({ run: makeRun('run-start'), reused: false }),
    getRunStatus: async () => makeRun('run-status'),
    getRunLog: async () => ({ runId: 'run-log', cursor: 0, nextCursor: 1, hasMore: false, items: [] }),
    ...overrides
  };
}

describe('production MCP tool definitions', () => {
  it('registers expected mutating and run-inspection tools', () => {
    const names = PRODUCTION_TOOL_DEFINITIONS.map((entry) => entry.name);
    expect(names).toEqual(['run_production', 'get_run_status', 'get_run_log']);
    expect(PRODUCTION_TOOL_DEFINITIONS.find((entry) => entry.name === 'run_production')?.annotations.readOnlyHint).toBe(false);
  });
});

describe('production MCP tool service', () => {
  it('validates required arguments', async () => {
    const service = createProductionToolService(makeClient());

    const start = await service.runProduction({});
    const status = await service.getRunStatus({});
    const log = await service.getRunLog({ runId: 'ok', cursor: -1 });

    expect(start.ok).toBe(false);
    expect(status.ok).toBe(false);
    expect(log.ok).toBe(false);
  });

  it('returns structured start/status/log payloads', async () => {
    const service = createProductionToolService(makeClient());

    const started = await service.runProduction({ projectId: 'project-1' });
    const status = await service.getRunStatus({ runId: 'run-status' });
    const log = await service.getRunLog({ runId: 'run-log', limit: 50 });

    expect(started.ok).toBe(true);
    expect(status.ok).toBe(true);
    expect(log.ok).toBe(true);

    if (started.ok) {
      expect(started.data.run.runId).toBe('run-start');
      expect(started.data.reused).toBe(false);
    }

    if (status.ok) {
      expect(status.data.run.runId).toBe('run-status');
    }

    if (log.ok) {
      expect(log.data.log.runId).toBe('run-log');
    }
  });
});

describe('production HTTP API client behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('maps API_UNAVAILABLE when service is unreachable', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const client = new HttpProductionApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn
    });

    const service = createProductionToolService(client);
    const result = await service.runProduction({ projectId: 'project-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('API_UNAVAILABLE');
    }
  });

  it('uses POST for run start and GET for status/log', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const text = String(url);

      if (text.includes('/production-runs/') && text.endsWith('/log?cursor=2&limit=25')) {
        return new Response(
          JSON.stringify({
            log: {
              runId: 'run-1',
              cursor: 2,
              nextCursor: 3,
              hasMore: false,
              items: []
            }
          }),
          { status: 200 }
        );
      }

      if (text.includes('/production-runs/') && !text.endsWith('/log?cursor=2&limit=25')) {
        return new Response(JSON.stringify({ run: makeRun('run-1') }), { status: 200 });
      }

      return new Response(JSON.stringify({ run: makeRun('run-1'), reused: false }), { status: 202 });
    });

    const client = new HttpProductionApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: fetchMock as unknown as typeof fetch
    });

    await client.runProduction('project-1', { mode: 'mock' });
    await client.getRunStatus('run-1');
    await client.getRunLog('run-1', { cursor: 2, limit: 25 });

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [startCall, statusCall, logCall] = fetchMock.mock.calls;
    expect((startCall[1] as RequestInit)?.method).toBe('POST');
    expect((statusCall[1] as RequestInit)?.method).toBe('GET');
    expect((logCall[1] as RequestInit)?.method).toBe('GET');
  });

  it('forwards bearer token when EXPLAINER_API_TOKEN is configured', async () => {
    process.env.EXPLAINER_API_TOKEN = 'test-token';

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ run: makeRun('run-1'), reused: false }), { status: 202 }));
    const client = new HttpProductionApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: fetchMock as unknown as typeof fetch
    });

    await client.runProduction('project-1', { mode: 'mock' });

    const firstCall = fetchMock.mock.calls[0] as unknown[] | undefined;
    const init = (firstCall?.at(1) as RequestInit | undefined) ?? {};
    const headers = new Headers(init.headers ?? {});
    expect(headers.get('authorization')).toBe('Bearer test-token');

    delete process.env.EXPLAINER_API_TOKEN;
  });

  it('maps missing run to NOT_FOUND', async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(
        JSON.stringify({ message: 'Run not found. It may have expired from memory or been lost after a process restart.', code: 'NOT_FOUND' }),
        { status: 404 }
      );
    }) as unknown as typeof fetch;

    const client = new HttpProductionApiClient({ baseUrl: 'http://127.0.0.1:5555', fetchFn });
    const service = createProductionToolService(client);

    const result = await service.getRunStatus({ runId: 'missing-run' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });
});
