import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProcessExecutionError, runProcess } from '@/lib/render/ffmpeg-executor';
import { FFprobeError, probeMedia } from '@/lib/render/ffprobe';
import { LocalFFmpegRenderer, SceneRenderError } from '@/lib/render/renderer';
import {
  DEFAULT_FINAL_COMPOSE_TIMEOUT_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_SCENE_RENDER_TIMEOUT_MS,
  MAX_RENDER_TIMEOUT_MS,
  MIN_RENDER_TIMEOUT_MS,
  getFinalComposeTimeoutMs,
  getProbeTimeoutMs,
  getSceneRenderTimeoutMs
} from '@/lib/render/render-timeouts';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { Project } from '@/lib/types/render';

const ENV_KEYS = ['RENDER_SCENE_TIMEOUT_MS', 'RENDER_COMPOSE_TIMEOUT_MS', 'RENDER_PROBE_TIMEOUT_MS'] as const;

let tempRoot: string;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'render-diagnostics-'));
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

async function createSleepingScript(name: string): Promise<string> {
  const scriptPath = path.join(tempRoot, name);
  await fs.writeFile(scriptPath, '#!/bin/sh\nexec sleep 60\n', 'utf8');
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

function createBlankSceneProject(): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-diagnostics',
    title: 'Diagnostics',
    description: 'desc',
    durationTarget: 3,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1280,
      height: 720,
      background: { type: 'color', value: '#020617' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    assets: [],
    references: [],
    scenes: [
      {
        id: 'scene-blank',
        order: 1,
        duration: 1,
        type: 'blank',
        narration: { text: '' },
        visual: { kind: 'blank' },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ]
  };
}

async function renderWithRuntime(runtime: { ffmpegPath: string; ffprobePath: string }): Promise<SceneRenderError> {
  const project = createBlankSceneProject();
  const plan = resolveRenderPlan(project);
  const renderer = new LocalFFmpegRenderer(runtime);

  try {
    await renderer.render(plan, {
      projectId: project.id,
      sceneId: plan.scenes[0].sceneId,
      renderId: 'render-diagnostics',
      outputPath: path.join(tempRoot, 'out.mp4'),
      tempDir: path.join(tempRoot, 'tmp'),
      sceneWidth: plan.width,
      sceneHeight: plan.height,
      sceneFps: plan.fps
    });
  } catch (error) {
    if (error instanceof SceneRenderError) {
      return error;
    }
    throw error;
  }

  throw new Error('Expected the render to fail.');
}

describe('ffmpeg process failure reasons', () => {
  it('reports spawn_error when the executable cannot start', async () => {
    await expect(runProcess('/nonexistent/ffmpeg-does-not-exist', [])).rejects.toMatchObject({
      reason: 'spawn_error'
    });
  });

  it('reports a non-zero exit code', async () => {
    try {
      await runProcess(process.execPath, ['-e', 'process.exit(3)']);
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessExecutionError);
      const executionError = error as ProcessExecutionError;
      expect(executionError.reason).toBe('exit');
      expect(executionError.exitCode).toBe(3);
    }
  });

  it('distinguishes termination by signal', async () => {
    try {
      await runProcess(process.execPath, ['-e', "process.kill(process.pid, 'SIGKILL')"]);
      throw new Error('expected failure');
    } catch (error) {
      const executionError = error as ProcessExecutionError;
      expect(executionError).toBeInstanceOf(ProcessExecutionError);
      expect(executionError.reason).toBe('signal');
      expect(executionError.signal).toBe('SIGKILL');
    }
  });

  it('kills the child and reports timeout', async () => {
    const startedAt = Date.now();
    try {
      await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 150 });
      throw new Error('expected timeout');
    } catch (error) {
      const executionError = error as ProcessExecutionError;
      expect(executionError).toBeInstanceOf(ProcessExecutionError);
      expect(executionError.reason).toBe('timeout');
    }
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe('render timeout configuration', () => {
  it('uses defaults when unset', () => {
    expect(getSceneRenderTimeoutMs({})).toBe(DEFAULT_SCENE_RENDER_TIMEOUT_MS);
    expect(getFinalComposeTimeoutMs({})).toBe(DEFAULT_FINAL_COMPOSE_TIMEOUT_MS);
    expect(getProbeTimeoutMs({})).toBe(DEFAULT_PROBE_TIMEOUT_MS);
  });

  it('reads valid overrides', () => {
    expect(getSceneRenderTimeoutMs({ RENDER_SCENE_TIMEOUT_MS: '90000' })).toBe(90_000);
    expect(getFinalComposeTimeoutMs({ RENDER_COMPOSE_TIMEOUT_MS: '240000' })).toBe(240_000);
    expect(getProbeTimeoutMs({ RENDER_PROBE_TIMEOUT_MS: '5000' })).toBe(5_000);
  });

  it('falls back on invalid values and clamps to safe bounds', () => {
    expect(getSceneRenderTimeoutMs({ RENDER_SCENE_TIMEOUT_MS: 'not-a-number' })).toBe(DEFAULT_SCENE_RENDER_TIMEOUT_MS);
    expect(getSceneRenderTimeoutMs({ RENDER_SCENE_TIMEOUT_MS: '0' })).toBe(DEFAULT_SCENE_RENDER_TIMEOUT_MS);
    expect(getSceneRenderTimeoutMs({ RENDER_SCENE_TIMEOUT_MS: '-5' })).toBe(DEFAULT_SCENE_RENDER_TIMEOUT_MS);
    expect(getSceneRenderTimeoutMs({ RENDER_SCENE_TIMEOUT_MS: '1' })).toBe(MIN_RENDER_TIMEOUT_MS);
    expect(getSceneRenderTimeoutMs({ RENDER_SCENE_TIMEOUT_MS: '999999999' })).toBe(MAX_RENDER_TIMEOUT_MS);
  });
});

describe('render error classification', () => {
  it('maps a missing ffmpeg binary to FFMPEG_UNAVAILABLE', async () => {
    const error = await renderWithRuntime({ ffmpegPath: '/nonexistent/ffmpeg-does-not-exist', ffprobePath: 'ffprobe' });
    expect(error.code).toBe('FFMPEG_UNAVAILABLE');
  });

  it('maps a render timeout to FFMPEG_TIMEOUT (not FFMPEG_UNAVAILABLE)', async () => {
    process.env.RENDER_SCENE_TIMEOUT_MS = '200';
    const scriptPath = await createSleepingScript('slow-ffmpeg.sh');

    const error = await renderWithRuntime({ ffmpegPath: scriptPath, ffprobePath: 'ffprobe' });
    expect(error.code).toBe('FFMPEG_TIMEOUT');
  }, 30_000);
});

describe('ffprobe timeout', () => {
  it('does not hang when ffprobe stalls', async () => {
    process.env.RENDER_PROBE_TIMEOUT_MS = '200';
    const scriptPath = await createSleepingScript('slow-ffprobe.sh');

    const startedAt = Date.now();
    try {
      await probeMedia('some-media.mp4', { ffmpegPath: 'ffmpeg', ffprobePath: scriptPath });
      throw new Error('expected probe to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(FFprobeError);
      expect((error as FFprobeError).reason).toBe('timeout');
    }
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
