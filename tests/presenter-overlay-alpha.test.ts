import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runFfmpeg, runProcess } from '@/lib/render/ffmpeg-executor';
import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';
import { probePresenterVideo } from '@/lib/render/presenter-codec';
import { buildPresenterOverlayArgs } from '@/lib/render/presenter-overlay';
import { STUDIO_PIP_PRESETS } from '@/lib/render/studio-compositions';
import type { CompositionPlan } from '@/lib/types/render';

const runtime = createFFmpegRuntime();
const REAL_WEBM = path.resolve(
  'projects/project_7b983d8d-8e90-4f6f-bca0-925f2996d9ce/assets/scene-01-presenter-presenter_attempt_e2e34b6c-c57b-4c5b-8f09-d0260f5fc73f.webm'
);

let tempDir = '';
let studioBase = '';
let alphaClip = '';
let opaqueMp4 = '';

async function ffmpeg(args: string[]): Promise<void> {
  await runFfmpeg(runtime.ffmpegPath, args, { timeoutMs: 90_000 }, 'final_compose');
}

async function probe(filePath: string) {
  const result = await runProcess(runtime.ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=duration,format_name:stream=codec_type,codec_name,width,height,pix_fmt',
    '-of',
    'json',
    filePath
  ]);
  return JSON.parse(result.stdout) as {
    format: { duration: string; format_name?: string };
    streams: Array<{ codec_type: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string }>;
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

function plan(overrides: Partial<CompositionPlan>): CompositionPlan {
  return {
    projectId: 'presenter-alpha',
    width: 320,
    height: 180,
    fps: 30,
    totalDuration: 2,
    items: [],
    ...overrides
  } as unknown as CompositionPlan;
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'presenter-alpha-'));

  studioBase = path.join(tempDir, 'studio.mp4');
  await ffmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x0055FF:s=320x180:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
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
    studioBase
  ]);

  alphaClip = path.join(tempDir, 'alpha-presenter.webm');
  await ffmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=160x90:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'color=c=white:s=160x90:r=30:d=2',
    '-filter_complex',
    "[1]geq=lum='if(lt(X,W/3),255,if(lt(X,2*W/3),128,0))':cb=128:cr=128,format=gray[a];[0][a]alphamerge,format=yuva420p",
    '-an',
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-auto-alt-ref',
    '0',
    '-t',
    '2',
    alphaClip
  ]);

  opaqueMp4 = path.join(tempDir, 'opaque.mp4');
  await ffmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=160x90:r=30:d=2',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    opaqueMp4
  ]);
}, 120_000);

