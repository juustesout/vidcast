import { describe, expect, it } from 'vitest';

import { HeadlessProductionRunService, type RunServiceConfig } from '@/lib/production/run-service';
import type { ProductionRunnerResult } from '@/lib/production/production-runner';
import type { Project } from '@/lib/types/render';

type ReadStep = 'project' | 'null' | 'throw';

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

function baseConfig(overrides: Partial<RunServiceConfig> = {}): RunServiceConfig {
  return {
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
      maxEventsPerRun: 200,
      retentionMs: 60_000,
      maxLogPageLimit: 200
    },
    policy: {
      allowRealProviders: true,
      defaultMode: 'mock'
    },
    ...overrides
  };
}

// Deterministic store whose getProject responses are scripted per call. The
// last step is repeated once the script is exhausted.
function sequenceStore(
  project: Project,
  sequence: ReadStep[]
): { store: { getProject(id: string): Promise<Project | null> }; reads: () => number } {
  let index = 0;
  return {
    store: {
      async getProject(id: string) {
        if (id !== project.id) {
          return null;
        }
        const step = sequence[Math.min(index, sequence.length - 1)];
        index += 1;
        if (step === 'throw') {
          throw new Error('simulated read failure');
        }
        return step === 'project' ? project : null;
      }
    },
    reads: () => index
  };
}

function completedResult(project: Project): ProductionRunnerResult {
  return {
    status: 'completed',
    project,
    iterations: 1,
    completedActionIds: [],
    failedActionIds: [],
    unresolvedActions: [],
    events: []
  };
}

async function waitForStatus(
  service: HeadlessProductionRunService,
  runId: string,
  allowed: string[],
  maxAttempts = 100
): Promise<string> {
  for (let i = 0; i < maxAttempts; i += 1) {
    const run = service.getRun(runId);
    if (allowed.includes(run.status)) {
      return run.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Run did not reach expected status in time.');
}

describe('production run lifecycle robustness', () => {
  it('coalesces concurrent starts for the same project onto a single run', async () => {
    const project = createProject('project-race');
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let readCount = 0;

    const service = new HeadlessProductionRunService(
      baseConfig({ refreshRetry: { attempts: 3, delayMs: 0 } }),
      {
        store: {
          async getProject(projectId: string) {
            readCount += 1;
            await gate;
            return projectId === project.id ? project : null;
          }
        },
        runBatch: async (input) => completedResult(input.initialProject),
        delay: async () => {}
      }
    );

    // Both requests are issued in the same synchronous tick, so the second
    // arrives while the first is still awaiting the project read.
    const first = service.startOrReuseRun({ projectId: project.id });
    const second = service.startOrReuseRun({ projectId: project.id });

    // The second request coalesced onto the first and never read the project.
    expect(readCount).toBe(1);

    releaseGate();
    const [a, b] = await Promise.all([first, second]);

    expect(a.run.runId).toBe(b.run.runId);
    expect([a.reused, b.reused].filter((value) => value === false)).toHaveLength(1);

    await waitForStatus(service, a.run.runId, ['completed']);
  });

  it('does not leave a run stuck in running when the pre-execution project read throws', async () => {
    const project = createProject('project-read-error');
    let runBatchCalls = 0;
    // performStart reads once (ok); executeRun's initial read then fails.
    const { store, reads } = sequenceStore(project, ['project', 'throw']);

    const service = new HeadlessProductionRunService(
      baseConfig({ refreshRetry: { attempts: 3, delayMs: 0 } }),
      {
        store,
        runBatch: async () => {
          runBatchCalls += 1;
          return completedResult(project);
        },
        delay: async () => {}
      }
    );

    const started = await service.startOrReuseRun({ projectId: project.id });
    const status = await waitForStatus(service, started.run.runId, ['failed']);

    expect(status).toBe('failed');
    expect(runBatchCalls).toBe(0);
    // 1 start read + 3 bounded initial-read attempts; never unbounded.
    expect(reads()).toBe(4);

    const snapshot = service.getRun(started.run.runId);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.finishedAt).toBeDefined();

    const log = service.getRunLog(started.run.runId);
    const failure = log.items.find((item) => item.event.code === 'run_failed');
    expect(failure?.event.message).toMatch(/could not be read/i);
  });

  it('recovers from a transient refreshProject null and completes the run', async () => {
    const project = createProject('project-transient-refresh');
    // start read, initial read, one transient null, then healthy.
    const { store, reads } = sequenceStore(project, ['project', 'project', 'null', 'project']);

    const service = new HeadlessProductionRunService(
      baseConfig({ refreshRetry: { attempts: 3, delayMs: 0 } }),
      {
        store,
        runBatch: async (input) => {
          // Force the runner to exercise the refresh path exactly once.
          await input.refreshProject();
          return completedResult(input.initialProject);
        },
        delay: async () => {}
      }
    );

    const started = await service.startOrReuseRun({ projectId: project.id });
    const status = await waitForStatus(service, started.run.runId, ['completed']);

    expect(status).toBe('completed');
    expect(reads()).toBe(4);

    const log = service.getRunLog(started.run.runId);
    expect(log.items.some((item) => item.event.code === 'run_failed')).toBe(false);
  });

  it('fails a run after a bounded number of attempts when refreshProject stays null', async () => {
    const project = createProject('project-persistent-refresh');
    // start read, initial read, then every refresh read is null.
    const { store, reads } = sequenceStore(project, ['project', 'project', 'null']);

    const service = new HeadlessProductionRunService(
      baseConfig({ refreshRetry: { attempts: 3, delayMs: 0 } }),
      {
        store,
        runBatch: async (input) => {
          await input.refreshProject();
          return completedResult(input.initialProject);
        },
        delay: async () => {}
      }
    );

    const started = await service.startOrReuseRun({ projectId: project.id });
    const status = await waitForStatus(service, started.run.runId, ['failed']);

    expect(status).toBe('failed');
    // 1 start read + 1 initial read + 3 bounded refresh attempts.
    expect(reads()).toBe(5);

    const log = service.getRunLog(started.run.runId);
    const failure = log.items.find((item) => item.event.code === 'run_failed');
    expect(failure?.event.message).toMatch(/during run refresh/i);
  });

  it('fails a run when refreshProject reads throw persistently, without hanging', async () => {
    const project = createProject('project-refresh-error');
    // start read, initial read, then every refresh read throws.
    const { store, reads } = sequenceStore(project, ['project', 'project', 'throw']);

    const service = new HeadlessProductionRunService(
      baseConfig({ refreshRetry: { attempts: 3, delayMs: 0 } }),
      {
        store,
        runBatch: async (input) => {
          await input.refreshProject();
          return completedResult(input.initialProject);
        },
        delay: async () => {}
      }
    );

    const started = await service.startOrReuseRun({ projectId: project.id });
    const status = await waitForStatus(service, started.run.runId, ['failed']);

    expect(status).toBe('failed');
    // 1 start read + 1 initial read + 3 bounded refresh attempts.
    expect(reads()).toBe(5);

    const log = service.getRunLog(started.run.runId);
    const failure = log.items.find((item) => item.event.code === 'run_failed');
    expect(failure?.event.message).toMatch(/could not be read during run refresh/i);
  });
});
