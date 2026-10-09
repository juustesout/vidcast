import { describe, expect, it } from 'vitest';

import { formatProductionLogAsText } from '@/lib/production/production-log-export';
import type { ProductionRunnerEvent } from '@/lib/production/production-runner';

function event(partial: Partial<ProductionRunnerEvent> & Pick<ProductionRunnerEvent, 'timestamp' | 'iteration' | 'code' | 'status' | 'message'>): ProductionRunnerEvent {
  return {
    actionId: partial.actionId,
    actionType: partial.actionType,
    sceneId: partial.sceneId,
    error: partial.error,
    timestamp: partial.timestamp,
    iteration: partial.iteration,
    code: partial.code,
    status: partial.status,
    message: partial.message
  };
}

describe('formatProductionLogAsText', () => {
  it('serializes events into readable plain text output', () => {
    const text = formatProductionLogAsText({
      runStatus: 'partial',
      summary: { completed: 5, failed: 1, running: 0, waiting: 1 },
      events: [
        event({
          timestamp: '2026-10-08T17:14:03.000Z',
          iteration: 0,
          code: 'run_started',
          status: 'started',
          message: 'Production started.'
        }),
        event({
          timestamp: '2026-10-08T17:14:09.000Z',
          iteration: 1,
          code: 'action_completed',
          actionType: 'image_generate',
          sceneId: 'scene-2',
          status: 'completed',
          message: 'Scene 2 Image completed.'
        })
      ]
    });

    expect(text).toContain('Production run: partial');
    expect(text).toContain('RUN      Production started.');
    expect(text).toContain('IMAGE    Scene 2 Image completed.');
    expect(text).toContain('Summary:');
    expect(text).toContain('Completed: 5');
  });

  it('preserves input event ordering', () => {
    const text = formatProductionLogAsText({
      runStatus: 'running',
      summary: { completed: 0, failed: 0, running: 1, waiting: 0 },
      events: [
        event({ timestamp: '2026-10-08T17:00:01.000Z', iteration: 1, code: 'plan_created', status: 'info', message: '2 actions ready.' }),
        event({ timestamp: '2026-10-08T17:00:02.000Z', iteration: 1, code: 'action_started', status: 'started', actionType: 'scene_render', sceneId: 'scene-4', message: 'Scene 4 Render started.' }),
        event({ timestamp: '2026-10-08T17:00:03.000Z', iteration: 1, code: 'action_waiting', status: 'waiting', actionType: 'final_compose', message: 'Compose waiting: unresolved scene.' })
      ]
    });

    const first = text.indexOf('PLAN     2 actions ready.');
    const second = text.indexOf('RENDER   Scene 4 Render started.');
    const third = text.indexOf('COMPOSE  Compose waiting: unresolved scene.');

    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('keeps error diagnostics readable in exported text', () => {
    const text = formatProductionLogAsText({
      runStatus: 'failed',
      summary: { completed: 1, failed: 1, running: 0, waiting: 0 },
      events: [
        event({
          timestamp: '2026-10-08T17:01:10.000Z',
          iteration: 1,
          code: 'action_failed',
          status: 'failed',
          actionType: 'narration_generate',
          sceneId: 'scene-2',
          message: 'Scene 2 TTS failed: provider error.',
          error: {
            message: 'provider error',
            code: 'TTS_PROVIDER_ERROR',
            httpStatus: 500,
            endpoint: '/api/projects/p/scenes/scene-2/generate-narration',
            attemptId: 'attempt-2'
          }
        })
      ]
    });

    expect(text).toContain('TTS      Scene 2 TTS failed: provider error.');
    expect(text).toContain('code=TTS_PROVIDER_ERROR');
    expect(text).toContain('status=500');
    expect(text).toContain('endpoint=/api/projects/p/scenes/scene-2/generate-narration');
    expect(text).toContain('attempt=attempt-2');
  });

  it('does not export sensitive unknown fields', () => {
    const errorWithSensitive = {
      message: 'bad',
      code: 'X',
      endpoint: '/safe',
      apiKey: 'secret-key',
      token: 'secret-token',
      authorization: 'Bearer abc'
    } as unknown as ProductionRunnerEvent['error'];

    const text = formatProductionLogAsText({
      runStatus: 'failed',
      summary: { completed: 0, failed: 1, running: 0, waiting: 0 },
      events: [
        event({
          timestamp: '2026-10-08T17:02:00.000Z',
          iteration: 1,
          code: 'action_failed',
          status: 'failed',
          actionType: 'image_generate',
          message: 'Image failed.',
          error: errorWithSensitive
        })
      ]
    });

    expect(text).not.toContain('secret-key');
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('Bearer abc');
    expect(text).toContain('endpoint=/safe');
  });

  it('handles empty logs safely', () => {
    const text = formatProductionLogAsText({
      runStatus: 'idle',
      summary: { completed: 0, failed: 0, running: 0, waiting: 0 },
      events: []
    });

    expect(text).toContain('Production run: idle');
    expect(text).toContain('Started: N/A');
    expect(text).toContain('Finished: N/A');
    expect(text).toContain('No events recorded.');
  });
});
