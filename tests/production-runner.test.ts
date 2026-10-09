import { describe, expect, it } from 'vitest';

import type { Project } from '@/lib/types/render';
import { createProductionRunnerError, runProductionBatch } from '@/lib/production/production-runner';
import type { ProductionActionType, ProductionPlan, ProductionPlannedAction } from '@/lib/production/production-planner';

const emptyProject = {
  id: 'project-runner',
  title: 'Runner',
  description: '',
  durationTarget: 30,
  aspectRatio: '16:9',
  fps: 30,
  scenes: [],
  assets: [],
  references: [],
  compositions: [],
  renderSettings: {
    aspectRatio: '16:9',
    fps: 30,
    width: 1920,
    height: 1080,
    background: { type: 'color', value: '#000' },
    audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
    subtitlesEnabled: true
  },
  narration: { text: '', segments: [] },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
} as unknown as Project;

function makeAction(id: string, type: ProductionActionType, status: ProductionPlannedAction['status'], sceneId?: string): ProductionPlannedAction {
  return {
    id,
    type,
    sceneId,
    sceneOrder: sceneId ? Number(sceneId.replace('s', '')) || 1 : undefined,
    status,
    execute: status === 'ready',
    dependencyActionIds: [],
    reason: ''
  };
}

function makePlan(actions: ProductionPlannedAction[]): ProductionPlan {
  const summary = {
    ready: actions.filter((entry) => entry.status === 'ready').length,
    waiting: actions.filter((entry) => entry.status === 'waiting_dependency').length,
    blocked: actions.filter((entry) => entry.status === 'blocked').length,
    current: actions.filter((entry) => entry.status === 'current').length,
    running: actions.filter((entry) => entry.status === 'running').length,
    failed: actions.filter((entry) => entry.status === 'failed').length,
    skipped: actions.filter((entry) => entry.status === 'skipped').length
  };

  return {
    actions,
    summary
  };
}

