import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectMusicGenerationError } from '@/lib/generation/music-service';
import { HeadlessProductionRunService } from '@/lib/production/run-service';
import { resolveManualGenerationProvider } from '@/lib/production/run-policy';
import type { ProductionActionType, ProductionPlannedAction } from '@/lib/production/production-planner';
import type { ProductionActionExecutionOutcome } from '@/lib/production/production-runner';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';

function nowIso(): string {
  return new Date().toISOString();
}

function musicAsset(id: string): Asset {
  return {
    id,
    type: 'music',
    status: 'available',
    provenance: 'generated',
    filename: `${id}.wav`,
    localPath: `assets/${id}.wav`,
    mimeType: 'audio/wav',
    duration: 30,
    metadata: {},
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function createProject(id: string, overrides: Partial<Project> = {}): Project {
  const now = nowIso();
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
    },
    ...overrides
  };
}

function scenesWithDurations(...durations: number[]) {
  const template = createProject('scene-template').scenes[0];
  return durations.map((duration, index) => ({
    ...template,
    id: `scene-${index + 1}`,
    order: index + 1,
    duration
  }));
}

const FINAL_COMPOSE_ACTION: ProductionPlannedAction = {
  id: 'project:final_compose',
  type: 'final_compose',
  status: 'ready',
  dependencyActionIds: [],
  execute: true,
  payload: {}
};

interface Harness {
  service: HeadlessProductionRunService;
  outcomes: Array<ProductionActionExecutionOutcome | undefined>;
  generateMusic: ReturnType<typeof vi.fn>;
  selectMusic: ReturnType<typeof vi.fn>;
  composeProject: ReturnType<typeof vi.fn>;
}

