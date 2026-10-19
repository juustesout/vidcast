import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalFFmpegRenderer } from '@/lib/render/renderer';
import { runFfmpeg, runProcess } from '@/lib/render/ffmpeg-executor';
import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';
import { probeMedia } from '@/lib/render/ffprobe';
import type { RenderPlan, RenderPlanLogoOverlay, RenderPlanScene } from '@/lib/types/render';

const WIDTH = 640;
const HEIGHT = 360;
const FPS = 30;
const DURATION = 1.2;

const runtime = createFFmpegRuntime();
let tempRoot = '';
let redStill = '';
let redVideoWithAudio = '';
let splitLogo = '';
let blueLogo = '';

async function ffmpeg(args: string[]): Promise<void> {
  await runFfmpeg(runtime.ffmpegPath, args, { timeoutMs: 60_000 }, 'scene_render');
}

async function samplePixel(filePath: string, time: number, x: number, y: number): Promise<[number, number, number]> {
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

function plan(source: RenderPlanScene['source'], logo: RenderPlanLogoOverlay | undefined, duration = DURATION): RenderPlan {
  return {
    projectId: 'project-logo-render',
    title: 'Logo Render',
    aspectRatio: '16:9',
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    background: { type: 'color', value: '#070b10' },
    ready: true,
    narration: { text: '', segments: [] },
    issues: [],
    scenes: [
      {
        sceneId: 'scene-1',
        order: 1,
        duration,
        status: 'renderable',
        source,
        motion: { preset: 'none' },
        transition: { type: 'none' },
        overlay: { type: 'none' },
        logo,
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
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'logo-overlay-render-'));

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

  // Left half opaque green, right half fully transparent. The opaque half must
  // survive PNG alpha compositing; the transparent half must reveal the base.
  const data = Buffer.alloc(128 * 64 * 4);
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      const index = (y * 128 + x) * 4;
      if (x < 64) {
        data[index] = 0;
        data[index + 1] = 255;
        data[index + 2] = 0;
        data[index + 3] = 255;
      } else {
        data[index + 3] = 0;
      }
    }
  }
  splitLogo = path.join(tempRoot, 'split-logo.png');
  await sharp(data, { raw: { width: 128, height: 64, channels: 4 } }).png().toFile(splitLogo);

  blueLogo = path.join(tempRoot, 'blue-logo.png');
  await sharp({ create: { width: 128, height: 64, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } })
    .png()
    .toFile(blueLogo);
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('logo overlay rendering (ffmpeg integration)', () => {
  it('composites a transparent PNG above a stock image layer', async () => {
    const output = await render(
      plan(
        { kind: 'image', assetPath: redStill, assetType: 'image', width: WIDTH, height: HEIGHT },
        { assetId: 'logo-a', assetPath: splitLogo, position: 'top_left', scale: 0.2, margin: 80 }
      ),
      'logo-stock'
    );

    // Opaque half: green. Transparent half: red base shows through.
    const opaque = await samplePixel(output, 0.8, 90, 100);
    const transparent = await samplePixel(output, 0.8, 190, 100);

    expect(opaque[1]).toBeGreaterThan(120);
    expect(opaque[0]).toBeLessThan(100);
    expect(transparent[0]).toBeGreaterThan(120);
    expect(transparent[1]).toBeLessThan(100);
  }, 120000);

  it('composites the same logo layer above a graphic SVG scene', async () => {
    const output = await render(
      plan(
        { kind: 'graphic', template: 'statistic', templateData: { value: '82%', label: 'adoption' } },
        { assetId: 'logo-a', assetPath: splitLogo, position: 'top_left', scale: 0.2, margin: 80 }
      ),
      'logo-graphic'
    );

    const opaque = await samplePixel(output, 0.8, 90, 100);
    expect(opaque[1]).toBeGreaterThan(120);
    expect(opaque[0]).toBeLessThan(100);
  }, 120000);

  it('supports different logos per scene and keeps the source audio track', async () => {
    const green = await render(
      plan(
        { kind: 'video', assetPath: redVideoWithAudio, assetType: 'video', duration: 1 },
        { assetId: 'logo-a', assetPath: splitLogo, position: 'bottom_right', scale: 0.2, margin: 32 }
      ),
      'logo-video-green'
    );
    const blue = await render(
      plan(
        { kind: 'video', assetPath: redVideoWithAudio, assetType: 'video', duration: 1 },
        { assetId: 'logo-b', assetPath: blueLogo, position: 'bottom_right', scale: 0.2, margin: 32 }
      ),
      'logo-video-blue'
    );

    const greenPixel = await samplePixel(green, 0.5, 520, 290);
    const bluePixel = await samplePixel(blue, 0.5, 520, 290);

    expect(greenPixel[1]).toBeGreaterThan(120);
    expect(bluePixel[2]).toBeGreaterThan(120);

    const probe = await probeMedia(green, runtime);
    expect(probe.streams.some((stream) => stream.codec_type === 'video')).toBe(true);
    expect(probe.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);
  }, 180000);

  it('composites a logo on blank scenes together with the text overlay path', async () => {
    const value = plan(
      { kind: 'blank' },
      { assetId: 'logo-a', assetPath: splitLogo, position: 'top_left', scale: 0.2, margin: 80 }
    );
    value.scenes[0].overlay = { type: 'title', text: 'Blank + logo', position: 'bottom' };

    const output = await render(value, 'logo-blank');
    const opaque = await samplePixel(output, 0.8, 90, 100);

    expect(opaque[1]).toBeGreaterThan(120);
    expect(opaque[0]).toBeLessThan(100);
  }, 120000);

  it('renders scenes without a logo exactly on the original path', async () => {
    const output = await render(
      plan({ kind: 'image', assetPath: redStill, assetType: 'image', width: WIDTH, height: HEIGHT }, undefined),
      'logo-absent'
    );
    const pixel = await samplePixel(output, 0.8, 320, 180);
    expect(pixel[0]).toBeGreaterThan(120);
  }, 120000);
});
