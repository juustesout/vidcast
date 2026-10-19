import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runFfmpeg, runProcess } from '@/lib/render/ffmpeg-executor';
import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';
import { buildPresenterOverlayArgs } from '@/lib/render/presenter-overlay';
import type { CompositionPlan } from '@/lib/types/render';

const runtime = createFFmpegRuntime();
let tempDir = '';
let baseVideo = '';
let pipClip = '';
let fullscreenClip = '';

async function ffmpeg(args: string[]): Promise<void> {
  await runFfmpeg(runtime.ffmpegPath, args, { timeoutMs: 60_000 }, 'final_compose');
}

async function probe(filePath: string) {
  const result = await runProcess(runtime.ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,width,height',
    '-of',
    'json',
    filePath
  ]);
  return JSON.parse(result.stdout) as {
    format: { duration: string };
    streams: Array<{ codec_type: string; width?: number; height?: number }>;
  };
}

async function samplePixel(filePath: string, time: number, x: number, y: number): Promise<[number, number, number]> {
  const output = path.join(tempDir, `pixel-${Date.now()}-${Math.random().toString(16).slice(2)}.rgb`);
  await ffmpeg([
    '-y',
    '-ss',
    String(time),
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-vf',
    `crop=8:8:${x}:${y},scale=1:1`,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    output
  ]);
  const bytes = await fs.readFile(output);
  return [bytes[0], bytes[1], bytes[2]];
}

async function maxVolumeDb(filePath: string): Promise<number> {
  const result = await runProcess(runtime.ffmpegPath, ['-hide_banner', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-']);
  const match = result.stderr.match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  if (!match) {
    throw new Error('volumedetect did not report max_volume');
  }
  return match[1] === '-inf' ? -Infinity : Number(match[1]);
}

function plan(overrides: Partial<CompositionPlan>): CompositionPlan {
  return {
    projectId: 'presenter-overlay',
    width: 320,
    height: 180,
    fps: 30,
    totalDuration: 3,
    items: [],
    ...overrides
  } as unknown as CompositionPlan;
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'presenter-overlay-'));

  baseVideo = path.join(tempDir, 'base.mp4');
  await ffmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x180:r=30:d=3',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-t',
    '3',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    baseVideo
  ]);

  pipClip = path.join(tempDir, 'pip.mp4');
  await ffmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=160x90:r=30:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:sample_rate=48000:duration=1',
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
    pipClip
  ]);

  fullscreenClip = path.join(tempDir, 'fullscreen.mp4');
  await ffmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=green:s=320x180:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:sample_rate=48000:duration=2',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    fullscreenClip
  ]);
}, 120_000);

afterAll(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe('presenter overlay composition', () => {
  it('places a PiP presenter at the configured corner and keeps base audio', async () => {
    const output = path.join(tempDir, 'pip-output.mp4');
    const composition = plan({
      presenter: {
        placements: [
          {
            sceneId: 'scene-1',
            clipPath: pipClip,
            clipDuration: 1,
            startTime: 1,
            duration: 1.5,
            layout: 'pip',
            startOffsetSeconds: 0,
            pip: { position: 'bottom_right', widthRatio: 0.3, marginRatio: 0.05 }
          }
        ]
      }
    });

    await ffmpeg(buildPresenterOverlayArgs(baseVideo, output, composition));

    const info = await probe(output);
    const video = info.streams.find((stream) => stream.codec_type === 'video');
    const audio = info.streams.find((stream) => stream.codec_type === 'audio');
    expect(video).toMatchObject({ width: 320, height: 180 });
    expect(audio).toBeDefined();
    expect(Number(info.format.duration)).toBeCloseTo(3, 1);

    const [r, g, b] = await samplePixel(output, 1.5, 220, 120);
    expect(r).toBeGreaterThan(140);
    expect(g).toBeLessThan(90);
    expect(b).toBeLessThan(90);

    const [centerR, centerG, centerB] = await samplePixel(output, 1.5, 150, 80);
    expect(centerB).toBeGreaterThan(140);
    expect(centerR).toBeLessThan(90);
    expect(centerG).toBeLessThan(90);

    const [heldR, heldG, heldB] = await samplePixel(output, 2.2, 220, 120);
    expect(heldR).toBeGreaterThan(140);
    expect(heldG).toBeLessThan(90);
    expect(heldB).toBeLessThan(90);

    const [afterR, afterG, afterB] = await samplePixel(output, 2.7, 220, 120);
    expect(afterB).toBeGreaterThan(140);
    expect(afterR).toBeLessThan(90);
    expect(afterG).toBeLessThan(90);

    expect(await maxVolumeDb(output)).toBeLessThan(-60);
  }, 120_000);

  it('covers the full canvas in fullscreen mode without mixing presenter audio', async () => {
    const output = path.join(tempDir, 'fullscreen-output.mp4');
    const composition = plan({
      presenter: {
        placements: [
          {
            sceneId: 'scene-1',
            clipPath: fullscreenClip,
            clipDuration: 2,
            startTime: 0,
            duration: 2,
            layout: 'fullscreen',
            startOffsetSeconds: 0
          }
        ]
      }
    });

    await ffmpeg(buildPresenterOverlayArgs(baseVideo, output, composition));

    const [r, g, b] = await samplePixel(output, 1, 160, 90);
    expect(g).toBeGreaterThan(120);
    expect(r).toBeLessThan(90);
    expect(b).toBeLessThan(90);

    const [afterR, afterG, afterB] = await samplePixel(output, 2.5, 160, 90);
    expect(afterB).toBeGreaterThan(140);
    expect(afterR).toBeLessThan(90);
    expect(afterG).toBeLessThan(90);

    expect(await maxVolumeDb(output)).toBeLessThan(-60);
  }, 120_000);

  it('holds the final presenter frame when the clip is shorter than the scene', async () => {
    const output = path.join(tempDir, 'fullscreen-padded-output.mp4');
    const composition = plan({
      presenter: {
        placements: [
          {
            sceneId: 'scene-1',
            clipPath: fullscreenClip,
            clipDuration: 2,
            startTime: 0,
            duration: 2.5,
            layout: 'fullscreen',
            startOffsetSeconds: 0
          }
        ]
      }
    });

    await ffmpeg(buildPresenterOverlayArgs(baseVideo, output, composition));

    const [heldR, heldG, heldB] = await samplePixel(output, 2.4, 160, 90);
    expect(heldG).toBeGreaterThan(120);
    expect(heldR).toBeLessThan(90);
    expect(heldB).toBeLessThan(90);

    const [afterR, afterG, afterB] = await samplePixel(output, 2.8, 160, 90);
    expect(afterB).toBeGreaterThan(140);
    expect(afterR).toBeLessThan(90);
    expect(afterG).toBeLessThan(90);

    const info = await probe(output);
    expect(Number(info.format.duration)).toBeCloseTo(3, 1);
  }, 120_000);

  it('passes the base video through unchanged when no presenter is configured', async () => {
    const output = path.join(tempDir, 'passthrough.mp4');
    await ffmpeg(buildPresenterOverlayArgs(baseVideo, output, plan({})));

    const info = await probe(output);
    expect(Number(info.format.duration)).toBeCloseTo(3, 1);
    expect(info.streams.find((stream) => stream.codec_type === 'audio')).toBeDefined();
  }, 120_000);
});