function makeService(
  project: Project,
  options: {
    serverConfig?: { allowRealProviders: boolean; defaultMode: 'mock' | 'real' };
    generateMusic?: (projectId: string, opts?: Record<string, unknown>) => Promise<unknown>;
    selectMusic?: (projectId: string, assetId: string) => Promise<unknown>;
    executeFinalComposeTimes?: number;
  } = {}
): Harness {
  const outcomes: Array<ProductionActionExecutionOutcome | undefined> = [];
  const generateMusic = vi.fn(
    options.generateMusic ??
      (async () => ({
        status: 'generated',
        assetId: 'asset-generated',
        generationAttemptId: 'attempt-music',
        provider: 'fake',
        musicLengthMs: 60000,
        instrumental: true
      }))
  );
  const selectMusic = vi.fn(options.selectMusic ?? (async () => ({ status: 'generated', assetId: 'asset-selected' })));
  const composeProject = vi.fn(async () => ({ artifact: { compositionId: 'composition-1' } }));

  const limits: Record<ProductionActionType, number> = {
    image_generate: 1,
    stock_select: 1,
    video_submit: 1,
    video_poll: 1,
    narration_generate: 1,
    scene_render: 1,
    final_compose: 1
  };

  const service = new HeadlessProductionRunService(
    {
      maxConcurrentRuns: 1,
      runner: { maxIterations: 5, maxActionExecutions: 10, maxVideoPolls: 5, limits },
      registry: { maxEventsPerRun: 200, retentionMs: 60_000, maxLogPageLimit: 200 },
      policy: options.serverConfig ?? { allowRealProviders: true, defaultMode: 'mock' }
    },
    {
      store: {
        async getProject(projectId: string) {
          return projectId === project.id ? project : null;
        }
      },
      runBatch: async (input) => {
        const times = options.executeFinalComposeTimes ?? 1;
        for (let i = 0; i < times; i += 1) {
          const result = await input.executeAction(FINAL_COMPOSE_ACTION);
          outcomes.push(result ?? undefined);
        }
        return {
          status: 'completed',
          project: input.initialProject,
          iterations: 1,
          completedActionIds: [FINAL_COMPOSE_ACTION.id],
          failedActionIds: [],
          unresolvedActions: [],
          events: []
        };
      },
      generateMusic: generateMusic as never,
      selectMusic: selectMusic as never,
      composeProject: composeProject as never
    }
  );

  return { service, outcomes, generateMusic, selectMusic, composeProject };
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('run music opt-in', () => {
  it('never invokes music providers when the opt-in is absent', async () => {
    const project = createProject('project-no-music');
    const { service, outcomes, generateMusic, selectMusic } = makeService(project);

    const started = await service.startOrReuseRun({ projectId: project.id });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(generateMusic).not.toHaveBeenCalled();
    expect(selectMusic).not.toHaveBeenCalled();
    expect(outcomes[0]?.message).toBe('Final composition completed.');
  });

  it('reuses an existing usable music asset without a generation request', async () => {
    const project = createProject('project-existing-music', {
      assets: [musicAsset('asset-existing')],
      music: { assetId: 'asset-existing', status: 'generated', provider: 'fake' }
    });
    const { service, generateMusic, selectMusic } = makeService(project);

    const started = await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'mock', music: { generate: true, prompt: 'calm piano' } }
    });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(generateMusic).not.toHaveBeenCalled();
    expect(selectMusic).not.toHaveBeenCalled();
  });

  it('generates only after an explicit opt-in, using the mock provider', async () => {
    const project = createProject('project-generate');
    const { service, outcomes, generateMusic } = makeService(project);

    const started = await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'mock', music: { generate: true, prompt: 'calm piano' } }
    });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(generateMusic).toHaveBeenCalledTimes(1);
    expect(generateMusic.mock.calls[0][1]).toMatchObject({
      prompt: 'calm piano',
      provider: 'fake',
      mode: 'mock'
    });
    expect(outcomes[0]?.message).toContain('Background music generated.');
  });

  it('derives the generation length from the resolved timeline', async () => {
    const project = createProject('project-timeline', { scenes: scenesWithDurations(4, 6) });
    const { service, generateMusic } = makeService(project);

    const started = await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'mock', music: { generate: true, prompt: 'calm piano' } }
    });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(generateMusic.mock.calls[0][1]).toMatchObject({ musicLengthMs: 10_000 });
  });

  it('lets an explicit run-plan length win over the timeline', async () => {
    const project = createProject('project-explicit-length', { scenes: scenesWithDurations(10) });
    const { service, generateMusic } = makeService(project);

    const started = await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'mock', music: { generate: true, prompt: 'calm', musicLengthMs: 45_000 } }
    });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(generateMusic.mock.calls[0][1]).toMatchObject({ musicLengthMs: 45_000 });
  });

  it('clamps a timeline above the provider maximum', async () => {
    const project = createProject('project-long-timeline', { scenes: scenesWithDurations(600, 600) });
    const { service, generateMusic } = makeService(project);

    const started = await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'mock', music: { generate: true, prompt: 'calm' } }
    });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(generateMusic.mock.calls[0][1]).toMatchObject({ musicLengthMs: 600_000 });
  });

  it('selects an existing asset when requested instead of generating', async () => {
    const project = createProject('project-select', { assets: [musicAsset('asset-selectable')] });
    const { service, generateMusic, selectMusic } = makeService(project);

    const started = await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'mock', music: { selectAssetId: 'asset-selectable' } }
    });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(selectMusic).toHaveBeenCalledTimes(1);
    expect(selectMusic).toHaveBeenCalledWith(project.id, 'asset-selectable');
    expect(generateMusic).not.toHaveBeenCalled();
  });

  it('never reaches a real provider in mock mode and stays fail-soft', async () => {
    const project = createProject('project-mock-real-provider');
    const generateMusic = vi.fn(async (_projectId: string, opts?: Record<string, unknown>) => {
      // Mirrors music-service: provider policy is resolved before any call.
      const resolved = resolveManualGenerationProvider('music', opts?.provider as string | undefined, {
        mode: opts?.mode as 'mock' | 'real'
      });
      if (resolved.provider !== 'fake') {
        throw new Error('a real music provider was reached in mock mode');
      }
      return { status: 'generated', assetId: 'asset-unexpected', generationAttemptId: 'a', provider: 'fake' };
    });

    const { service, outcomes } = makeService(project, { generateMusic });

    const started = await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'mock', providers: { music: 'elevenlabs' }, music: { generate: true, prompt: 'calm' } }
    });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(outcomes[0]?.message).toContain('Background music skipped');
  });

  it('skips music fail-soft when real credentials are missing', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '');
    const project = createProject('project-real-missing-key');
    const generateMusic = vi.fn(async (_projectId: string, opts?: Record<string, unknown>) => {
      const resolved = resolveManualGenerationProvider('music', opts?.provider as string | undefined, {
        mode: opts?.mode as 'mock' | 'real',
        serverConfig: { allowRealProviders: true, defaultMode: 'real' }
      });
      return { status: 'generated', assetId: 'asset-unexpected', generationAttemptId: 'a', provider: resolved.provider };
    });

    const { service, outcomes } = makeService(project, {
      serverConfig: { allowRealProviders: true, defaultMode: 'real' },
      generateMusic
    });

    const started = await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'real', music: { generate: true, prompt: 'calm' } }
    });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(outcomes[0]?.message).toContain('Background music skipped');
  });

  it('is fail-soft when optional music generation throws', async () => {
    const project = createProject('project-fail-soft');
    const generateMusic = vi.fn(async () => {
      throw new ProjectMusicGenerationError('Provider exploded.', 502, 'music.provider.failed');
    });

    const { service, outcomes, composeProject } = makeService(project, { generateMusic });

    const started = await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'mock', music: { generate: true, prompt: 'calm' } }
    });
    const status = await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(status).toBe('completed');
    expect(composeProject).toHaveBeenCalledTimes(1);
    expect(outcomes[0]?.message).toContain('Background music skipped');
    expect(outcomes[0]?.message).toContain('Provider exploded.');
  });

  it('does not duplicate generation when final_compose runs twice', async () => {
    const project = createProject('project-idempotent');
    const generateMusic = vi.fn(async (_projectId: string) => {
      project.assets = [...project.assets, musicAsset('asset-generated')];
      project.music = { assetId: 'asset-generated', status: 'generated', provider: 'fake' };
      return { status: 'generated', assetId: 'asset-generated', generationAttemptId: 'a', provider: 'fake' };
    });

    const { service, outcomes } = makeService(project, { generateMusic, executeFinalComposeTimes: 2 });

    const started = await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'mock', music: { generate: true, prompt: 'calm' } }
    });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(generateMusic).toHaveBeenCalledTimes(1);
    expect(outcomes[0]?.message).toContain('Background music generated.');
    expect(outcomes[1]?.message).toBe('Final composition completed.');
  });
});
