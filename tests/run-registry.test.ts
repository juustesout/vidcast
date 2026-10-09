import { describe, expect, it } from 'vitest';

import { InMemoryRunRegistry } from '@/lib/production/run-registry';

const acceptedConfig = {
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
    maxIterations: 10,
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
};

describe('in-memory run registry', () => {
  it('stores runs and paginates logs with cursor/limit', () => {
    const registry = new InMemoryRunRegistry({
      maxEventsPerRun: 3,
      retentionMs: 60_000,
      maxLogPageLimit: 50
    });

    registry.createRun({ runId: 'run-1', projectId: 'project-1', acceptedConfig });

    for (let index = 0; index < 101; index += 1) {
      registry.appendEvent('run-1', {
        timestamp: new Date().toISOString(),
        iteration: 1,
        code: 'action_completed',
        status: 'completed',
        message: `event-${index}`,
        actionId: `a-${index}`,
        actionType: 'image_generate'
      });
    }

    const page = registry.getLogPage('run-1', { cursor: 0, limit: 2 });
    expect(page).not.toBeNull();
    expect(page?.items.length).toBe(2);
    expect(page?.items[0].cursor).toBe(1);
    expect(page?.hasMore).toBe(true);

    const next = registry.getLogPage('run-1', { cursor: page?.nextCursor, limit: 2 });
    expect(next?.items.length).toBe(2);
  });

  it('expires finished runs after retention window', () => {
    const registry = new InMemoryRunRegistry({
      maxEventsPerRun: 100,
      retentionMs: 100,
      maxLogPageLimit: 100
    });

    registry.createRun({ runId: 'run-old', projectId: 'project-1', acceptedConfig });
    registry.updateRunStatus('run-old', 'completed', { finishedAt: new Date(0).toISOString() });

    registry.sweepExpired(Date.now());
    expect(registry.getRun('run-old')).toBeNull();
  });

  it('redacts token-like values in run log messages', () => {
    const registry = new InMemoryRunRegistry({
      maxEventsPerRun: 100,
      retentionMs: 60_000,
      maxLogPageLimit: 100
    });

    registry.createRun({ runId: 'run-redact', projectId: 'project-1', acceptedConfig });
    registry.appendEvent('run-redact', {
      timestamp: new Date().toISOString(),
      iteration: 1,
      code: 'action_failed',
      status: 'failed',
      message: 'provider rejected Authorization: Bearer secret-token and key sk-abcdef123456',
      actionId: 'a-1',
      actionType: 'image_generate'
    });

    const page = registry.getLogPage('run-redact', { cursor: 0, limit: 10 });
    const message = page?.items[0]?.event.message ?? '';

    expect(message).toContain('[redacted]');
    expect(message).not.toContain('secret-token');
    expect(message).not.toContain('sk-abcdef123456');
  });
});
