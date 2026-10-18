import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { deriveProductionPlan } from '@/lib/production/production-planner';
import { runProductionBatch, type ProductionRunnerResult } from '@/lib/production/production-runner';
import { reconcileInterruptedGenerations } from '@/lib/production/run-recovery';
import { HeadlessProductionRunService, type RunServiceConfig } from '@/lib/production/run-service';
import { FileRunStore, type PersistedRun } from '@/lib/production/run-store';
import type { GenerationRecord, GenerationStatus } from '@/lib/types/generation';
import type { Project } from '@/lib/types/render';
import type { NarrationSpec, Scene } from '@/lib/types/scene';

type RunBatch = typeof runProductionBatch;

const SERVICE_CONFIG: RunServiceConfig = {
  maxConcurrentRuns: 1,
  runner: {
    maxIterations: 5,
    maxActionExecutions: 10,
    maxVideoPolls: 5,
    limits: {
      image_generate: 1,
      stock_select: 1,
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
  }
};

function generation(overrides: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    id: 'gen-1',
    kind: 'image',
    status: 'generated',
    prompt: 'A scene prompt',
    referenceIds: [],
    aspectRatio: '16:9',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function imageScene(order: number, status: GenerationStatus, assetId?: string): Scene {
  return {
    id: `scene-${order}`,
    order,
    duration: 3,
    type: 'image',
    narration: { text: '' },
    visual: {
      kind: 'generated_image',
      assetId,
      generation: generation({ id: `gen-${order}`, kind: 'image', status, assetId })
    },
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: ''
  };
}

function project(id: string, scenes: Scene[], assets: Project['assets'] = []): Project {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id,
    title: id,
    description: '',
    durationTarget: 10,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    scenes,
    assets,
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

function createPersistedRun(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    runId: 'run-seed',
    projectId: 'project-r',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    summary: { completed: 0, failed: 0, running: 0, waiting: 0 },
    completedActionIds: [],
    failedActionIds: [],
    unresolvedActions: [],
    acceptedConfig: {
      policy: {
        mode: 'mock',
        allowRealProviders: false,
        providers: { image: 'fake', video: 'local', narration: 'fake', music: 'fake' }
      },
      limits: {
        maxIterations: 5,
        maxActionExecutions: 10,
        maxVideoPolls: 5,
        perActionConcurrency: {
          image_generate: 1,
          stock_select: 1,
          video_submit: 1,
          video_poll: 1,
          narration_generate: 1,
          scene_render: 1,
          final_compose: 1
        }
      }
    },
    events: [],
    eventOffset: 0,
    ...overrides
  };
}

function makeRunBatch(batches: Array<{ initialFailedActionIds: string[] }>): RunBatch {
  return async (input) => {
    batches.push({ initialFailedActionIds: input.initialFailedActionIds ?? [] });
    const result: ProductionRunnerResult = {
      status: 'completed',
      project: input.initialProject,
      iterations: 1,
      completedActionIds: [],
      failedActionIds: [],
      unresolvedActions: [],
      events: []
    };
    return result;
  };
}

interface MutableStoreDep {
  getProject(id: string): Promise<Project | null>;
  updateProject(project: Project): Promise<Project>;
  snapshot(): Project;
}

function mutableStore(initial: Project): MutableStoreDep {
  let current = initial;
  return {
    async getProject(id: string) {
      return id === current.id ? current : null;
    },
    async updateProject(next: Project) {
      current = next;
      return current;
    },
    snapshot() {
      return current;
    }
  };
}

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'run-recovery-'));
}

