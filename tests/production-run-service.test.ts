import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { HeadlessProductionRunService } from '@/lib/production/run-service';
import { runFfmpeg } from '@/lib/render/ffmpeg-executor';
import { getFfmpegLimiterStats as getFfmpegStats, resetFfmpegLimiterForTests } from '@/lib/render/ffmpeg-limiter';
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
            stock_select: 1,
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

  it('executes stock, html, presenter, and compose actions through the server runner', async () => {
    const project = createProject('project-actions');
    const executed: string[] = [];
    const stockModes: Array<string | undefined> = [];
    const presenterProviders: Array<string | undefined> = [];

    const service = new HeadlessProductionRunService(
      {
        maxConcurrentRuns: 1,
        runner: {
          maxIterations: 5,
          maxActionExecutions: 10,
          maxVideoPolls: 5,
          limits: {
            image_generate: 1,
            stock_select: 1,
            html_render: 1,
            video_submit: 1,
            video_poll: 1,
            narration_generate: 1,
            presenter_submit: 1,
            presenter_poll: 1,
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
        selectStockImage: async (_projectId, sceneId, options) => {
          executed.push('stock_select');
          stockModes.push(options?.mode);
          return {
            sceneId,
            status: 'selected',
            provider: 'fake',
            photoId: 'photo-1',
            usagePolicy: 'download',
            cached: false,
            attribution: {
              provider: 'fake',
              providerName: 'Fake',
              photoId: 'photo-1',
              photographerName: 'Test',
              sourceUrl: 'https://example.test/photo-1',
              license: 'test'
            }
          };
        },
        renderHtmlStill: async (_projectId, sceneId) => {
          executed.push('html_render');
          return {
            sceneId,
            assetId: 'html-1',
            localPath: '/tmp/html-1.png',
            fingerprint: 'fp',
            width: 1920,
            height: 1080,
            reused: false
          };
        },
        submitPresenter: async (_projectId, sceneId, options) => {
          executed.push('presenter_submit');
          presenterProviders.push(options?.provider);
          return {
            sceneId,
            status: 'accepted',
            provider: 'mock',
            generationAttemptId: 'presenter-1',
            providerStatus: 'queued'
          };
        },
        pollPresenter: async (_projectId, sceneId) => {
          executed.push('presenter_poll');
          return {
            sceneId,
            status: 'generated',
            provider: 'mock',
            generationAttemptId: 'presenter-1',
            providerStatus: 'completed',
            assetId: 'presenter-asset'
          };
        },
        composeProject: async () => {
          executed.push('final_compose');
          return {
            plan: {
              projectId: project.id,
              items: [],
              width: 1920,
              height: 1080,
              fps: 30,
              totalDuration: 3,
              transition: { type: 'none' }
            },
            artifact: {
              compositionId: 'comp-1',
              projectId: project.id,
              outputPath: '/tmp/out.mp4',
              createdAt: project.createdAt,
              sceneIds: ['scene-1'],
              duration: 3,
              width: 1920,
              height: 1080,
              fps: 30,
              renderer: 'ffmpeg',
              version: '1',
              filesize: 1,
              mimeType: 'video/mp4',
              transition: { type: 'none' }
            }
          };
        },
        runBatch: async (input) => {
          await input.executeAction({
            id: 'scene:scene-1:stock_select',
            type: 'stock_select',
            sceneId: 'scene-1',
            sceneOrder: 1,
            status: 'ready',
            execute: true,
            dependencyActionIds: [],
            payload: { regenerate: false }
          });
          await input.executeAction({
            id: 'scene:scene-1:html_render',
            type: 'html_render',
            sceneId: 'scene-1',
            sceneOrder: 1,
            status: 'ready',
            execute: true,
            dependencyActionIds: [],
            payload: { regenerate: false }
          });
          await input.executeAction({
            id: 'scene:scene-1:presenter_submit',
            type: 'presenter_submit',
            sceneId: 'scene-1',
            sceneOrder: 1,
            status: 'ready',
            execute: true,
            dependencyActionIds: [],
            payload: { regenerate: false }
          });
          await input.executeAction({
            id: 'scene:scene-1:presenter_poll',
            type: 'presenter_poll',
            sceneId: 'scene-1',
            sceneOrder: 1,
            status: 'ready',
            execute: true,
            dependencyActionIds: []
          });
          await input.executeAction({
            id: 'project:final_compose',
            type: 'final_compose',
            status: 'ready',
            execute: true,
            dependencyActionIds: []
          });

          return {
            status: 'completed',
            project: input.initialProject,
            iterations: 1,
            completedActionIds: [
              'scene:scene-1:stock_select',
              'scene:scene-1:html_render',
              'scene:scene-1:presenter_submit',
              'scene:scene-1:presenter_poll',
              'project:final_compose'
            ],
            failedActionIds: [],
            unresolvedActions: [],
            events: []
          };
        }
      }
    );

    const started = await service.startOrReuseRun({ projectId: project.id });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(executed).toEqual(['stock_select', 'html_render', 'presenter_submit', 'presenter_poll', 'final_compose']);
    expect(stockModes).toEqual(['mock']);
    expect(presenterProviders).toEqual(['mock']);
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
            stock_select: 1,
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

  it('clamps requested scene_render and final_compose to the server FFmpeg limit', async () => {
    const project = createProject('project-clamp');
    const original = process.env.FFMPEG_MAX_CONCURRENCY;
    process.env.FFMPEG_MAX_CONCURRENCY = '1';
    let resolveRun: (() => void) | undefined;

    try {
      const service = new HeadlessProductionRunService(
        {
          maxConcurrentRuns: 1,
          runner: {
            maxIterations: 5,
            maxActionExecutions: 5,
            maxVideoPolls: 5,
            limits: {
              image_generate: 1,
              stock_select: 1,
              video_submit: 1,
              video_poll: 1,
              narration_generate: 1,
              scene_render: 4,
              final_compose: 2
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

      const started = await service.startOrReuseRun({
        projectId: project.id,
        limits: { scene_render: 8, final_compose: 8 }
      });

      expect(started.run.acceptedConfig.limits.perActionConcurrency.scene_render).toBe(1);
      expect(started.run.acceptedConfig.limits.perActionConcurrency.final_compose).toBe(1);

      for (let attempt = 0; attempt < 100 && !resolveRun; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      resolveRun?.();
      await waitForStatus(service, started.run.runId, ['completed', 'failed']);
    } finally {
      if (original === undefined) {
        delete process.env.FFMPEG_MAX_CONCURRENCY;
      } else {
        process.env.FFMPEG_MAX_CONCURRENCY = original;
      }
    }
  });

  it('shares one FFmpeg slot across two concurrent runs', async () => {
    const original = process.env.FFMPEG_MAX_CONCURRENCY;
    process.env.FFMPEG_MAX_CONCURRENCY = '1';
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'run-ffmpeg-limit-'));
    const probeScript = `
const fs = require('node:fs');
const [id, lockPath, logPath, sleepRaw] = process.argv.slice(1);
const sleepMs = Number(sleepRaw);
try {
  fs.writeFileSync(lockPath, id, { flag: 'wx' });
} catch {
  fs.appendFileSync(logPath + '.violations', 'overlap\n');
}
fs.appendFileSync(logPath, 'start ' + id + '\n');
setTimeout(() => {
  fs.appendFileSync(logPath, 'end ' + id + '\n');
  try { fs.unlinkSync(lockPath); } catch {}
}, sleepMs);
`;
    const projectA = createProject('project-a');
    const projectB = createProject('project-b');

    try {
      const service = new HeadlessProductionRunService(
        {
          maxConcurrentRuns: 2,
          runner: {
            maxIterations: 5,
            maxActionExecutions: 5,
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
            const id = input.initialProject.id;
            await runFfmpeg(
              process.execPath,
              ['-e', probeScript, id, path.join(tempRoot, `lock-${id}`), path.join(tempRoot, 'events.log'), '120'],
              {},
              id === projectA.id ? 'scene_render' : 'final_compose'
            );
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

      const [first, second] = await Promise.all([
        service.startOrReuseRun({ projectId: projectA.id }),
        service.startOrReuseRun({ projectId: projectB.id })
      ]);
      await Promise.all([
        waitForStatus(service, first.run.runId, ['completed', 'failed'], 400),
        waitForStatus(service, second.run.runId, ['completed', 'failed'], 400)
      ]);

      const violations = await fs.readFile(path.join(tempRoot, 'events.log.violations'), 'utf8').catch(() => '');
      expect(violations).toBe('');
      expect(getFfmpegStats()).toMatchObject({ limit: 1, active: 0, queued: 0 });
    } finally {
      resetFfmpegLimiterForTests();
      if (original === undefined) {
        delete process.env.FFMPEG_MAX_CONCURRENCY;
      } else {
        process.env.FFMPEG_MAX_CONCURRENCY = original;
      }
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
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
            stock_select: 1,
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

  it('injects the requested force flag into the production plan', async () => {
    const project = createProject('project-force');
    project.assets = [{ id: 'asset-1', type: 'image', status: 'available' }] as unknown as Project['assets'];
    project.scenes[0].visual = {
      kind: 'generated_image',
      assetId: 'asset-1',
      generation: {
        id: 'gen-1',
        kind: 'image',
        status: 'generated',
        provider: 'local',
        prompt: 'A scene prompt',
        referenceIds: [],
        aspectRatio: '16:9',
        assetId: 'asset-1',
        createdAt: project.createdAt
      }
    };

    let forcedStatus: string | undefined;

    const service = new HeadlessProductionRunService(
      {
        maxConcurrentRuns: 1,
        runner: {
          maxIterations: 5,
          maxActionExecutions: 5,
          maxVideoPolls: 5,
          limits: { image_generate: 1, stock_select: 1, video_submit: 1, video_poll: 1, narration_generate: 1, scene_render: 1, final_compose: 1 }
        },
        registry: { maxEventsPerRun: 100, retentionMs: 60_000, maxLogPageLimit: 100 },
        policy: { allowRealProviders: true, defaultMode: 'mock' }
      },
      {
        store: {
          async getProject(projectId: string) {
            return projectId === project.id ? project : null;
          }
        },
        runBatch: async (input) => {
          const forcedPlan = input.derivePlan(project, {});
          forcedStatus = forcedPlan.actions.find((action) => action.id === 'scene:scene-1:image_generate')?.status;
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

    const started = await service.startOrReuseRun({ projectId: project.id, policy: { mode: 'mock', force: true } });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    // Without the injected force flag the action would be `current`.
    expect(forcedStatus).toBe('ready');
  });

  it('enforces the per-run maxVideoPolls limit', async () => {
    const project = createProject('project-poll-limit');
    const codes: Array<string | undefined> = [];
    let pollCalls = 0;

    const service = new HeadlessProductionRunService(
      {
        maxConcurrentRuns: 1,
        runner: {
          maxIterations: 5,
          maxActionExecutions: 100,
          maxVideoPolls: 2,
          limits: { image_generate: 1, stock_select: 1, video_submit: 1, video_poll: 1, narration_generate: 1, scene_render: 1, final_compose: 1 }
        },
        registry: { maxEventsPerRun: 100, retentionMs: 60_000, maxLogPageLimit: 100 },
        policy: { allowRealProviders: false, defaultMode: 'mock' }
      },
      {
        store: {
          async getProject(projectId: string) {
            return projectId === project.id ? project : null;
          }
        },
        pollVideo: async () => {
          pollCalls += 1;
          return {
            sceneId: 'scene-1',
            generationAttemptId: 'attempt-1',
            provider: 'fake',
            providerJobId: 'job-1',
            status: 'generating',
            providerStatus: 'in_progress'
          };
        },
        runBatch: async (input) => {
          for (let i = 0; i < 4; i += 1) {
            try {
              await input.executeAction({
                id: 'scene:scene-1:video_poll',
                type: 'video_poll',
                sceneId: 'scene-1',
                sceneOrder: 1,
                status: 'ready',
                execute: true,
                dependencyActionIds: [],
                payload: { attemptId: 'attempt-1' }
              });
            } catch (error) {
              codes.push((error as { diagnostics?: { code?: string } }).diagnostics?.code);
            }
          }

          return {
            status: 'failed',
            project: input.initialProject,
            iterations: 1,
            completedActionIds: [],
            failedActionIds: ['scene:scene-1:video_poll'],
            unresolvedActions: [],
            events: []
          };
        }
      }
    );

    const started = await service.startOrReuseRun({ projectId: project.id });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(pollCalls).toBe(2);
    expect(codes).toEqual(['VIDEO_POLL_LIMIT_REACHED', 'VIDEO_POLL_LIMIT_REACHED']);
  });

  it('enforces the per-run maxActionExecutions limit', async () => {
    const project = createProject('project-action-limit');
    const codes: Array<string | undefined> = [];
    let executions = 0;

    const service = new HeadlessProductionRunService(
      {
        maxConcurrentRuns: 1,
        runner: {
          maxIterations: 5,
          maxActionExecutions: 2,
          maxVideoPolls: 100,
          limits: { image_generate: 1, stock_select: 1, video_submit: 1, video_poll: 1, narration_generate: 1, scene_render: 1, final_compose: 1 }
        },
        registry: { maxEventsPerRun: 100, retentionMs: 60_000, maxLogPageLimit: 100 },
        policy: { allowRealProviders: false, defaultMode: 'mock' }
      },
      {
        store: {
          async getProject(projectId: string) {
            return projectId === project.id ? project : null;
          }
        },
        generateImage: async () => {
          executions += 1;
          return {
            sceneId: 'scene-1',
            status: 'generated',
            generationAttemptId: 'attempt-1',
            provider: 'fake',
            assetId: 'asset-1'
          };
        },
        runBatch: async (input) => {
          for (let i = 0; i < 4; i += 1) {
            try {
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
            } catch (error) {
              codes.push((error as { diagnostics?: { code?: string } }).diagnostics?.code);
            }
          }

          return {
            status: 'failed',
            project: input.initialProject,
            iterations: 1,
            completedActionIds: [],
            failedActionIds: ['scene:scene-1:image_generate'],
            unresolvedActions: [],
            events: []
          };
        }
      }
    );

    const started = await service.startOrReuseRun({ projectId: project.id });
    await waitForStatus(service, started.run.runId, ['completed', 'failed']);

    expect(executions).toBe(2);
    expect(codes).toEqual(['ACTION_LIMIT_REACHED', 'ACTION_LIMIT_REACHED']);
  });

  it('returns NOT_FOUND when run state is missing (restart/expiry)', () => {
    const service = new HeadlessProductionRunService();

    expect(() => service.getRun('missing-run')).toThrow(/lost after a process restart/i);
  });
});