afterAll(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe('presenter overlay alpha composition', () => {
  it('puts libvpx-vp9 immediately before a WebM presenter input', () => {
    const args = buildPresenterOverlayArgs(studioBase, path.join(tempDir, 'args.mp4'), plan({
      presenter: {
        placements: [
          {
            sceneId: 'scene-1',
            clipPath: alphaClip,
            clipDuration: 2,
            startTime: 0,
            duration: 2,
            layout: 'pip',
            startOffsetSeconds: 0,
            pip: { ...STUDIO_PIP_PRESETS.news }
          }
        ]
      }
    }));
    const clipIndex = args.indexOf(alphaClip);
    expect(args.slice(clipIndex - 3, clipIndex + 1)).toEqual(['-c:v', 'libvpx-vp9', '-i', alphaClip]);
    expect(args.join(' ')).toContain('format=yuva420p');
    expect(args.join(' ')).toContain('overlay=');
    expect(args.includes('libx264')).toBe(true);
    expect(args.includes('yuv420p')).toBe(true);
  });

  it('composites synthetic VP9 alpha over a studio plate and flattens to H.264', async () => {
    const output = path.join(tempDir, 'synthetic-alpha.mp4');
    const composition = plan({
      presenter: {
        placements: [
          {
            sceneId: 'scene-news',
            clipPath: alphaClip,
            clipDuration: 2,
            startTime: 0,
            duration: 2,
            layout: 'pip',
            startOffsetSeconds: 0,
            pip: { position: 'top_right', widthRatio: 0.5, marginRatio: 0 }
          }
        ]
      }
    });

    await ffmpeg(buildPresenterOverlayArgs(studioBase, output, composition, {
      clipProbes: [await probePresenterVideo(alphaClip, runtime)]
    }));

    const info = await probe(output);
    const video = info.streams.find((stream) => stream.codec_type === 'video');
    expect(video).toMatchObject({ codec_name: 'h264', width: 320, height: 180, pix_fmt: 'yuv420p' });
    expect(info.streams.find((stream) => stream.codec_type === 'audio')).toBeDefined();

    const pipX = 320 - 160;
    const [opaqueR, opaqueG, opaqueB] = await samplePixel(output, 0.5, pipX + 20, 20);
    expect(opaqueR).toBeGreaterThan(140);
    expect(opaqueG).toBeLessThan(90);
    expect(opaqueB).toBeLessThan(90);

    const [partialR, , partialB] = await samplePixel(output, 0.5, pipX + 80, 20);
    expect(partialR).toBeGreaterThan(80);
    expect(partialB).toBeGreaterThan(80);

    const [clearR, , clearB] = await samplePixel(output, 0.5, pipX + 140, 20);
    expect(clearB).toBeGreaterThan(140);
    expect(clearR).toBeLessThan(90);

    const [studioR, studioG, studioB] = await samplePixel(output, 0.5, 20, 90);
    expect(studioB).toBeGreaterThan(140);
    expect(studioR).toBeLessThan(90);
    expect(studioG).toBeLessThan(120);
    expect(Math.abs(clearB - studioB)).toBeLessThan(40);
  }, 120_000);

  it('keeps opaque H.264 presenter clips rectangular', async () => {
    const output = path.join(tempDir, 'opaque-mp4.mp4');
    const composition = plan({
      presenter: {
        placements: [
          {
            sceneId: 'scene-news',
            clipPath: opaqueMp4,
            clipDuration: 2,
            startTime: 0,
            duration: 2,
            layout: 'pip',
            startOffsetSeconds: 0,
            pip: { position: 'top_right', widthRatio: 0.5, marginRatio: 0 }
          }
        ]
      }
    });

    const args = buildPresenterOverlayArgs(studioBase, output, composition, {
      clipProbes: [await probePresenterVideo(opaqueMp4, runtime)]
    });
    expect(args.includes('libvpx-vp9')).toBe(false);
    await ffmpeg(args);

    const pipX = 320 - 160;
    const [r, g, b] = await samplePixel(output, 0.5, pipX + 140, 20);
    expect(r).toBeGreaterThan(140);
    expect(g).toBeLessThan(90);
    expect(b).toBeLessThan(90);
  }, 120_000);

  it('composites the real P100.7j Avatar III WebM when the fixture is on disk', async () => {
    const available = await fs.access(REAL_WEBM).then(() => true).catch(() => false);
    if (!available) {
      expect(available, 'P100.7j WebM fixture missing').toBe(false);
      return;
    }

    const width = 960;
    const height = 540;
    const studio = path.join(tempDir, 'real-studio.mp4');
    await ffmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=0xFF00FF:s=${width}x${height}:r=30:d=2`,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
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
      studio
    ]);

    const output = path.join(tempDir, 'real-webm-news.mp4');
    const pip = STUDIO_PIP_PRESETS.news;
    const pipWidth = Math.round(width * pip.widthRatio);
    const margin = Math.round(width * pip.marginRatio);
    const pipHeight = Math.round(pipWidth * 1080 / 1920);
    const pipX = width - pipWidth - margin;
    const pipY = margin;

    await ffmpeg(buildPresenterOverlayArgs(studio, output, {
      projectId: 'real-webm',
      width,
      height,
      fps: 30,
      totalDuration: 2,
      items: [],
      presenter: {
        placements: [
          {
            sceneId: 'scene-news',
            clipPath: REAL_WEBM,
            clipDuration: 3.51628,
            startTime: 0,
            duration: 2,
            layout: 'pip',
            startOffsetSeconds: 0,
            pip
          }
        ]
      }
    } as unknown as CompositionPlan, {
      clipProbes: [await probePresenterVideo(REAL_WEBM, runtime)]
    }));

    const info = await probe(output);
    const video = info.streams.find((stream) => stream.codec_type === 'video');
    expect(video).toMatchObject({ codec_name: 'h264', width, height, pix_fmt: 'yuv420p' });

    const [cornerR, cornerG, cornerB] = await samplePixel(output, 0.8, pipX + 6, pipY + 6);
    expect(cornerR).toBeGreaterThan(180);
    expect(cornerB).toBeGreaterThan(180);
    expect(cornerG).toBeLessThan(80);

    const [bodyR, bodyG, bodyB] = await samplePixel(output, 0.8, pipX + Math.round(pipWidth / 2), pipY + Math.round(pipHeight / 2));
    const looksLikeMagentaStudio = bodyR > 180 && bodyB > 180 && bodyG < 80;
    expect(looksLikeMagentaStudio).toBe(false);

    const [leftR, leftG, leftB] = await samplePixel(output, 0.8, 40, 40);
    expect(leftR).toBeGreaterThan(180);
    expect(leftB).toBeGreaterThan(180);
    expect(leftG).toBeLessThan(80);
  }, 180_000);
});
