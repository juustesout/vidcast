import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { LocalFFmpegRenderer } from '@/lib/render/renderer';
import { runProcess } from '@/lib/render/ffmpeg-executor';
import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';
import { probeMedia } from '@/lib/render/ffprobe';
import type { RenderPlan } from '@/lib/types/render';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const DURATION = 2;

function createPlan(inputPath: string, subtitlesEnabled = true): RenderPlan {
  return {
    projectId: 'project-karaoke-render',
    title: 'Karaoke Render',
    aspectRatio: '16:9',
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    background: { type: 'color', value: '#020617' },
    ready: true,
    narration: { text: '', segments: [] },
    issues: [],
    subtitlesEnabled,
    scenes: [
      {
        sceneId: 'scene-1',
        order: 1,
        duration: DURATION,
        status: 'renderable',
        source: { kind: 'image', assetPath: inputPath, assetType: 'image' },
        motion: { preset: 'none' },
        transition: { type: 'none' },
        overlay: { type: 'none' },
        narration: {
          text: 'Hallo wereld',
          alignment: {
            characters: {
              characters: ['H', 'a', 'l', 'l', 'o', ' ', 'w', 'e', 'r', 'e', 'l', 'd'],
              characterStartTimesSeconds: [0.1, 0.16, 0.22, 0.28, 0.34, 0.5, 0.55, 0.65, 0.75, 0.85, 0.95, 1.05],
              characterEndTimesSeconds: [0.16, 0.22, 0.28, 0.34, 0.5, 0.55, 0.65, 0.75, 0.85, 0.95, 1.05, 1.3]
            },
            words: [
              { word: 'Hallo', startSeconds: 0.1, endSeconds: 0.5 },
              { word: 'wereld', startSeconds: 0.55, endSeconds: 1.3 }
            ]
          }
        },
        referenceIds: [],
        issues: []
      }
    ]
  };
}

describe('karaoke rendering (ffmpeg integration)', () => {
  it('burns word-timed karaoke when alignment is present', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'karaoke-render-'));
    const inputPath = path.join(tempRoot, 'input.png');
    await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#123456' } }).png().toFile(inputPath);

    const plan = createPlan(inputPath);
    const outputPath = path.join(tempRoot, 'karaoke.mp4');
    const renderer = new LocalFFmpegRenderer();
    const result = await renderer.render(plan, {
      projectId: plan.projectId,
      sceneId: 'scene-1',
      renderId: 'render-karaoke',
      outputPath,
      tempDir: path.join(tempRoot, 'tmp'),
      sceneWidth: WIDTH,
      sceneHeight: HEIGHT,
      sceneFps: FPS
    });

    expect(result.status).toBe('completed');
    const runtime = createFFmpegRuntime();
    await runProcess(runtime.ffmpegPath, ['-v', 'error', '-i', outputPath, '-f', 'null', '-'], { timeoutMs: 120000 });
    const probe = await probeMedia(outputPath, runtime);
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    expect(video?.width).toBe(WIDTH);
    expect(video?.height).toBe(HEIGHT);
  }, 120000);

  it('skips karaoke when subtitlesEnabled is false', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'karaoke-disabled-'));
    const inputPath = path.join(tempRoot, 'input.png');
    await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#123456' } }).png().toFile(inputPath);

    const plan = createPlan(inputPath, false);
    const outputPath = path.join(tempRoot, 'plain.mp4');
    const renderer = new LocalFFmpegRenderer();
    const result = await renderer.render(plan, {
      projectId: plan.projectId,
      sceneId: 'scene-1',
      renderId: 'render-karaoke-off',
      outputPath,
      tempDir: path.join(tempRoot, 'tmp'),
      sceneWidth: WIDTH,
      sceneHeight: HEIGHT,
      sceneFps: FPS
    });

    expect(result.status).toBe('completed');
  }, 120000);
});