describe('runProductionBatch', () => {
  it('respects per-type concurrency limits', async () => {
    let concurrent = 0;
    let peak = 0;

    const plan = makePlan([
      makeAction('a1', 'image_generate', 'ready', 's1'),
      makeAction('a2', 'image_generate', 'ready', 's2'),
      makeAction('a3', 'image_generate', 'ready', 's3')
    ]);

    await runProductionBatch({
      initialProject: emptyProject,
      derivePlan: () => plan,
      refreshProject: async () => emptyProject,
      config: { maxIterations: 1, limits: { image_generate: 2, video_submit: 2, video_poll: 4, narration_generate: 2, scene_render: 1, final_compose: 1 } },
      executeAction: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
      }
    });

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('isolates failed actions and continues others', async () => {
    const executed: string[] = [];

    const first = makePlan([
      makeAction('img-1', 'image_generate', 'ready', 's1'),
      makeAction('img-2', 'image_generate', 'ready', 's2')
    ]);
    const second = makePlan([]);

    let calls = 0;
    const result = await runProductionBatch({
      initialProject: emptyProject,
      derivePlan: () => {
        calls += 1;
        return calls === 1 ? first : second;
      },
      refreshProject: async () => emptyProject,
      executeAction: async (action) => {
        executed.push(action.id);
        if (action.id === 'img-1') {
          throw new Error('boom');
        }
      }
    });

    expect(executed).toEqual(expect.arrayContaining(['img-1', 'img-2']));
    expect(result.failedActionIds).toContain('img-1');
    expect(result.completedActionIds).toContain('img-2');
  });

  it('does not execute running or current actions and logs their status', async () => {
    const executed: string[] = [];
    const plan = makePlan([
      makeAction('run-1', 'video_submit', 'running', 's1'),
      makeAction('cur-1', 'narration_generate', 'current', 's2'),
      makeAction('ready-1', 'video_poll', 'ready', 's3')
    ]);

    const result = await runProductionBatch({
      initialProject: emptyProject,
      derivePlan: () => plan,
      refreshProject: async () => emptyProject,
      config: { maxIterations: 1 },
      executeAction: async (action) => {
        executed.push(action.id);
      }
    });

    expect(executed).toEqual(['ready-1']);
    expect(result.events.some((event) => event.code === 'action_running' && event.actionId === 'run-1')).toBe(true);
    expect(result.events.some((event) => event.code === 'action_current' && event.actionId === 'cur-1')).toBe(true);
  });

  it('marks unresolved when only waiting actions remain and logs stop reason', async () => {
    const plan = makePlan([
      {
        ...makeAction('wait-1', 'scene_render', 'waiting_dependency', 's1'),
        execute: false,
        dependencyActionIds: ['img-1'],
        reason: 'Waiting for visual generation to become current.'
      }
    ]);

    const result = await runProductionBatch({
      initialProject: emptyProject,
      derivePlan: () => plan,
      refreshProject: async () => emptyProject,
      config: { maxIterations: 2 },
      executeAction: async () => {
        throw new Error('should not run');
      }
    });

    expect(result.unresolvedActions.map((entry) => entry.id)).toContain('wait-1');
    expect(result.events.some((event) => event.code === 'action_waiting' && event.actionId === 'wait-1')).toBe(true);
    expect(result.events.some((event) => event.code === 'run_stopped_unresolved')).toBe(true);
  });

  it('runs compose once when ready then exits on current', async () => {
    const executed: string[] = [];
    const plans = [
      makePlan([makeAction('compose', 'final_compose', 'ready')]),
      makePlan([makeAction('compose', 'final_compose', 'current')])
    ];
    let pointer = 0;

    await runProductionBatch({
      initialProject: emptyProject,
      derivePlan: () => plans[Math.min(pointer, plans.length - 1)],
      refreshProject: async () => {
        pointer += 1;
        return emptyProject;
      },
      executeAction: async (action) => {
        executed.push(action.id);
      }
    });

    expect(executed).toEqual(['compose']);
  });

  it('emits lifecycle, scheduling, start, completion and refresh events in order', async () => {
    const plans = [
      makePlan([makeAction('img-1', 'image_generate', 'ready', 's1')]),
      makePlan([])
    ];
    let pointer = 0;

    const result = await runProductionBatch({
      initialProject: emptyProject,
      derivePlan: () => plans[Math.min(pointer, plans.length - 1)],
      refreshProject: async () => {
        pointer += 1;
        return emptyProject;
      },
      executeAction: async () => ({ message: 'ok' })
    });

    const codes = result.events.map((event) => event.code);
    expect(codes[0]).toBe('run_started');
    expect(codes).toContain('plan_created');
    expect(codes).toContain('action_scheduled');
    expect(codes).toContain('action_started');
    expect(codes).toContain('action_completed');
    expect(codes).toContain('refresh_started');
    expect(codes).toContain('refresh_completed');
    expect(codes[codes.length - 1]).toBe('run_completed');
  });

  it('logs failed action diagnostics and excludes sensitive fields', async () => {
    const plan = makePlan([makeAction('img-1', 'image_generate', 'ready', 's1')]);
    const result = await runProductionBatch({
      initialProject: emptyProject,
      derivePlan: () => plan,
      refreshProject: async () => emptyProject,
      config: { maxIterations: 1 },
      executeAction: async () => {
        const diagnosticsWithSensitive = {
          message: 'provider failure',
          code: 'PROVIDER_DOWN',
          endpoint: '/api/projects/p/scenes/s1/generate-image',
          providerStatus: '503',
          attemptId: 'attempt-1',
          httpStatus: 502,
          details: 'timeout',
          apiKey: 'secret-key',
          token: 'secret-token'
        } as unknown as Parameters<typeof createProductionRunnerError>[1];

        throw createProductionRunnerError('provider failure', {
          ...diagnosticsWithSensitive
        });
      }
    });

    const failedEvent = result.events.find((event) => event.code === 'action_failed');
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.error?.code).toBe('PROVIDER_DOWN');
    expect(failedEvent?.error?.endpoint).toBe('/api/projects/p/scenes/s1/generate-image');
    expect(JSON.stringify(failedEvent?.error ?? {})).not.toContain('secret-key');
    expect(JSON.stringify(failedEvent?.error ?? {})).not.toContain('secret-token');
  });

  it('emits video poll scheduled and completed events', async () => {
    const plan = makePlan([makeAction('poll-1', 'video_poll', 'ready', 's4')]);
    const result = await runProductionBatch({
      initialProject: emptyProject,
      derivePlan: () => plan,
      refreshProject: async () => emptyProject,
      config: { maxIterations: 1 },
      executeAction: async () => ({ message: 'polled' })
    });

    expect(result.events.some((event) => event.code === 'video_poll_scheduled')).toBe(true);
    expect(result.events.some((event) => event.code === 'video_poll_completed')).toBe(true);
  });

  it('emits blocked and skipped diagnostics from plan state', async () => {
    const plan = makePlan([
      {
        ...makeAction('skip-1', 'image_generate', 'skipped', 's3'),
        execute: false,
        reason: 'Skipped by user.'
      },
      {
        ...makeAction('blocked-1', 'scene_render', 'blocked', 's7'),
        execute: false,
        reason: 'Scene is not renderable yet.'
      }
    ]);

    const result = await runProductionBatch({
      initialProject: emptyProject,
      derivePlan: () => plan,
      refreshProject: async () => emptyProject,
      config: { maxIterations: 1 },
      executeAction: async () => {
        throw new Error('should not run');
      }
    });

    expect(result.events.some((event) => event.code === 'action_skipped' && event.actionId === 'skip-1')).toBe(true);
    expect(result.events.some((event) => event.code === 'action_blocked' && event.actionId === 'blocked-1')).toBe(true);
  });

  it('emits composition lifecycle events', async () => {
    const plan = makePlan([makeAction('compose', 'final_compose', 'ready')]);
    const result = await runProductionBatch({
      initialProject: emptyProject,
      derivePlan: () => plan,
      refreshProject: async () => emptyProject,
      config: { maxIterations: 1 },
      executeAction: async () => ({ message: 'composed' })
    });

    expect(result.events.some((event) => event.code === 'composition_started')).toBe(true);
    expect(result.events.some((event) => event.code === 'composition_completed')).toBe(true);
  });
});
