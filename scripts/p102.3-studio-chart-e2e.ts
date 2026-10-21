/**
 * P102.3 studio Motion Canvas bigscreen chart proof.
 *
 * Composites an original Motion Canvas chart as opaque bigscreen content on
 * the production studio FFmpeg compositor, together with presenter PiP, Nix
 * overlay, background and desk.
 *
 * Usage:
 *   npx tsx scripts/p102.3-studio-chart-e2e.ts
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
const PROJECT_ID = 'project_p1023_studio_chart';
const NOW = new Date().toISOString();
const SOURCE_WEBM =
  'projects/project_7b983d8d-8e90-4f6f-bca0-925f2996d9ce/assets/scene-01-presenter-presenter_attempt_e2e34b6c-c57b-4c5b-8f09-d0260f5fc73f.webm';
const SOURCE_AUDIO =
  'projects/project_7b983d8d-8e90-4f6f-bca0-925f2996d9ce/assets/asset_e34db47d-63c7-48fc-bffc-807dbf2ac2cd-narration.mp3';
const OVERLAY_WEBM = path.resolve('motion-canvas/output/p102-2-overlay.webm');
const CHART_MP4 = path.resolve('motion-canvas/output/p102-3-chart.mp4');

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
    'format=duration,format_name,size:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,nb_frames',
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
      nb_frames?: string;
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

async function main(): Promise<void> {
  await fs.access(CHART_MP4);
  await fs.access(OVERLAY_WEBM);

  const projectRoot = getProjectRoot(PROJECT_ID);
  const studioDir = path.join(projectRoot, 'assets', 'studio');
  const rendersDir = path.join(projectRoot, 'renders');
  await fs.mkdir(studioDir, { recursive: true });
  await fs.mkdir(rendersDir, { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'assets'), { recursive: true });

  const chartProbe = await probe(CHART_MP4);
  const overlayProbe = await probe(OVERLAY_WEBM);

  const backPath = path.join(studioDir, 'studio_back.png');
  const deskPath = path.join(studioDir, 'studio_desk.png');
  const chartPath = path.join(projectRoot, 'assets', 'mc-chart.mp4');
  const overlayPath = path.join(projectRoot, 'assets', 'mc-overlay.webm');
  const presenterPath = path.join(projectRoot, 'assets', 'heygen-presenter.webm');
  const audioPath = path.join(projectRoot, 'assets', 'narration.mp3');

  await sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 3, background: { r: 12, g: 32, b: 74 } }
  }).png().toFile(backPath);

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

  await fs.copyFile(CHART_MP4, chartPath);
  await fs.copyFile(OVERLAY_WEBM, overlayPath);
  await fs.copyFile(path.resolve(SOURCE_WEBM), presenterPath);
  await fs.copyFile(path.resolve(SOURCE_AUDIO), audioPath);

  const composition = createStudioComposition({
    backgroundAssetId: 'studio_back',
    backgroundLocalPath: 'assets/studio/studio_back.png',
    imageAssetId: 'mc-chart',
    imageLocalPath: 'assets/mc-chart.mp4',
    imageStartSeconds: 0,
    imageDurationSeconds: 5,
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
    id: 'scene-studio-chart',
    order: 1,
    duration: DURATION,
    type: 'blank',
    visual: { kind: 'blank' },
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    composition,
    narration: {
      text: 'P102.3 Motion Canvas bigscreen chart proof.',
      audioAssetId: 'narration',
      voiceId: 'p40.2-existing'
    },
    referenceIds: [],
    notes: 'P102.3 composition chart E2E'
  };

  const project: Project = {
    id: PROJECT_ID,
    title: 'P102.3 studio chart E2E',
    description: 'Composite an original Motion Canvas chart inside the studio bigscreen.',
    durationTarget: DURATION,
    aspectRatio: '16:9',
    fps: FPS,
    createdAt: NOW,
    updatedAt: NOW,
    narration: { text: '', segments: [] },
    scenes: [scene],
    assets: [
      asset('studio_back', { localPath: 'assets/studio/studio_back.png' }),
      asset('studio_desk', { localPath: 'assets/studio/studio_desk.png' }),
      asset('mc-chart', {
        type: 'video',
        filename: 'mc-chart.mp4',
        localPath: 'assets/mc-chart.mp4',
        mimeType: 'video/mp4'
      }),
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
        narrationSignature: 'p102.3-e2e',
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
  const imageLayer = plan.scenes[0].composition?.layers.find((layer) => layer.type === 'image');
  if (!imageLayer?.enabled || imageLayer.mediaKind !== 'video') {
    throw new Error('Bigscreen video layer was not resolved onto the RenderPlan');
  }

  const outputPath = path.join(rendersDir, 'p102.3-studio-chart.mp4');
  const frameEarly = path.join(rendersDir, 'p102.3-studio-chart-early.png');
  const frameMid = path.join(rendersDir, 'p102.3-studio-chart-mid.png');
  const frameLate = path.join(rendersDir, 'p102.3-studio-chart-late.png');
  const renderer = new LocalFFmpegRenderer(runtime);
  const result = await renderer.render(plan, {
    projectId: PROJECT_ID,
    sceneId: scene.id,
    renderId: 'render-p1023-e2e',
    outputPath,
    tempDir: path.join(rendersDir, 'tmp-p1023-e2e'),
    sceneWidth: WIDTH,
    sceneHeight: HEIGHT,
    sceneFps: FPS
  });

  const info = await probe(outputPath);
  const video = info.streams.find((stream) => stream.codec_type === 'video');
  await extractFrame(outputPath, frameEarly, 0.35);
  await extractFrame(outputPath, frameMid, 2.2);
  await extractFrame(outputPath, frameLate, 4.2);

  const screenX = Math.round(STUDIO_BIGSCREEN_RECT.x + 180);
  const screenY = Math.round(STUDIO_BIGSCREEN_RECT.y + STUDIO_BIGSCREEN_RECT.height - 80);
  const outsideLeft = await samplePixel(outputPath, 40, 40, 2.2);
  const outsideRight = await samplePixel(outputPath, 1900, 40, 2.2);
  const chartEarly = await samplePixel(outputPath, screenX, screenY, 0.35);
  const chartMid = await samplePixel(outputPath, screenX, screenY, 2.2);
  const chartLate = await samplePixel(outputPath, screenX, screenY, 4.2);
  const desk = await samplePixel(outputPath, 960, 1000, 2.2);
  const overlayX = Math.round(STUDIO_OVERLAY_RECT.x + STUDIO_OVERLAY_RECT.width / 2);
  const overlayY = Math.round(STUDIO_OVERLAY_RECT.y + STUDIO_OVERLAY_RECT.height / 2);
  const overlayDuring = await samplePixel(outputPath, overlayX, overlayY, 1.4);
  const overlayAfter = await samplePixel(outputPath, overlayX, overlayY, 4.7);
  const presenter = await samplePixel(outputPath, 400, 700, 1.4);

  const chartStream = chartProbe.streams.find((stream) => stream.codec_type === 'video');
  const overlayStream = overlayProbe.streams.find((stream) => stream.codec_type === 'video');
  const report = {
    outputPath: path.relative(process.cwd(), outputPath),
    frameEarly: path.relative(process.cwd(), frameEarly),
    frameMid: path.relative(process.cwd(), frameMid),
    frameLate: path.relative(process.cwd(), frameLate),
    chartAsset: {
      mp4: path.relative(process.cwd(), CHART_MP4),
      probe: {
        codec: chartStream?.codec_name,
        pixFmt: chartStream?.pix_fmt,
        width: chartStream?.width,
        height: chartStream?.height,
        duration: chartProbe.format.duration,
        frameRate: chartStream?.r_frame_rate
      }
    },
    overlayAsset: {
      webm: path.relative(process.cwd(), OVERLAY_WEBM),
      probe: {
        codec: overlayStream?.codec_name,
        pixFmt: overlayStream?.pix_fmt,
        width: overlayStream?.width,
        height: overlayStream?.height,
        duration: overlayProbe.format.duration
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
      canvas: plan.scenes[0].composition?.canvas,
      layers: plan.scenes[0].composition?.layers.map((layer) => ({
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
    pixels: {
      outsideLeft,
      outsideRight,
      chartEarly,
      chartMid,
      chartLate,
      presenter,
      desk,
      overlayDuring,
      overlayAfter
    },
    notes: [
      'Studio stills were generated in-project; operator studio_back.png / studio_desk.png were not in the workspace.',
      'Presenter clip is the real P100.7j HeyGen Avatar III WebM.',
      'Bigscreen content is original Motion Canvas Northwind ARR chart, opaque 1920x1080 H.264.',
      `Bigscreen rect is ${STUDIO_BIGSCREEN_RECT.x},${STUDIO_BIGSCREEN_RECT.y} ${STUDIO_BIGSCREEN_RECT.width}x${STUDIO_BIGSCREEN_RECT.height}.`,
      'Chart starts at 0s, plays 5s, contain-fitted, eof_action=pass:repeatlast=0.',
      'Nix overlay from P102.2 is unchanged: 0.2s start, 4s duration, z-index 25 under desk.'
    ]
  };

  const reportPath = path.join(rendersDir, 'p102.3-studio-chart-report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
