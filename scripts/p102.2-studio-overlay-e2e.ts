/**
 * P102.2 studio Motion Canvas overlay proof.
 *
 * Composites one original Motion Canvas animation as an independent alpha
 * overlay on the production studio FFmpeg compositor. Studio stills are
 * generated locally. The presenter clip is the real P100.7j HeyGen WebM.
 *
 * Usage:
 *   npx tsx scripts/p102.2-studio-overlay-e2e.ts
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { runFfmpeg, runProcess } from '../lib/render/ffmpeg-executor';
import { createFFmpegRuntime } from '../lib/render/ffmpeg-runtime';
import { LocalFFmpegRenderer } from '../lib/render/renderer';
import {
  createStudioComposition,
  STUDIO_BIGSCREEN_RECT,
  STUDIO_OVERLAY_RECT
} from '../lib/render/scene-composition';
import { resolveRenderPlan } from '../lib/render/scene-resolver';
import { getProjectRoot } from '../lib/storage/storage-paths';
import type { Asset } from '../lib/types/asset';
import type { Project } from '../lib/types/render';
import type { Scene } from '../lib/types/scene';

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const DURATION = 5;
const PROJECT_ID = 'project_p1022_studio_overlay';
const NOW = new Date().toISOString();
const SOURCE_WEBM =
  'projects/project_7b983d8d-8e90-4f6f-bca0-925f2996d9ce/assets/scene-01-presenter-presenter_attempt_e2e34b6c-c57b-4c5b-8f09-d0260f5fc73f.webm';
const SOURCE_AUDIO =
  'projects/project_7b983d8d-8e90-4f6f-bca0-925f2996d9ce/assets/asset_e34db47d-63c7-48fc-bffc-807dbf2ac2cd-narration.mp3';
const OVERLAY_PNG_DIR = path.resolve('motion-canvas/output/p102-2-overlay');
const OVERLAY_WEBM = path.resolve('motion-canvas/output/p102-2-overlay.webm');

const runtime = createFFmpegRuntime();

function asset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    type: 'image',
    status: 'available',
    provenance: 'imported',
    filename: `${id}.png`,
    localPath: `assets/studio/${id}.png`,
    mimeType: 'image/png',
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

async function ffmpeg(args: string[]): Promise<void> {
  await runFfmpeg(runtime.ffmpegPath, args, { timeoutMs: 180_000 }, 'scene_render');
}

async function probe(filePath: string) {
  const result = await runProcess(runtime.ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=duration,format_name,size:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,tags',
    '-of',
    'json',
    filePath
  ]);
  return JSON.parse(result.stdout) as {
    format: { duration?: string; format_name?: string; size?: string };
    streams: Array<{
      codec_type: string;
      codec_name?: string;
      width?: number;
      height?: number;
      pix_fmt?: string;
      r_frame_rate?: string;
      tags?: Record<string, string>;
    }>;
  };
}

async function samplePixel(filePath: string, x: number, y: number, time = 1.2): Promise<[number, number, number]> {
  const output = path.join(path.dirname(filePath), `pixel-${x}-${y}-${time}.rgb`);
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

async function extractFrame(filePath: string, outputPath: string, time = 1.2): Promise<void> {
  await ffmpeg([
    '-y',
    '-ss',
    String(time),
    '-i',
    filePath,
    '-frames:v',
    '1',
    outputPath
  ]);
}

async function measurePngAlpha(filePath: string) {
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0;
  let opaque = 0;
  const corners: Array<{ x: number; y: number; a: number }> = [];
  for (const [x, y] of [[0, 0], [info.width - 1, 0], [0, info.height - 1], [info.width - 1, info.height - 1]] as const) {
    corners.push({ x, y, a: data[(y * info.width + x) * info.channels + 3] });
  }
  for (let i = 3; i < data.length; i += info.channels) {
    if (data[i] === 0) {
      transparent += 1;
    } else if (data[i] > 250) {
      opaque += 1;
    }
  }
  const pixels = info.width * info.height;
  return {
    width: info.width,
    height: info.height,
    channels: info.channels,
    corners,
    transparentRatio: transparent / pixels,
    opaqueRatio: opaque / pixels
  };
}

async function muxOverlayWebm(): Promise<{ frames: number; webm: string }> {
  const names = (await fs.readdir(OVERLAY_PNG_DIR))
    .filter((name) => name.endsWith('.png'))
    .sort();
  if (names.length < 30) {
    throw new Error(`Expected overlay PNG sequence in ${OVERLAY_PNG_DIR}, found ${names.length} frames`);
  }
  await ffmpeg([
    '-y',
    '-framerate',
    String(FPS),
    '-i',
    path.join(OVERLAY_PNG_DIR, '%06d.png'),
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-auto-alt-ref',
    '0',
    '-an',
    OVERLAY_WEBM
  ]);
  return { frames: names.length, webm: OVERLAY_WEBM };
}

async function main(): Promise<void> {
  const projectRoot = getProjectRoot(PROJECT_ID);
  const studioDir = path.join(projectRoot, 'assets', 'studio');
  const rendersDir = path.join(projectRoot, 'renders');
  await fs.mkdir(studioDir, { recursive: true });
  await fs.mkdir(rendersDir, { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'assets'), { recursive: true });

  const muxed = await muxOverlayWebm();
  const firstFrame = path.join(OVERLAY_PNG_DIR, '000000.png');
  const midFrame = path.join(OVERLAY_PNG_DIR, namesAt(muxed.frames, 0.4));
  const alphaFirst = await measurePngAlpha(firstFrame);
  const alphaMid = await measurePngAlpha(midFrame);
  const overlayProbe = await probe(OVERLAY_WEBM);

  const backPath = path.join(studioDir, 'studio_back.png');
  const screenPath = path.join(studioDir, 'screen.png');
  const deskPath = path.join(studioDir, 'studio_desk.png');
  const overlayPath = path.join(projectRoot, 'assets', 'mc-overlay.webm');
  const presenterPath = path.join(projectRoot, 'assets', 'heygen-presenter.webm');
  const audioPath = path.join(projectRoot, 'assets', 'narration.mp3');

  await sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 3, background: { r: 12, g: 32, b: 74 } }
  }).png().toFile(backPath);

  await sharp({
    create: { width: 1280, height: 720, channels: 3, background: { r: 232, g: 196, b: 48 } }
  }).png().toFile(screenPath);

  const deskPixels = Buffer.alloc(WIDTH * HEIGHT * 4, 0);
  for (let y = 820; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * 4;
      deskPixels[i] = 48;
      deskPixels[i + 1] = 28;
      deskPixels[i + 2] = 18;
      deskPixels[i + 3] = 255;
    }
  }
  await sharp(deskPixels, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toFile(deskPath);

  await fs.copyFile(OVERLAY_WEBM, overlayPath);
  await fs.copyFile(path.resolve(SOURCE_WEBM), presenterPath);
  await fs.copyFile(path.resolve(SOURCE_AUDIO), audioPath);

  const composition = createStudioComposition({
    backgroundAssetId: 'studio_back',
    backgroundLocalPath: 'assets/studio/studio_back.png',
    imageAssetId: 'screen',
    imageLocalPath: 'assets/studio/screen.png',
    foregroundAssetId: 'studio_desk',
    foregroundLocalPath: 'assets/studio/studio_desk.png',
    presenterMode: 'pip',
    presenterScale: 0.5,
    presenterOffsetX: 100,
    presenterOffsetY: 0,
    overlayAssetId: 'mc-overlay',
    overlayLocalPath: 'assets/mc-overlay.webm',
    overlayStartSeconds: 0.2,
    overlayDurationSeconds: 4
  });

  const scene: Scene = {
    id: 'scene-studio-overlay',
    order: 1,
    duration: DURATION,
    type: 'blank',
    visual: { kind: 'blank' },
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    composition,
    narration: {
      text: 'P102.2 Motion Canvas overlay proof.',
      audioAssetId: 'narration',
      voiceId: 'p40.2-existing'
    },
    referenceIds: [],
    notes: 'P102.2 composition overlay E2E'
  };

  const project: Project = {
    id: PROJECT_ID,
    title: 'P102.2 studio overlay E2E',
    description: 'Composite an original Motion Canvas alpha overlay on the studio compositor.',
    durationTarget: DURATION,
    aspectRatio: '16:9',
    fps: FPS,
    createdAt: NOW,
    updatedAt: NOW,
    narration: { text: '', segments: [] },
    scenes: [scene],
    assets: [
      asset('studio_back', { localPath: 'assets/studio/studio_back.png' }),
      asset('screen', { localPath: 'assets/studio/screen.png' }),
      asset('studio_desk', { localPath: 'assets/studio/studio_desk.png' }),
      asset('mc-overlay', {
        type: 'video',
        filename: 'mc-overlay.webm',
        localPath: 'assets/mc-overlay.webm',
        mimeType: 'video/webm'
      }),
      asset('heygen-presenter', {
        type: 'video',
        filename: 'heygen-presenter.webm',
        localPath: 'assets/heygen-presenter.webm',
        mimeType: 'video/webm'
      }),
      asset('narration', {
        type: 'audio',
        filename: 'narration.mp3',
        localPath: 'assets/narration.mp3',
        mimeType: 'audio/mpeg'
      })
    ],
    references: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      background: { type: 'color', value: '#070b10' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: false
    },
    presenter: {
      enabled: true,
      provider: 'heygen',
      outputFormat: 'webm',
      sceneSettings: [{ sceneId: scene.id, layout: 'fullscreen' }]
    },
    presenterClips: [
      {
        sceneId: scene.id,
        status: 'generated',
        provider: 'heygen',
        outputFormat: 'webm',
        audioAssetId: 'narration',
        narrationSignature: 'p102.2-e2e',
        duration: 3.51628,
        assetId: 'heygen-presenter'
      }
    ]
  };

  const plan = resolveRenderPlan(project);
  if (!plan.ready) {
    console.error(JSON.stringify(plan.issues, null, 2));
    throw new Error('Render plan is not ready');
  }
  if (!plan.scenes[0].composition?.layers.some((layer) => layer.type === 'overlay' && layer.enabled)) {
    throw new Error('Overlay layer was not resolved onto the RenderPlan');
  }

  const outputPath = path.join(rendersDir, 'p102.2-studio-overlay.mp4');
  const frameDuring = path.join(rendersDir, 'p102.2-studio-overlay-during.png');
  const frameAfter = path.join(rendersDir, 'p102.2-studio-overlay-after.png');
  const renderer = new LocalFFmpegRenderer(runtime);
  const result = await renderer.render(plan, {
    projectId: PROJECT_ID,
    sceneId: scene.id,
    renderId: 'render-p1022-e2e',
    outputPath,
    tempDir: path.join(rendersDir, 'tmp-p1022-e2e'),
    sceneWidth: WIDTH,
    sceneHeight: HEIGHT,
    sceneFps: FPS
  });

  const info = await probe(outputPath);
  const video = info.streams.find((stream) => stream.codec_type === 'video');
  await extractFrame(outputPath, frameDuring, 1.4);
  await extractFrame(outputPath, frameAfter, 4.7);

  const overlayX = Math.round(STUDIO_OVERLAY_RECT.x + STUDIO_OVERLAY_RECT.width / 2);
  const overlayY = Math.round(STUDIO_OVERLAY_RECT.y + STUDIO_OVERLAY_RECT.height / 2);
  const background = await samplePixel(outputPath, 40, 40, 1.4);
  const screen = await samplePixel(
    outputPath,
    Math.round(STUDIO_BIGSCREEN_RECT.x + STUDIO_BIGSCREEN_RECT.width / 2),
    Math.round(STUDIO_BIGSCREEN_RECT.y + 80),
    1.4
  );
  const overlayDuring = await samplePixel(outputPath, overlayX, overlayY, 1.4);
  const overlayAfter = await samplePixel(outputPath, overlayX, overlayY, 4.7);
  const overlayBefore = await samplePixel(outputPath, overlayX, overlayY, 0.05);
  const desk = await samplePixel(outputPath, 960, 1000, 1.4);
  const presenter = await samplePixel(outputPath, 400, 700, 1.4);

  const overlayStream = overlayProbe.streams.find((stream) => stream.codec_type === 'video');
  const report = {
    outputPath: path.relative(process.cwd(), outputPath),
    frameDuring: path.relative(process.cwd(), frameDuring),
    frameAfter: path.relative(process.cwd(), frameAfter),
    overlayAsset: {
      pngDir: path.relative(process.cwd(), OVERLAY_PNG_DIR),
      webm: path.relative(process.cwd(), OVERLAY_WEBM),
      frames: muxed.frames,
      alphaFirst,
      alphaMid,
      probe: {
        codec: overlayStream?.codec_name,
        pixFmt: overlayStream?.pix_fmt,
        width: overlayStream?.width,
        height: overlayStream?.height,
        duration: overlayProbe.format.duration,
        alphaMode: overlayStream?.tags?.alpha_mode ?? overlayStream?.tags?.ALPHA_MODE
      }
    },
    result: {
      status: result.status,
      width: result.width,
      height: result.height,
      fps: result.fps,
      duration: result.duration,
      filesize: result.filesize,
      mimeType: result.mimeType,
      renderer: result.renderer
    },
    probe: {
      format: info.format.format_name,
      duration: info.format.duration,
      size: info.format.size,
      codec: video?.codec_name,
      width: video?.width,
      height: video?.height,
      pixFmt: video?.pix_fmt,
      frameRate: video?.r_frame_rate
    },
    composition: {
      canvas: plan.scenes[0].composition.canvas,
      layers: plan.scenes[0].composition.layers.map((layer) => ({
        id: layer.id,
        type: layer.type,
        enabled: layer.enabled,
        zIndex: layer.zIndex,
        rect: layer.rect,
        assetPath: layer.assetPath,
        mediaKind: layer.mediaKind,
        startSeconds: layer.startSeconds,
        durationSeconds: layer.durationSeconds
      }))
    },
    pixels: { background, screen, presenter, desk, overlayBefore, overlayDuring, overlayAfter },
    notes: [
      'Studio stills were generated in-project; operator studio_back.png / studio_desk.png were not in the workspace.',
      'Presenter clip is the real P100.7j HeyGen Avatar III WebM.',
      'Overlay is original Motion Canvas character Nix, RGBA PNG muxed to VP9/WebM with alpha.',
      `Overlay rect is ${STUDIO_OVERLAY_RECT.x},${STUDIO_OVERLAY_RECT.y} ${STUDIO_OVERLAY_RECT.width}x${STUDIO_OVERLAY_RECT.height}, z-index 25 under desk.`,
      'Overlay starts at 0.2s, plays 4s, then disappears without freeze or loop.'
    ]
  };

  const reportPath = path.join(rendersDir, 'p102.2-studio-overlay-report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

function namesAt(frameCount: number, ratio: number): string {
  const index = Math.min(frameCount - 1, Math.max(0, Math.round((frameCount - 1) * ratio)));
  return `${String(index).padStart(6, '0')}.png`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
