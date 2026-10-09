import { afterEach, describe, expect, it, vi } from 'vitest';

import { getProductionRun, getProductionRunLog, startProductionRun } from '@/lib/client/production-run-client';

describe('production run client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a new started run response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      run: { runId: 'run-1' },
      reused: false
    }), { status: 202 })));

    const result = await startProductionRun('project-1', { mode: 'mock' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(202);
      expect(result.data.reused).toBe(false);
      expect(result.data.run.runId).toBe('run-1');
    }
  });

  it('preserves duplicate-run reuse responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      run: { runId: 'run-2' },
      reused: true
    }), { status: 200 })));

    const result = await startProductionRun('project-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.data.reused).toBe(true);
      expect(result.data.run.runId).toBe('run-2');
    }
  });

  it('propagates structured API error codes and validation details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      message: 'Missing provider credentials.',
      code: 'PROVIDER_NOT_CONFIGURED',
      details: {
        issues: [{ path: 'providers.image', code: 'invalid_value', message: 'Unsupported provider.' }]
      }
    }), { status: 409 })));

    const result = await startProductionRun('project-1', { providers: { image: 'openai' } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROVIDER_NOT_CONFIGURED');
      expect(result.error.httpStatus).toBe(409);
      expect(result.error.details).toEqual({
        issues: [{ path: 'providers.image', code: 'invalid_value', message: 'Unsupported provider.' }]
      });
    }
  });

  it('keeps NOT_FOUND on run status and validation errors on log pages', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);

      if (target.includes('/log')) {
        return new Response(JSON.stringify({
          message: 'cursor must be zero or greater.',
          code: 'INVALID_ARGUMENT'
        }), { status: 400 });
      }

      return new Response(JSON.stringify({
        message: 'Run not found. It may have expired from memory or been lost after a process restart.',
        code: 'NOT_FOUND'
      }), { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const runResult = await getProductionRun('missing-run');
    const logResult = await getProductionRunLog('run-1', { cursor: -1 });

    expect(runResult.ok).toBe(false);
    expect(logResult.ok).toBe(false);

    if (!runResult.ok) {
      expect(runResult.error.code).toBe('NOT_FOUND');
      expect(runResult.error.httpStatus).toBe(404);
    }

    if (!logResult.ok) {
      expect(logResult.error.code).toBe('INVALID_ARGUMENT');
      expect(logResult.error.httpStatus).toBe(400);
    }
  });
});