async function waitForStatus(service: HeadlessProductionRunService, runId: string, allowed: string[], maxAttempts = 80): Promise<string> {
  for (let i = 0; i < maxAttempts; i += 1) {
    const run = service.getRun(runId);
    if (allowed.includes(run.status)) {
      return run.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Run did not reach expected status in time.');
}

describe('reconcileInterruptedGenerations', () => {
  it('leaves a video attempt with a provider job id for polling', () => {
    const scene: Scene = {
      ...imageScene(1, 'generating'),
      visual: {
        kind: 'generated_video',
        generation: generation({ id: 'gen-v', kind: 'video', status: 'generating', providerJobId: 'job-1' })
      }
    };

    const result = reconcileInterruptedGenerations(project('p', [scene]), 'real');

    expect(result.updatedProject).toBeNull();
    expect(result.suppressedActionIds).toEqual([]);
    expect(result.notes.some((note) => note.actionType === 'video_poll')).toBe(true);
  });

  it('leaves a fal video attempt with a composite job id for polling', () => {
    const scene: Scene = {
      ...imageScene(1, 'generating'),
      visual: {
        kind: 'generated_video',
        generation: generation({
          id: 'gen-v',
          kind: 'video',
          status: 'generating',
          provider: 'fal',
          providerJobId: 'fal:minimax/h3-max-turbo/text-to-video:req-123'
        })
      }
    };

    const result = reconcileInterruptedGenerations(project('p', [scene]), 'real');

    expect(result.updatedProject).toBeNull();
    expect(result.suppressedActionIds).toEqual([]);
    expect(result.notes.some((note) => note.actionType === 'video_poll')).toBe(true);
  });

  it('fails an interrupted video submit without a job id and suppresses it in real mode', () => {
    const scene: Scene = {
      ...imageScene(1, 'generating'),
      visual: {
        kind: 'generated_video',
        generation: generation({ id: 'gen-v', kind: 'video', status: 'queued' })
      }
    };

    const result = reconcileInterruptedGenerations(project('p', [scene]), 'real');

    expect(result.updatedProject?.scenes[0].visual).toMatchObject({ generation: { status: 'failed' } });
    expect(result.suppressedActionIds).toEqual(['scene:scene-1:video_submit']);
  });

  it('fails an unconfirmed real video submit even when an older asset exists, and suppresses resubmit', () => {
    const assets = [{ id: 'asset-old', status: 'available' }] as unknown as Project['assets'];
    const scene: Scene = {
      ...imageScene(1, 'queued', 'asset-old'),
      visual: {
        kind: 'generated_video',
        assetId: 'asset-old',
        generation: generation({
          id: 'gen-v',
          kind: 'video',
          status: 'queued',
          providerStatus: 'submit_unresolved',
          metadata: { submitUnresolved: true, idempotencyKey: 'gen-v' }
        })
      }
    };

    const result = reconcileInterruptedGenerations(project('p', [scene], assets), 'real');

    expect(result.updatedProject?.scenes[0].visual).toMatchObject({
      assetId: 'asset-old',
      generation: {
        status: 'failed',
        providerStatus: 'submit_unresolved',
        metadata: { submitUnresolved: true }
      }
    });
    expect(result.suppressedActionIds).toEqual(['scene:scene-1:video_submit']);
  });

  it('treats an unflagged real video submit without a job id as unconfirmed even with an older asset', () => {
    const assets = [{ id: 'asset-old', status: 'available' }] as unknown as Project['assets'];
    const scene: Scene = {
      ...imageScene(1, 'queued', 'asset-old'),
      visual: {
        kind: 'generated_video',
        assetId: 'asset-old',
        generation: generation({
          id: 'gen-v',
          kind: 'video',
          status: 'queued',
          providerStatus: 'queued',
          metadata: { idempotencyKey: 'gen-v' }
        })
      }
    };

    const result = reconcileInterruptedGenerations(project('p', [scene], assets), 'real');

    expect(result.updatedProject?.scenes[0].visual).toMatchObject({
      assetId: 'asset-old',
      generation: {
        status: 'failed',
        providerStatus: 'submit_unresolved',
        errorCode: 'PROVIDER_FAILED'
      }
    });
    expect(result.suppressedActionIds).toEqual(['scene:scene-1:video_submit']);
  });

  it('keeps the mock restore-from-asset behaviour for an unflagged video attempt', () => {
    const assets = [{ id: 'asset-old', status: 'available' }] as unknown as Project['assets'];
    const scene: Scene = {
      ...imageScene(1, 'queued', 'asset-old'),
      visual: {
        kind: 'generated_video',
        assetId: 'asset-old',
        generation: generation({ id: 'gen-v', kind: 'video', status: 'queued' })
      }
    };

    const result = reconcileInterruptedGenerations(project('p', [scene], assets), 'mock');

    expect(result.updatedProject?.scenes[0].visual).toMatchObject({
      assetId: 'asset-old',
      generation: { status: 'generated' }
    });
    expect(result.suppressedActionIds).toEqual([]);
  });

  it('does not suppress interrupted work in mock mode', () => {
    const result = reconcileInterruptedGenerations(project('p', [imageScene(1, 'generating')]), 'mock');

    expect(result.updatedProject?.scenes[0].visual).toMatchObject({ generation: { status: 'failed' } });
    expect(result.suppressedActionIds).toEqual([]);
  });

  it('records a diagnosable reason (error/code) when an interrupted image is marked failed', () => {
    const result = reconcileInterruptedGenerations(project('p', [imageScene(1, 'generating')]), 'real');

    const generation = result.updatedProject?.scenes[0].visual;
    expect(generation).toMatchObject({
      generation: {
        status: 'failed',
        error: 'Interrupted by process restart.',
        errorMessage: 'Interrupted by process restart.',
        errorCode: 'INTERNAL'
      }
    });
  });

  it('restores an interrupted image generation when a usable asset exists', () => {
    const assets = [{ id: 'asset-1', status: 'available' }] as unknown as Project['assets'];
    const scene = imageScene(1, 'generating', 'asset-1');

    const result = reconcileInterruptedGenerations(project('p', [scene], assets), 'real');

    expect(result.updatedProject?.scenes[0].visual).toMatchObject({ generation: { status: 'generated' } });
    expect(result.suppressedActionIds).toEqual([]);
  });

  it('fails an interrupted narration without audio and suppresses it in real mode', () => {
    const scene: Scene = {
      ...imageScene(1, 'generated'),
      narration: { text: 'hello', status: 'generating', lastAttemptId: 'attempt-1' } satisfies NarrationSpec
    };

    const result = reconcileInterruptedGenerations(project('p', [scene]), 'real');

    expect(result.updatedProject?.scenes[0].narration).toMatchObject({ status: 'failed' });
    expect(result.suppressedActionIds).toEqual(['scene:scene-1:narration_generate']);
  });

  it('returns no update when nothing was interrupted', () => {
    const result = reconcileInterruptedGenerations(project('p', [imageScene(1, 'generated')]), 'mock');

    expect(result.updatedProject).toBeNull();
    expect(result.suppressedActionIds).toEqual([]);
  });

  it('fails an interrupted background music generation without a usable asset', () => {
    const base = project('p', [imageScene(1, 'generated')]);
    base.music = {
      status: 'generating',
      lastAttemptId: 'music-attempt-1',
      attempts: [{ id: 'music-attempt-1', status: 'generating', provider: 'fake', createdAt: '2026-01-01T00:00:00.000Z' }]
    };

    const result = reconcileInterruptedGenerations(base, 'real');

    expect(result.updatedProject?.music).toMatchObject({ status: 'failed' });
    expect(result.updatedProject?.music?.attempts?.[0].status).toBe('failed');
    expect(result.suppressedActionIds).toEqual([]);
  });

  it('restores an interrupted background music generation when a usable asset exists', () => {
    const assets = [{ id: 'asset-music-1', status: 'available' }] as unknown as Project['assets'];
    const base = project('p', [imageScene(1, 'generated')], assets);
    base.music = { status: 'generating', assetId: 'asset-music-1', lastAttemptId: 'music-attempt-1' };

    const result = reconcileInterruptedGenerations(base, 'real');

    expect(result.updatedProject?.music).toMatchObject({ status: 'generated' });
  });
});

describe('planner resume behavior', () => {
  it('resumes a stored video job by polling and does not resubmit', () => {
    const scene: Scene = {
      ...imageScene(1, 'generating'),
      visual: {
        kind: 'generated_video',
        generation: generation({ id: 'gen-v', kind: 'video', status: 'generating', providerJobId: 'job-1' })
      }
    };

    const plan = deriveProductionPlan(project('p', [scene]));
    const submit = plan.actions.find((action) => action.type === 'video_submit');
    const poll = plan.actions.find((action) => action.type === 'video_poll');

    expect(submit).toMatchObject({ status: 'running', execute: false });
    expect(poll).toMatchObject({ execute: true, payload: { attemptId: 'gen-v' } });
  });
});

describe('headless run recovery', () => {
  it('persists a run so it can be reloaded after restart', async () => {
    const root = await tempRoot();
    const runStore = new FileRunStore({ projectsRoot: root });
    const store = mutableStore(project('project-r', [imageScene(1, 'planned')]));
    const batches: Array<{ initialFailedActionIds: string[] }> = [];

    const service = new HeadlessProductionRunService(SERVICE_CONFIG, { store, runBatch: makeRunBatch(batches) }, { runStore });
    const started = await service.startOrReuseRun({ projectId: 'project-r' });
    await waitForStatus(service, started.run.runId, ['completed']);
    await service.flushPersists();

    const loaded = await runStore.load('project-r', started.run.runId);
    expect(loaded).not.toBeNull();
    expect(loaded?.status).toBe('completed');
  });

  it('recovers and resumes a non-terminal run after restart', async () => {
    const root = await tempRoot();
    const runStore = new FileRunStore({ projectsRoot: root });
    await runStore.save(createPersistedRun({ runId: 'run-restart' }));

    const store = mutableStore(project('project-r', [imageScene(1, 'planned')]));
    const batches: Array<{ initialFailedActionIds: string[] }> = [];
    const service = new HeadlessProductionRunService(SERVICE_CONFIG, { store, runBatch: makeRunBatch(batches) }, { runStore });

    const recovered = await service.recoverRuns();
    expect(recovered.map((run) => run.runId)).toEqual(['run-restart']);
    expect(['queued', 'running', 'completed']).toContain(recovered[0].status);

    await waitForStatus(service, 'run-restart', ['completed']);
    expect(batches).toHaveLength(1);

    const log = service.getRunLog('run-restart');
    expect(log.items.some((item) => item.event.code === 'run_recovered')).toBe(true);
  });

  it('is idempotent across repeated recovery calls', async () => {
    const root = await tempRoot();
    const runStore = new FileRunStore({ projectsRoot: root });
    await runStore.save(createPersistedRun({ runId: 'run-once' }));

    const store = mutableStore(project('project-r', [imageScene(1, 'planned')]));
    const batches: Array<{ initialFailedActionIds: string[] }> = [];
    const service = new HeadlessProductionRunService(SERVICE_CONFIG, { store, runBatch: makeRunBatch(batches) }, { runStore });

    const first = await service.recoverRuns();
    const second = await service.recoverRuns();

    expect(first.map((run) => run.runId)).toEqual(['run-once']);
    expect(second).toEqual([]);

    await waitForStatus(service, 'run-once', ['completed']);
    expect(batches).toHaveLength(1);
  });

  it('marks duplicate active runs for the same project as superseded', async () => {
    const root = await tempRoot();
    const runStore = new FileRunStore({ projectsRoot: root });
    await runStore.save(createPersistedRun({ runId: 'run-first', createdAt: '2026-01-01T00:00:00.000Z' }));
    await runStore.save(createPersistedRun({ runId: 'run-second', createdAt: '2026-01-02T00:00:00.000Z' }));

    const store = mutableStore(project('project-r', [imageScene(1, 'planned')]));
    const batches: Array<{ initialFailedActionIds: string[] }> = [];
    const service = new HeadlessProductionRunService(SERVICE_CONFIG, { store, runBatch: makeRunBatch(batches) }, { runStore });

    await service.recoverRuns();

    expect(service.getRun('run-second').status).toBe('failed');
    await waitForStatus(service, 'run-first', ['completed']);
  });

  it('suppresses non-resumable real-mode work so it is not auto-retried', async () => {
    const root = await tempRoot();
    const runStore = new FileRunStore({ projectsRoot: root });
    const persisted = createPersistedRun({ runId: 'run-real' });
    persisted.acceptedConfig.policy.mode = 'real';
    await runStore.save(persisted);

    const storeRef = mutableStore(project('project-r', [imageScene(1, 'generating')]));
    const batches: Array<{ initialFailedActionIds: string[] }> = [];
    const service = new HeadlessProductionRunService(SERVICE_CONFIG, { store: storeRef, runBatch: makeRunBatch(batches) }, { runStore });

    await service.recoverRuns();
    await waitForStatus(service, 'run-real', ['completed']);

    expect(storeRef.snapshot().scenes[0].visual).toMatchObject({
      generation: { status: 'failed' }
    });
    expect(batches[0].initialFailedActionIds).toContain('scene:scene-1:image_generate');
  });

  it('forwards persisted completed actions to the recovered batch so forced runs stay idempotent', async () => {
    const root = await tempRoot();
    const runStore = new FileRunStore({ projectsRoot: root });
    const persisted = createPersistedRun({
      runId: 'run-completed',
      completedActionIds: ['scene:scene-1:image_generate', 'scene:scene-1:narration_generate']
    });
    persisted.acceptedConfig.policy.force = true;
    await runStore.save(persisted);

    const store = mutableStore(project('project-r', [imageScene(1, 'generated')]));
    const batches: Array<{ initialFailedActionIds: string[]; initialCompletedActionIds: string[] }> = [];
    const runBatch: RunBatch = async (input) => {
      batches.push({
        initialFailedActionIds: input.initialFailedActionIds ?? [],
        initialCompletedActionIds: input.initialCompletedActionIds ?? []
      });
      return {
        status: 'completed',
        project: input.initialProject,
        iterations: 1,
        completedActionIds: input.initialCompletedActionIds ?? [],
        failedActionIds: [],
        unresolvedActions: [],
        events: []
      };
    };
    const service = new HeadlessProductionRunService(SERVICE_CONFIG, { store, runBatch }, { runStore });

    await service.recoverRuns();
    await waitForStatus(service, 'run-completed', ['completed']);

    expect(batches).toHaveLength(1);
    expect(batches[0].initialCompletedActionIds).toEqual([
      'scene:scene-1:image_generate',
      'scene:scene-1:narration_generate'
    ]);
  });

  it('fails a recovered run whose project no longer exists', async () => {
    const root = await tempRoot();
    const runStore = new FileRunStore({ projectsRoot: root });
    await runStore.save(createPersistedRun({ runId: 'run-ghost', projectId: 'ghost' }));

    const store = mutableStore(project('project-r', [imageScene(1, 'planned')]));
    const batches: Array<{ initialFailedActionIds: string[] }> = [];
    const service = new HeadlessProductionRunService(SERVICE_CONFIG, { store, runBatch: makeRunBatch(batches) }, { runStore });

    const recovered = await service.recoverRuns();

    expect(recovered[0].status).toBe('failed');
    expect(batches).toHaveLength(0);
  });

  it('ignores corrupt run files without throwing', async () => {
    const root = await tempRoot();
    const runStore = new FileRunStore({ projectsRoot: root });
    await runStore.save(createPersistedRun({ runId: 'run-good' }));
    await fs.mkdir(path.join(root, 'project-r', 'runs'), { recursive: true });
    await fs.writeFile(path.join(root, 'project-r', 'runs', 'broken.json'), '{oops', 'utf8');

    const store = mutableStore(project('project-r', [imageScene(1, 'planned')]));
    const batches: Array<{ initialFailedActionIds: string[] }> = [];
    const service = new HeadlessProductionRunService(SERVICE_CONFIG, { store, runBatch: makeRunBatch(batches) }, { runStore });

    const recovered = await service.recoverRuns();

    expect(recovered.map((run) => run.runId)).toEqual(['run-good']);
  });
});

describe('headless run execution lock (cross-process dedupe)', () => {
  function gatedRunBatch(entered: number[], gate: Promise<void>): RunBatch {
    return async (input) => {
      entered.push(Date.now());
      await gate;
      return {
        status: 'completed',
        project: input.initialProject,
        iterations: 1,
        completedActionIds: [],
        failedActionIds: [],
        unresolvedActions: [],
        events: []
      } satisfies ProductionRunnerResult;
    };
  }

  it('does not re-execute a run another instance is already executing', async () => {
    const root = await tempRoot();
    const runStore = new FileRunStore({ projectsRoot: root });
    const store = mutableStore(project('project-r', [imageScene(1, 'planned')]));

    let releaseGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const entered: number[] = [];
    const runBatch = gatedRunBatch(entered, gate);

    const owner = new HeadlessProductionRunService(SERVICE_CONFIG, { store, runBatch }, { runStore, autoRecover: false });
    const started = await owner.startOrReuseRun({ projectId: 'project-r' });
    await waitForStatus(owner, started.run.runId, ['running']);
    await owner.flushPersists();

    // A second service instance (as every Next.js route worker constructs)
    // observes the same non-terminal run. It must not launch a duplicate batch.
    const observer = new HeadlessProductionRunService(SERVICE_CONFIG, { store, runBatch }, { runStore, autoRecover: false });
    await observer.recoverRuns();

    expect(entered).toHaveLength(1);
    expect(observer.getRun(started.run.runId).status).toBe('running');
    expect(await runStore.isExecutionLocked('project-r', started.run.runId)).toBe(true);

    releaseGate!();
    await waitForStatus(owner, started.run.runId, ['completed']);

    expect(entered).toHaveLength(1);
    expect(await runStore.isExecutionLocked('project-r', started.run.runId)).toBe(false);
  });

  it('reclaims a stale lock left by a dead process and resumes the run', async () => {
    const root = await tempRoot();
    const runStore = new FileRunStore({ projectsRoot: root });
    await runStore.save(createPersistedRun({ runId: 'run-stale' }));
    await fs.mkdir(path.join(root, 'project-r', 'runs'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'project-r', 'runs', 'run-stale.lock'),
      JSON.stringify({ pid: 2_147_480_000, startedAt: '2026-01-01T00:00:00.000Z' }),
      'utf8'
    );

    const store = mutableStore(project('project-r', [imageScene(1, 'planned')]));
    const batches: Array<{ initialFailedActionIds: string[] }> = [];
    const service = new HeadlessProductionRunService(SERVICE_CONFIG, { store, runBatch: makeRunBatch(batches) }, { runStore });

    const recovered = await service.recoverRuns();
    expect(recovered.map((run) => run.runId)).toEqual(['run-stale']);

    await waitForStatus(service, 'run-stale', ['completed']);
    expect(batches).toHaveLength(1);
    expect(await runStore.isExecutionLocked('project-r', 'run-stale')).toBe(false);
  });
});

describe('run status read-through across service instances', () => {
  it('reads a persisted run and its log without requiring local discovery', async () => {
    const root = await tempRoot();
    const runStore = new FileRunStore({ projectsRoot: root });
    await runStore.save(
      createPersistedRun({
        runId: 'run-complete',
        status: 'completed',
        finishedAt: new Date().toISOString(),
        summary: { completed: 1, failed: 0, running: 0, waiting: 0 },
        completedActionIds: ['scene:scene-1:image_generate'],
        events: [
          {
            timestamp: new Date().toISOString(),
            iteration: 1,
            code: 'run_completed',
            status: 'completed',
            message: 'Production run completed.'
          }
        ]
      })
    );

    const observer = new HeadlessProductionRunService(
      SERVICE_CONFIG,
      { store: mutableStore(project('project-r', [imageScene(1, 'generated')])) },
      { runStore, autoRecover: false }
    );

    const run = await observer.getRunForRead('run-complete');
    expect(run.status).toBe('completed');
    expect(run.summary.completed).toBe(1);

    const log = await observer.getRunLogForRead('run-complete', { limit: 10 });
    expect(log.items.map((item) => item.event.code)).toEqual(['run_completed']);
  });

  it('recovers a non-terminal persisted run on status read and does not execute it twice', async () => {
    const root = await tempRoot();
    const runStore = new FileRunStore({ projectsRoot: root });
    await runStore.save(createPersistedRun({ runId: 'run-resume' }));

    const batches: Array<{ initialFailedActionIds: string[] }> = [];
    const observer = new HeadlessProductionRunService(
      SERVICE_CONFIG,
      { store: mutableStore(project('project-r', [imageScene(1, 'planned')])), runBatch: makeRunBatch(batches) },
      { runStore, autoRecover: false }
    );

    const first = await observer.getRunForRead('run-resume');
    expect(['queued', 'running']).toContain(first.status);

    await waitForStatus(observer, 'run-resume', ['completed']);
    expect(batches).toHaveLength(1);

    const second = await observer.getRunForRead('run-resume');
    expect(second.status).toBe('completed');
    expect(batches).toHaveLength(1);
  });

  it('serves an active run owned by another live instance without NOT_FOUND or duplicate work', async () => {
    const root = await tempRoot();
    const runStore = new FileRunStore({ projectsRoot: root });
    const store = mutableStore(project('project-r', [imageScene(1, 'planned')]));

    let releaseGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const entered: number[] = [];
    const runBatch = async (input: Parameters<RunBatch>[0]) => {
      entered.push(Date.now());
      await gate;
      return {
        status: 'completed',
        project: input.initialProject,
        iterations: 1,
        completedActionIds: [],
        failedActionIds: [],
        unresolvedActions: [],
        events: []
      } satisfies ProductionRunnerResult;
    };

    const owner = new HeadlessProductionRunService(SERVICE_CONFIG, { store, runBatch }, { runStore, autoRecover: false });
    const started = await owner.startOrReuseRun({ projectId: 'project-r' });
    await waitForStatus(owner, started.run.runId, ['running']);
    await owner.flushPersists();

    // A status route in another worker never saw the run locally. The durable
    // copy must make it readable, while the live execution lock prevents this
    // instance from starting a second batch.
    const observer = new HeadlessProductionRunService(SERVICE_CONFIG, { store, runBatch }, { runStore, autoRecover: false });
    const observed = await observer.getRunForRead(started.run.runId);
    expect(observed.status).toBe('running');
    expect(entered).toHaveLength(1);

    releaseGate!();
    await waitForStatus(owner, started.run.runId, ['completed']);
    expect(entered).toHaveLength(1);
  });
});
