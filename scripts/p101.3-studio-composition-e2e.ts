/**
 * P101.3 studio composition proof.
 *
 * Renders one 1920x1080 H.264 scene through LocalFFmpegRenderer + resolveRenderPlan
 * using the production composition compositor. Studio stills are generated locally
 * because studio_back.png / studio_desk.png are not present in this workspace.
 * The presenter clip is the real P100.7j HeyGen Avatar III WebM.
 *
 * Usage:
 *   npx tsx scripts/p101.3-studio-composition-e2e.ts
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { runFfmpeg, runProcess } from '../lib/render/ffmpeg-executor';
import { createFFmpegRuntime } from '../lib/render/ffmpeg-runtime';
import { LocalFFmpegRenderer } from '../lib/render/renderer';
import { createStudioComposition, STUDIO_BIGSCREEN_RECT } from '../lib/render/scene-composition';
import { resolveRenderPlan } from '../lib/render/scene-resolver';
import { getProjectRoot } from '../lib/storage/storage-paths';
import type { Asset } from '../lib/types/asset';
import type { Project } from '../lib/types/render';
import type { Scene } from '../lib/types/scene';

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const DURATION = 3.6;
const PROJECT_ID = 'project_p1013_studio_e2e';
const NOW = new Date().toISOString();
const SOURCE_WEBM =
  'projects/project_7b983d8d-8e90-4f6f-bca0-925f2996d9ce/assets/scene-01-presenter-presenter_attempt_e2e34b6c-c57b-4c5b-8f09-d0260f5fc73f.webm';
const SOURCE_AUDIO =
  'projects/project_7b983d8d-8e90-4f6f-bca0-925f2996d9ce/assets/asset_e34db47d-63c7-48fc-bffc-807dbf2ac2cd-narration.mp3';

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
    'format=duration,format_name,size:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate',
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
    }>;
  };
}

async function samplePixel(filePath: string, x: number, y: number, time = 1.2): Promise<[number, number, number]> {
  const output = path.join(path.dirname(filePath), `pixel-${x}-${y}.rgb`);
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
  const projectRoot = getProjectRoot(PROJECT_ID);
  const studioDir = path.join(projectRoot, 'assets', 'studio');
  const rendersDir = path.join(projectRoot, 'renders');
  await fs.mkdir(studioDir, { recursive: true });
  await fs.mkdir(rendersDir, { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'assets'), { recursive: true });

  const backPath = path.join(studioDir, 'studio_back.png');
  const screenPath = path.join(studioDir, 'screen.png');
  const deskPath = path.join(studioDir, 'studio_desk.png');
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

  await fs.copyFile(path.resolve(SOURCE_WEBM), presenterPath);
  await fs.copyFile(path.resolve(SOURCE_AUDIO), audioPath);

  const composition = createStudioComposition({
    backgroundAssetId: 'studio_back',
    backgroundLocalPath: 'assets/studio/studio_back.png',
    imageAssetId: 'screen',
    imageLocalPath: 'assets/studio/screen.png',
    foregroundAssetId: 'studio_desk',
    foregroundLocalPath: 'assets/studio/studio_desk.png',
    presenterMode: 'full_canvas'
  });

  const scene: Scene = {
    id: 'scene-studio-e2e',
    order: 1,
    duration: DURATION,
    type: 'blank',
    visual: { kind: 'blank' },
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    composition,
    narration: {
      text: 'P101.3 studio composition proof.',
      audioAssetId: 'narration',
      voiceId: 'p40.2-existing'
    },
    referenceIds: [],
    notes: 'P101.3 composition E2E'
  };

  const project: Project = {
    id: PROJECT_ID,
    title: 'P101.3 studio composition E2E',
    description: 'Execute optional scene.composition on the production RenderPlan/FFmpeg path.',
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
        narrationSignature: 'p101.3-e2e',
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
  if (!plan.scenes[0].composition) {
    throw new Error('Composition was not resolved onto the RenderPlan');
  }

  const outputPath = path.join(rendersDir, 'p101.3-studio-composition.mp4');
  const framePath = path.join(rendersDir, 'p101.3-studio-composition-frame.png');
  const renderer = new LocalFFmpegRenderer(runtime);
  const result = await renderer.render(plan, {
    projectId: PROJECT_ID,
    sceneId: scene.id,
    renderId: 'render-p1013-e2e',
    outputPath,
    tempDir: path.join(rendersDir, 'tmp-p1013-e2e'),
    sceneWidth: WIDTH,
    sceneHeight: HEIGHT,
    sceneFps: FPS
  });

  const info = await probe(outputPath);
  const video = info.streams.find((stream) => stream.codec_type === 'video');
  await extractFrame(outputPath, framePath);

  const background = await samplePixel(outputPath, 40, 40);
  const screen = await samplePixel(
    outputPath,
    Math.round(STUDIO_BIGSCREEN_RECT.x + STUDIO_BIGSCREEN_RECT.width / 2),
    Math.round(STUDIO_BIGSCREEN_RECT.y + 80)
  );
  const desk = await samplePixel(outputPath, 960, 1000);
  const presenter = await samplePixel(outputPath, 960, 540);

  const report = {
    outputPath: path.relative(process.cwd(), outputPath),
    framePath: path.relative(process.cwd(), framePath),
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
        mediaKind: layer.mediaKind
      }))
    },
    pixels: { background, screen, presenter, desk },
    notes: [
      'Studio stills were generated in-project; operator studio_back.png / studio_desk.png were not in the workspace.',
      'Presenter clip is the real P100.7j HeyGen Avatar III WebM.',
      'Bigscreen rect is 293,98 1346x761.'
    ]
  };

  const reportPath = path.join(rendersDir, 'p101.3-studio-composition-report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
