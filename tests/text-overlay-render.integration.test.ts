import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { LocalFFmpegRenderer } from '@/lib/render/renderer';
import { runProcess } from '@/lib/render/ffmpeg-executor';
import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';
import { parseDurationSeconds, probeMedia } from '@/lib/render/ffprobe';
import type { OverlaySpec } from '@/lib/types/scene';
import type { RenderPlan } from '@/lib/types/render';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const DURATION = 2;

function createPlan(inputPath: string, overlay: OverlaySpec): RenderPlan {
  return {
    projectId: 'project-overlay-render',
    title: 'Overlay Render',
    aspectRatio: '16:9',
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    background: { type: 'color', value: '#020617' },
    ready: true,
    narration: { text: '', segments: [] },
    issues: [],
    scenes: [
      {
        sceneId: 'scene-1',
        order: 1,
        duration: DURATION,
        status: 'renderable',
        source: { kind: 'image', assetPath: inputPath, assetType: 'image' },
        motion: { preset: 'none' },
        transition: { type: 'none' },
        overlay,
        referenceIds: [],
        issues: []
      }
    ]
  };
}

async function renderScene(plan: RenderPlan, tempRoot: string, renderId: string): Promise<{ outputPath: string; duration: number }> {
  const outputPath = path.join(tempRoot, `${renderId}.mp4`);
  const renderer = new LocalFFmpegRenderer();
  const result = await renderer.render(plan, {
    projectId: plan.projectId,
    sceneId: 'scene-1',
    renderId,
    outputPath,
    tempDir: path.join(tempRoot, `${renderId}-tmp`),
    sceneWidth: plan.width,
    sceneHeight: plan.height,
    sceneFps: plan.fps
  });

  expect(result.status).toBe('completed');
  expect(result.width).toBe(WIDTH);
  expect(result.height).toBe(HEIGHT);
  expect(result.fps).toBe(FPS);
  expect(result.duration).toBeGreaterThan(0);

  const stat = await fs.stat(outputPath);
  expect(stat.size).toBeGreaterThan(0);

  return { outputPath, duration: result.duration };
}

describe('text overlay rendering (ffmpeg integration)', () => {
  it('renders an image scene with a title overlay containing special characters', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-render-image-'));
    const inputPath = path.join(tempRoot, 'input.png');
    await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#123456' } }).png().toFile(inputPath);

    const plan = createPlan(inputPath, {
      type: 'title',
      text: "50% growth: \"fast\", back\\slash 'quoted' [x] & <y>\nsecond line",
      position: 'top',
      style: { fontSize: 64, color: '#f8fafc' },
      timing: { fadeInSeconds: 0.5 }
    });

    const { outputPath } = await renderScene(plan, tempRoot, 'render-overlay-title');

    // Full decode: no errors, no undecoded frames.
    const runtime = createFFmpegRuntime();
    await runProcess(runtime.ffmpegPath, ['-v', 'error', '-i', outputPath, '-f', 'null', '-'], { timeoutMs: 120000 });

    const probe = await probeMedia(outputPath, runtime);
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    expect(video).toBeDefined();
    expect(video!.width).toBe(WIDTH);
    expect(video!.height).toBe(HEIGHT);
    expect(video!.codec_name).toBe('h264');
  }, 120000);

  it('renders a bottom text overlay on a blank scene', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-render-blank-'));
    const plan = createPlan('', { type: 'text', text: 'Bottom caption', position: 'bottom' });
    plan.scenes[0].source = { kind: 'blank' };

    const { outputPath } = await renderScene(plan, tempRoot, 'render-overlay-blank');
    const probe = await probeMedia(outputPath, createFFmpegRuntime());
    expect(probe.streams.some((stream) => stream.codec_type === 'video')).toBe(true);
  }, 120000);

  it('composes an image + overlay scene with a narration track and validates the result', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-render-narration-'));
    const inputPath = path.join(tempRoot, 'input.png');
    await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#0b1f3a' } }).png().toFile(inputPath);

    const plan = createPlan(inputPath, {
      type: 'callout',
      text: 'Key insight: 50% faster',
      position: 'center',
      timing: { fadeInSeconds: 0.4, fadeOutSeconds: 0.4 }
    });

    const { outputPath: scenePath, duration } = await renderScene(plan, tempRoot, 'render-overlay-narration');

    const runtime = createFFmpegRuntime();
    const narrationPath = path.join(tempRoot, 'narration.wav');
    await runProcess(
      runtime.ffmpegPath,
      ['-y', '-v', 'error', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', String(duration), '-c:a', 'pcm_s16le', narrationPath],
      { timeoutMs: 120000 }
    );

    const finalPath = path.join(tempRoot, 'final.mp4');
    await runProcess(
      runtime.ffmpegPath,
      ['-y', '-v', 'error', '-i', scenePath, '-i', narrationPath, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', finalPath],
      { timeoutMs: 120000 }
    );

    const probe = await probeMedia(finalPath, runtime);
    expect(probe.streams.some((stream) => stream.codec_type === 'video')).toBe(true);
    expect(probe.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);

    const finalDuration = parseDurationSeconds(probe.format?.duration);
    expect(finalDuration).toBeGreaterThan(0);
    expect(Math.abs((finalDuration ?? 0) - duration)).toBeLessThan(0.35);

    await runProcess(runtime.ffmpegPath, ['-v', 'error', '-i', finalPath, '-f', 'null', '-'], { timeoutMs: 120000 });
  }, 120000);
});

