import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalFFmpegRenderer } from '@/lib/render/renderer';
import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';
import { probeMedia } from '@/lib/render/ffprobe';
import { runFfmpeg } from '@/lib/render/ffmpeg-executor';
import type { RenderPlan, RenderPlanScene } from '@/lib/types/render';

const WIDTH = 640;
const HEIGHT = 360;
const FPS = 30;
const DURATION = 1.2;

const runtime = createFFmpegRuntime();
let tempRoot = '';
let redStill = '';
let redVideo = '';
let redVideoWithAudio = '';

async function ffmpeg(args: string[]): Promise<void> {
  await runFfmpeg(runtime.ffmpegPath, args, { timeoutMs: 60_000 }, 'scene_render');
}

async function samplePixel(filePath: string, x: number, y: number, time = 0.8): Promise<[number, number, number]> {
  return samplePixelAt(filePath, x, y, time);
}

async function samplePixelAt(filePath: string, x: number, y: number, time: number): Promise<[number, number, number]> {
  const output = path.join(tempRoot, `pixel-${Date.now()}-${Math.random().toString(16).slice(2)}.rgb`);
  await ffmpeg([
    '-y',
    '-ss',
    String(time),
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-vf',
    `crop=4:4:${x}:${y},scale=1:1`,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    output
  ]);
  const bytes = await fs.readFile(output);
  return [bytes[0], bytes[1], bytes[2]];
}

function plan(source: RenderPlanScene['source'], transition: RenderPlanScene['transition'] = { type: 'none' }): RenderPlan {
  return {
    projectId: 'project-studio-render',
    title: 'Studio Render',
    aspectRatio: '16:9',
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    background: { type: 'color', value: '#070b10' },
    studio: {
      brand: 'AI DEV FORUM',
      program: 'NEWS',
      accentColor: '#ff5a5f',
      screen: { x: 32, y: 32, width: 435, height: 252, radius: 8 }
    },
    ready: true,
    narration: { text: '', segments: [] },
    issues: [],
    scenes: [
      {
        sceneId: 'scene-1',
        order: 1,
        duration: DURATION,
        status: 'renderable',
        source,
        motion: { preset: 'none' },
        transition,
        overlay: { type: 'none' },
        referenceIds: [],
        issues: []
      }
    ]
  };
}

async function render(planValue: RenderPlan, renderId: string): Promise<string> {
  const outputPath = path.join(tempRoot, `${renderId}.mp4`);
  const result = await new LocalFFmpegRenderer(runtime).render(planValue, {
    projectId: planValue.projectId,
    sceneId: 'scene-1',
    renderId,
    outputPath,
    tempDir: path.join(tempRoot, `${renderId}-tmp`),
    sceneWidth: WIDTH,
    sceneHeight: HEIGHT,
    sceneFps: FPS
  });

  expect(result.status).toBe('completed');
  expect(result.duration).toBeGreaterThan(0);
  return outputPath;
}

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-render-'));

  redStill = path.join(tempRoot, 'red.png');
  await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#ff0000' } }).png().toFile(redStill);

  redVideoWithAudio = path.join(tempRoot, 'red-audio.mp4');
  await ffmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=red:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=1`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    redVideoWithAudio
  ]);

  redVideo = path.join(tempRoot, 'red.mp4');
  await ffmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=red:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=1`,
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    redVideo
  ]);
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('studio overlay rendering (ffmpeg integration)', () => {
  it('shows the still source through the screen cutout and the studio outside it', async () => {
    const output = await render(
      plan({ kind: 'image', assetPath: redStill, assetType: 'image', width: WIDTH, height: HEIGHT }),
      'studio-still'
    );

    const screen = await samplePixel(output, 250, 160);
    const rightFrame = await samplePixel(output, 600, 200);
    const topFrame = await samplePixel(output, 300, 10);

    expect(screen[0]).toBeGreaterThan(180);
    expect(screen[1]).toBeLessThan(90);
    expect(screen[2]).toBeLessThan(90);
    expect(rightFrame[0]).toBeLessThan(60);
    expect(topFrame[0]).toBeLessThan(60);
  }, 120000);

  it('keeps source audio when a video is framed by the studio', async () => {
    const output = await render(
      plan({ kind: 'video', assetPath: redVideoWithAudio, assetType: 'video', width: WIDTH, height: HEIGHT }),
      'studio-video-audio'
    );

    const probe = await probeMedia(output, runtime);
    expect(probe.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);

    const screen = await samplePixel(output, 250, 160);
    expect(screen[0]).toBeGreaterThan(180);
  }, 120000);

  it('fades the framed still source while leaving the studio chrome opaque', async () => {
    const output = await render(
      plan(
        { kind: 'image', assetPath: redStill, assetType: 'image', width: WIDTH, height: HEIGHT },
        { type: 'fade', duration: 0.3 }
      ),
      'studio-still-fade'
    );

    const screenHead = await samplePixelAt(output, 250, 160, 0.02);
    const screenMiddle = await samplePixelAt(output, 250, 160, DURATION / 2);
    const frameHead = await samplePixelAt(output, 600, 200, 0.02);
    const frameMiddle = await samplePixelAt(output, 600, 200, DURATION / 2);

    expect(screenMiddle[0]).toBeGreaterThan(180);
    expect(screenHead[0]).toBeLessThan(screenMiddle[0] * 0.5);
    expect(frameHead[0]).toBeLessThan(60);
    expect(frameMiddle[0]).toBeLessThan(60);
  }, 120000);

  it('fades a framed video source without touching the studio chrome', async () => {
    const output = await render(
      plan(
        { kind: 'video', assetPath: redVideo, assetType: 'video', width: WIDTH, height: HEIGHT },
        { type: 'fade', duration: 0.3 }
      ),
      'studio-video-fade'
    );

    const screenHead = await samplePixelAt(output, 250, 160, 0.02);
    const screenMiddle = await samplePixelAt(output, 250, 160, DURATION / 2);
    const frameMiddle = await samplePixelAt(output, 600, 200, DURATION / 2);

    expect(screenMiddle[0]).toBeGreaterThan(180);
    expect(screenHead[0]).toBeLessThan(screenMiddle[0] * 0.5);
    expect(frameMiddle[0]).toBeLessThan(60);
  }, 120000);

  it('applies the same studio layer to a video source', async () => {
    const output = await render(
      plan({ kind: 'video', assetPath: redVideo, assetType: 'video', width: WIDTH, height: HEIGHT }),
      'studio-video'
    );

    const screen = await samplePixel(output, 250, 160);
    const rightFrame = await samplePixel(output, 600, 200);

    expect(screen[0]).toBeGreaterThan(180);
    expect(screen[1]).toBeLessThan(90);
    expect(rightFrame[0]).toBeLessThan(60);
  }, 120000);
});
