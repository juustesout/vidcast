import { describe, expect, it } from 'vitest';

import { HeadlessProductionRunService } from '@/lib/production/run-service';
import type { Project } from '@/lib/types/render';

function createProject(id: string): Project {
  const now = new Date().toISOString();
  return {
    id,
    title: `Project ${id}`,
    description: '',
    durationTarget: 10,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 3,
        type: 'image',
        narration: { text: '' },
        visual: {
          kind: 'generated_image',
          generation: {
            id: 'gen-1',
            kind: 'image',
            status: 'planned',
            provider: 'openai',
            prompt: 'A scene prompt',
            referenceIds: [],
            aspectRatio: '16:9',
            createdAt: now
          }
        },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ],
    assets: [],
    references: [],
    compositions: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    }
  };
}

async function waitForStatus(service: HeadlessProductionRunService, runId: string, allowed: string[], maxAttempts = 60): Promise<string> {
  for (let i = 0; i < maxAttempts; i += 1) {
    const run = service.getRun(runId);
    if (allowed.includes(run.status)) {
      return run.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error('Run did not reach expected status in time.');
}

describe('headless production run service', () => {
  it('locks default mock providers server-side for action execution', async () => {
    const project = createProject('project-mock');
    let calledProvider: string | undefined;

    const service = new HeadlessProductionRunService(
      {
        maxConcurrentRuns: 1,
        runner: {
          maxIterations: 5,
          maxActionExecutions: 5,
          maxVideoPolls: 5,
          limits: {
            image_generate: 1,
            video_submit: 1,
            video_poll: 1,
            narration_generate: 1,
            scene_render: 1,
            final_compose: 1
          }
        },
        registry: {
          maxEventsPerRun: 100,
          retentionMs: 60_000,
          maxLogPageLimit: 100
        },
        policy: {
          allowRealProviders: true,
          defaultMode: 'mock'
        }
      },
      {
        store: {
          async getProject(projectId: string) {
            return projectId === project.id ? project : null;
          }
        },
        runBatch: async (input) => {
          await input.executeAction({
            id: 'scene:scene-1:image_generate',
            type: 'image_generate',
            sceneId: 'scene-1',
            sceneOrder: 1,
            status: 'ready',
            execute: true,
            dependencyActionIds: [],
            payload: { regenerate: false }
          });

          return {
            status: 'completed',
            project: input.initialProject,
            iterations: 1,
            completedActionIds: ['scene:scene-1:image_generate'],
            failedActionIds: [],
            unresolvedActions: [],
            events: []
          };
        },
        generateImage: async (_projectId, _sceneId, options) => {
          calledProvider = options?.provider;
          return {
            sceneId: 'scene-1',
            status: 'generated',
            generationAttemptId: 'attempt-1',
            provider: 'fake',
            assetId: 'asset-1'
          };
        }
      }
    );

    const started = await service.startOrReuseRun({ projectId: project.id });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(calledProvider).toBe('fake');
  });

  it('returns existing active run on duplicate start for the same project', async () => {
    const project = createProject('project-dup');
    let resolveRun: (() => void) | undefined;

    const service = new HeadlessProductionRunService(
      {
        maxConcurrentRuns: 1,
        runner: {
          maxIterations: 5,
          maxActionExecutions: 5,
          maxVideoPolls: 5,
          limits: {
            image_generate: 1,
            video_submit: 1,
            video_poll: 1,
            narration_generate: 1,
            scene_render: 1,
            final_compose: 1
          }
        },
        registry: {
          maxEventsPerRun: 100,
          retentionMs: 60_000,
          maxLogPageLimit: 100
        },
        policy: {
          allowRealProviders: true,
          defaultMode: 'mock'
        }
      },
      {
        store: {
          async getProject(projectId: string) {
            return projectId === project.id ? project : null;
          }
        },
        runBatch: async (input) => {
          await new Promise<void>((resolve) => {
            resolveRun = resolve;
          });
          return {
            status: 'completed',
            project: input.initialProject,
            iterations: 1,
            completedActionIds: [],
            failedActionIds: [],
            unresolvedActions: [],
            events: []
          };
        }
      }
    );

    const first = await service.startOrReuseRun({ projectId: project.id });
    const second = await service.startOrReuseRun({ projectId: project.id });

    expect(second.reused).toBe(true);
    expect(second.run.runId).toBe(first.run.runId);

    resolveRun?.();
    await waitForStatus(service, first.run.runId, ['completed', 'failed']);
  });

  it('queues runs across projects when global concurrency is saturated', async () => {
    const projectA = createProject('project-a');
    const projectB = createProject('project-b');

    const resolvers: Array<() => void> = [];

    const service = new HeadlessProductionRunService(
      {
        maxConcurrentRuns: 1,
        runner: {
          maxIterations: 5,
          maxActionExecutions: 5,
          maxVideoPolls: 5,
          limits: {
            image_generate: 1,
            video_submit: 1,
            video_poll: 1,
            narration_generate: 1,
            scene_render: 1,
            final_compose: 1
          }
        },
        registry: {
          maxEventsPerRun: 100,
          retentionMs: 60_000,
          maxLogPageLimit: 100
        },
        policy: {
          allowRealProviders: true,
          defaultMode: 'mock'
        }
      },
      {
        store: {
          async getProject(projectId: string) {
            if (projectId === projectA.id) return projectA;
            if (projectId === projectB.id) return projectB;
            return null;
          }
        },
        runBatch: async (input) => {
          await new Promise<void>((resolve) => {
            resolvers.push(resolve);
          });
          return {
            status: 'completed',
            project: input.initialProject,
            iterations: 1,
            completedActionIds: [],
            failedActionIds: [],
            unresolvedActions: [],
            events: []
          };
        }
      }
    );

    const first = await service.startOrReuseRun({ projectId: projectA.id });
    const second = await service.startOrReuseRun({ projectId: projectB.id });

    const firstStatus = await waitForStatus(service, first.run.runId, ['running', 'completed']);
    const secondSnapshot = service.getRun(second.run.runId);

    expect(firstStatus).toBe('running');
    expect(secondSnapshot.status).toBe('queued');

    resolvers.shift()?.();
    await waitForStatus(service, second.run.runId, ['running', 'completed']);
    resolvers.shift()?.();

    await waitForStatus(service, first.run.runId, ['completed']);
    await waitForStatus(service, second.run.runId, ['completed']);
  });

  it('returns NOT_FOUND when run state is missing (restart/expiry)', () => {
    const service = new HeadlessProductionRunService();

    expect(() => service.getRun('missing-run')).toThrow(/lost after a process restart/i);
  });
});
