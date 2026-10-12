import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';
import { runProcess } from '@/lib/render/ffmpeg-executor';
import { parseDurationSeconds, probeMedia } from '@/lib/render/ffprobe';
import { resolveTextOverlay } from '@/lib/render/overlay-resolve';
import { runProductionBatch } from '@/lib/production/production-runner';
import { HeadlessProductionRunService, type RunServiceConfig } from '@/lib/production/run-service';
import { projectStore } from '@/lib/storage/project-store';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import type { Project } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';

const WIDTH = 640;
const HEIGHT = 360;
const FPS = 30;
const RENDER_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 120_000;

// This is a true end-to-end integration test: it drives the real production
// service with the *real* executors (generateSceneImage -> sceneRenderService ->
// videoCompositionService) through the real `runProductionBatch`. It never mocks
// the batch, the compositor or any provider adapter; the mock `fake` providers
// are the ordinary, default mock-mode implementations and require no network.
// Everything runs against local FFmpeg and a temporary on-disk project.

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await runProcess('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

function buildRunConfig(): RunServiceConfig {
  return {
    maxConcurrentRuns: 1,
    runner: {
      maxIterations: 24,
      maxActionExecutions: 500,
      maxVideoPolls: 120,
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
      maxEventsPerRun: 4000,
      retentionMs: 60_000,
      maxLogPageLimit: 250
    },
    // Explicitly pin mock mode so the run can never reach a real provider even
    // if the ambient environment happens to carry credentials.
    policy: {
      allowRealProviders: false,
      defaultMode: 'mock'
    }
  };
}

function generatedImageScene(base: Scene, overrides: Partial<Scene>, generationPrompt: string): Scene {
  const generation = base.visual && base.visual.kind === 'generated_image'
    ? base.visual.generation
    : undefined;
  if (!generation) {
    throw new Error('Expected the default project template to seed a generated_image scene.');
  }

  return {
    ...base,
    ...overrides,
    type: 'image',
    visual: {
      kind: 'generated_image',
      generation: {
        ...generation,
        status: 'planned',
        prompt: generationPrompt
      }
    },
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    referenceIds: [],
    notes: ''
  };
}

async function waitForTerminal(
  service: HeadlessProductionRunService,
  runId: string,
  timeoutMs = RUN_TIMEOUT_MS
): Promise<ReturnType<HeadlessProductionRunService['getRun']>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = service.getRun(runId);
    if (run.status !== 'queued' && run.status !== 'running') {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`Production run ${runId} did not reach a terminal status within ${timeoutMs} ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function decodeWithoutErrors(ffmpegPath: string, filePath: string): Promise<void> {
  await runProcess(ffmpegPath, ['-v', 'error', '-i', filePath, '-f', 'null', '-'], { timeoutMs: RENDER_TIMEOUT_MS });
}

async function extractFrame(ffmpegPath: string, videoPath: string, atSeconds: number, outputPath: string): Promise<void> {
  await runProcess(
    ffmpegPath,
    ['-y', '-ss', String(atSeconds), '-i', videoPath, '-frames:v', '1', outputPath],
    { timeoutMs: RENDER_TIMEOUT_MS }
  );
}

// Coarse, non-fragile "content was drawn" check. A generated `fake` image is a
// single solid color, so a frame rendered without the overlay is (near) uniform.
// The overlay burns in high-contrast text, so a meaningful luminance spread in
// the frame can only come from the overlay actually being rendered.
async function frameLuminanceSpread(framePath: string): Promise<number> {
  const { data, info } = await sharp(framePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  let min = 255;
  let max = 0;

  for (let i = 0; i < data.length; i += channels) {
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (luminance < min) min = luminance;
    if (luminance > max) max = luminance;
  }

  return max - min;
}

describe('production run end-to-end (integration)', () => {
  const createdProjectIds: string[] = [];

  afterEach(async () => {
    for (const id of createdProjectIds.splice(0).values()) {
      await fs.rm(getProjectRoot(id), { recursive: true, force: true });
    }
  });

  it('renders a generated-image project with overlays and narration into a valid composed MP4', async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }

    const runtime = createFFmpegRuntime();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'production-run-e2e-'));

    try {
      const created = await projectStore.createProject({ title: 'P32 E2E production run', durationTarget: 8, fps: FPS });
      createdProjectIds.push(created.id);
      const templateScene = created.scenes[0];

      const sceneOne = generatedImageScene(
        templateScene,
        {
          id: 'scene-e2e-1',
          order: 1,
          duration: 3,
          narration: { text: 'First beat of the explainer.' },
          overlay: {
            type: 'title',
            text: 'E2E OVERLAY ONE',
            position: 'top',
            style: { fontSize: 56, color: '#f8fafc', box: false, margin: 32 },
            timing: { fadeInSeconds: 0.2, fadeOutSeconds: 0.2 }
          }
        },
        'Deterministic background for the first end-to-end scene.'
      );

      const sceneTwo = generatedImageScene(
        templateScene,
        {
          id: 'scene-e2e-2',
          order: 2,
          duration: 3,
          narration: { text: 'Second beat of the explainer.' },
          overlay: {
            type: 'subtitle',
            text: 'E2E OVERLAY TWO',
            position: 'bottom',
            style: { fontSize: 48, color: '#fde68a', box: false, margin: 28 },
            timing: { fadeInSeconds: 0.2 }
          }
        },
        'Deterministic background for the second end-to-end scene.'
      );

      const project: Project = {
        ...created,
        aspectRatio: '16:9',
        fps: FPS,
        scenes: [sceneOne, sceneTwo],
        assets: [],
        references: [],
        compositions: [],
        renderSettings: {
          ...created.renderSettings,
          aspectRatio: '16:9',
          fps: FPS,
          width: WIDTH,
          height: HEIGHT
        }
      };
      await projectStore.updateProject(project);

      // Wrap the real batch runner only to observe that it was actually invoked;
      // it is the genuine production runner, not a stand-in.
      let batchInvocations = 0;
      const service = new HeadlessProductionRunService(buildRunConfig(), {
        runBatch: async (input) => {
          batchInvocations += 1;
          return runProductionBatch(input);
        }
      });

      const { run } = await service.startOrReuseRun({ projectId: created.id });
      const final = await waitForTerminal(service, run.runId);

      // 1. Run reached a correct terminal status with no failed actions.
      expect(batchInvocations).toBeGreaterThanOrEqual(1);
      expect(final.status).toBe('completed');
      expect(final.failedActionIds).toEqual([]);
      expect(final.summary.failed).toBe(0);
      expect(final.summary.completed).toBeGreaterThanOrEqual(5);

      // 2. No hidden executor errors were swallowed (unresolved/failed events).
      const log = service.getRunLog(run.runId, { limit: 250 });
      const failureEvents = log.items
        .map((item) => item.event)
        .filter((event) => event.code === 'action_failed' || event.code === 'run_failed' || event.code === 'composition_failed');
      expect(failureEvents).toEqual([]);

      // 3. The persisted project carries the executor artifacts: generated
      //    images, generated narration audio, completed scene renders and a
      //    composition.
      const persisted = await projectStore.getProject(created.id);
      expect(persisted).not.toBeNull();
      const persistedProject = persisted as Project;

      const imageAssets = persistedProject.assets.filter((asset) => asset.type === 'image');
      const audioAssets = persistedProject.assets.filter((asset) => asset.type === 'audio');
      expect(imageAssets.length).toBeGreaterThanOrEqual(2);
      expect(audioAssets.length).toBeGreaterThanOrEqual(2);

      for (const scene of persistedProject.scenes) {
        expect(scene.visual?.kind).toBe('generated_image');
        expect(scene.narration?.status).toBe('generated');
        expect(scene.narration?.audioAssetId).toBeTruthy();

        const completedRenders = (scene.renders ?? []).filter((render) => render.status === 'completed');
        expect(completedRenders.length).toBeGreaterThanOrEqual(1);

        const render = completedRenders[completedRenders.length - 1];
        const renderPath = path.join(getProjectRoot(created.id), render.outputPath);
        const renderStat = await fs.stat(renderPath);
        expect(renderStat.size).toBeGreaterThan(0);

        // Overlay is authored and resolvable, and it is genuinely burned into
        // the rendered scene: a solid-color background frame would be uniform
        // without the overlay.
        const overlay = resolveTextOverlay(scene.overlay, { width: WIDTH, height: HEIGHT, duration: scene.duration });
        expect(overlay).not.toBeNull();

        const framePath = path.join(tempRoot, `frame-${scene.id}.png`);
        await extractFrame(runtime.ffmpegPath, renderPath, Math.min(1, scene.duration / 2), framePath);
        const spread = await frameLuminanceSpread(framePath);
        expect(spread).toBeGreaterThan(80);
      }

      // 4. Composition artifact exists on disk at the expected location.
      const compositions = persistedProject.compositions ?? [];
      expect(compositions.length).toBe(1);
      const composition = compositions[0];
      expect(composition.outputPath).toContain('renders/compositions/final-');
      expect(composition.outputPath.endsWith('.mp4')).toBe(true);

      const compositionPath = path.join(getProjectRoot(created.id), composition.outputPath);
      const compositionStat = await fs.stat(compositionPath);
      expect(compositionStat.size).toBeGreaterThan(0);

      // 5. ffprobe confirms valid video + audio streams, codecs and non-zero
      //    duration.
      const probe = await probeMedia(compositionPath, runtime);
      const video = probe.streams.find((stream) => stream.codec_type === 'video');
      const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
      expect(video).toBeDefined();
      expect(audio).toBeDefined();
      expect(video!.codec_name).toBe('h264');
      expect(video!.width).toBe(WIDTH);
      expect(video!.height).toBe(HEIGHT);
      expect(audio!.codec_name).toBe('aac');
      const duration = parseDurationSeconds(probe.format?.duration);
      expect(duration).toBeGreaterThan(0);

      // 6. Full decode succeeds with no errors.
      await decodeWithoutErrors(runtime.ffmpegPath, compositionPath);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 180000);
});