describe('text overlay temp file lifecycle', () => {
  it('removes the per-render temp directory after a successful render', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-cleanup-ok-'));
    const inputPath = path.join(tempRoot, 'input.png');
    await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#123456' } }).png().toFile(inputPath);
    const plan = createPlan(inputPath, { type: 'title', text: 'Cleanup', position: 'top' });

    await renderScene(plan, tempRoot, 'render-cleanup-ok');

    await expect(fs.access(path.join(tempRoot, 'render-cleanup-ok-tmp'))).rejects.toBeDefined();
  }, 120000);

  it('removes the per-render temp directory after a failed render', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-cleanup-fail-'));
    const plan = createPlan(path.join(tempRoot, 'missing.png'), { type: 'title', text: 'Cleanup', position: 'top' });

    const renderer = new LocalFFmpegRenderer();
    const tempDir = path.join(tempRoot, 'render-cleanup-fail-tmp');
    await expect(
      renderer.render(plan, {
        projectId: plan.projectId,
        sceneId: 'scene-1',
        renderId: 'render-cleanup-fail',
        outputPath: path.join(tempRoot, 'render-cleanup-fail.mp4'),
        tempDir,
        sceneWidth: WIDTH,
        sceneHeight: HEIGHT,
        sceneFps: FPS
      })
    ).rejects.toThrow();

    await expect(fs.access(tempDir)).rejects.toBeDefined();
  }, 120000);

  it('gives concurrent overlay renders distinct temp dirs (no shared text file)', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-concurrent-'));
    const inputA = path.join(tempRoot, 'a.png');
    const inputB = path.join(tempRoot, 'b.png');
    await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#111111' } }).png().toFile(inputA);
    await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#222222' } }).png().toFile(inputB);

    const planA = createPlan(inputA, { type: 'title', text: 'Scene A overlay', position: 'top' });
    const planB = createPlan(inputB, { type: 'text', text: 'Scene B overlay', position: 'bottom' });

    await Promise.all([renderScene(planA, tempRoot, 'render-concurrent-a'), renderScene(planB, tempRoot, 'render-concurrent-b')]);

    await expect(fs.access(path.join(tempRoot, 'render-concurrent-a-tmp'))).rejects.toBeDefined();
    await expect(fs.access(path.join(tempRoot, 'render-concurrent-b-tmp'))).rejects.toBeDefined();
  }, 120000);
});
