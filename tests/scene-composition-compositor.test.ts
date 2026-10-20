import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runFfmpeg, runProcess } from '@/lib/render/ffmpeg-executor';
import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';
import { LocalFFmpegRenderer, SceneRenderError } from '@/lib/render/renderer';
import {
  buildCompositionLayerFilters,
  buildLayerScaleFilter,
  resolveSafeProjectAssetPath
} from '@/lib/render/scene-composition-compositor';
import { createStudioComposition, STUDIO_BIGSCREEN_RECT } from '@/lib/render/scene-composition';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import type { Asset } from '@/lib/types/asset';
import type { Project, RenderPlan, RenderPlanCompositionLayer } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';

const WIDTH = 320;
const HEIGHT = 180;
const FPS = 30;
const DURATION = 1;
const NOW = '2026-10-20T00:00:00.000Z';
const runtime = createFFmpegRuntime();

let tempRoot = '';
let originalCwd = '';
let projectRoot = '';
let backPath = '';
let screenPath = '';
let deskPath = '';
let alphaClip = '';
let opaqueMp4 = '';

async function ffmpeg(args: string[]): Promise<void> {
  await runFfmpeg(runtime.ffmpegPath, args, { timeoutMs: 90_000 }, 'scene_render');
}

async function samplePixel(filePath: string, x: number, y: number, time = 0.4): Promise<[number, number, number]> {
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

async function probe(filePath: string) {
  const result = await runProcess(runtime.ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=format_name:stream=codec_type,codec_name,width,height,pix_fmt',
    '-of',
    'json',
    filePath
  ]);
  return JSON.parse(result.stdout) as {
    format: { format_name?: string };
    streams: Array<{ codec_type: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string }>;
  };
}

function makeAsset(id: string, overrides: Partial<Asset> = {}): Asset {
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

function makeScene(composition: Scene['composition'], overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    order: 1,
    duration: DURATION,
    type: 'blank',
    visual: { kind: 'blank' },
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    composition,
    referenceIds: [],
    notes: '',
    ...overrides
  };
}

function makeProject(scenes: Scene[], extraAssets: Asset[] = []): Project {
  return {
    id: 'project-comp-render',
    title: 'Composition Render',
    description: 'desc',
    durationTarget: DURATION,
    aspectRatio: '16:9',
    fps: FPS,
    createdAt: NOW,
    updatedAt: NOW,
    narration: { text: '', segments: [] },
    scenes,
    assets: [
      makeAsset('studio_back', { localPath: 'assets/studio/studio_back.png' }),
      makeAsset('studio_desk', { localPath: 'assets/studio/studio_desk.png' }),
      makeAsset('screen', { localPath: 'assets/studio/screen.png' }),
      ...extraAssets
    ],
    references: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      background: { type: 'color', value: '#070b10' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    }
  };
}

async function renderPlan(plan: RenderPlan, name: string) {
  const outputPath = path.join(tempRoot, `${name}.mp4`);
  const renderer = new LocalFFmpegRenderer();
  const result = await renderer.render(plan, {
    projectId: plan.projectId,
    sceneId: plan.scenes[0].sceneId,
    renderId: `render-${name}`,
    outputPath,
    tempDir: path.join(tempRoot, `tmp-${name}`),
    sceneWidth: plan.width,
    sceneHeight: plan.height,
    sceneFps: plan.fps
  });
  return { result, outputPath };
}

beforeAll(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-comp-'));
  process.chdir(tempRoot);
  projectRoot = getProjectRoot('project-comp-render');
  await fs.mkdir(path.join(projectRoot, 'assets', 'studio'), { recursive: true });

  backPath = path.join(projectRoot, 'assets', 'studio', 'studio_back.png');
  screenPath = path.join(projectRoot, 'assets', 'studio', 'screen.png');
  deskPath = path.join(projectRoot, 'assets', 'studio', 'studio_desk.png');

  await sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 0, g: 0, b: 180, alpha: 1 } }
  }).png().toFile(backPath);
  await sharp({
    create: { width: 160, height: 90, channels: 4, background: { r: 0, g: 220, b: 0, alpha: 1 } }
  }).png().toFile(screenPath);
  const desk = Buffer.alloc(WIDTH * HEIGHT * 4, 0);
  for (let y = Math.floor(HEIGHT * 0.72); y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * 4;
      desk[i] = 40;
      desk[i + 1] = 20;
      desk[i + 2] = 10;
      desk[i + 3] = 255;
    }
  }
  await sharp(desk, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toFile(deskPath);

  alphaClip = path.join(projectRoot, 'assets', 'presenter-alpha.webm');
  await ffmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=red:s=160x90:r=${FPS}:d=${DURATION}`,
    '-f',
    'lavfi',
    '-i',
    `color=c=white:s=160x90:r=${FPS}:d=${DURATION}`,
    '-filter_complex',
    "[1]geq=lum='if(lt(hypot(X-W/2,Y-H/2),H*0.32),255,0)':cb=128:cr=128,format=gray[a];[0][a]alphamerge,format=yuva420p",
    '-an',
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-auto-alt-ref',
    '0',
    '-t',
    String(DURATION),
    alphaClip
  ]);

  opaqueMp4 = path.join(projectRoot, 'assets', 'presenter-opaque.mp4');
  await ffmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=red:s=160x90:r=${FPS}:d=${DURATION}`,
    '-t',
    String(DURATION),
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
  process.chdir(originalCwd);
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('composition compositor helpers', () => {
  it('builds contain and cover scale filters', () => {
    expect(buildLayerScaleFilter({ x: 10, y: 20, width: 100, height: 50 }, 'contain', true)).toContain('force_original_aspect_ratio=decrease');
    expect(buildLayerScaleFilter({ x: 10, y: 20, width: 100, height: 50 }, 'cover', false)).toContain('force_original_aspect_ratio=increase');
  });

  it('orders overlays by input index and uses format=auto', () => {
    const layers: RenderPlanCompositionLayer[] = [
      {
        id: 'back',
        type: 'background',
        enabled: true,
        zIndex: 0,
        rect: { x: 0, y: 0, width: 320, height: 180 },
        fit: 'cover',
        assetPath: 'assets/studio/studio_back.png',
        mediaKind: 'image'
      },
      {
        id: 'screen',
        type: 'image',
        enabled: true,
        zIndex: 10,
        rect: { x: 40, y: 20, width: 200, height: 110 },
        fit: 'contain',
        assetPath: 'assets/studio/screen.png',
        mediaKind: 'image'
      },
      {
        id: 'presenter',
        type: 'presenter',
        enabled: true,
        zIndex: 20,
        rect: { x: 0, y: 0, width: 320, height: 180 },
        fit: 'contain',
        assetPath: 'assets/presenter-alpha.webm',
        mediaKind: 'video',
        mode: 'full_canvas'
      },
      {
        id: 'desk',
        type: 'foreground',
        enabled: true,
        zIndex: 30,
        rect: { x: 0, y: 0, width: 320, height: 180 },
        fit: 'cover',
        assetPath: 'assets/studio/studio_desk.png',
        mediaKind: 'image'
      }
    ];
    const filters = buildCompositionLayerFilters({
      layers: layers.map((layer, index) => ({ index: index + 1, layer, path: layer.assetPath ?? '' })),
      fps: 30,
      duration: 1
    }).join(';');
    expect(filters).toContain('overlay=x=40:y=20');
    expect(filters).toContain('eof_action=pass:format=auto');
    expect(filters.indexOf('[1:v]')).toBeLessThan(filters.indexOf('[2:v]'));
    expect(filters.indexOf('[3:v]')).toBeLessThan(filters.indexOf('[4:v]'));
  });

  it('overlays a 50% presenter PiP from the bottom-left with a 100px left offset', () => {
    const composition = createStudioComposition({ presenterMode: 'pip' });
    const presenter = composition.layers.find((layer) => layer.type === 'presenter');
    expect(presenter).toMatchObject({
      mode: 'pip',
      scale: 0.5,
      offsetX: 100,
      offsetY: 0,
      zIndex: 20,
      rect: { x: 100, y: 540, width: 960, height: 540 }
    });
    expect(composition.layers.find((layer) => layer.type === 'image')?.rect).toEqual(STUDIO_BIGSCREEN_RECT);
    expect(composition.layers.find((layer) => layer.type === 'foreground')?.zIndex).toBe(30);

    const layer: RenderPlanCompositionLayer = {
      id: 'studio-presenter',
      type: 'presenter',
      enabled: true,
      zIndex: 20,
      rect: { x: 100, y: 540, width: 960, height: 540 },
      fit: 'contain',
      assetPath: 'assets/presenter-alpha.webm',
      mediaKind: 'video',
      mode: 'pip'
    };
    const filters = buildCompositionLayerFilters({
      layers: [{ index: 1, layer, path: layer.assetPath ?? '' }],
      fps: 30,
      duration: 1
    }).join(';');
    expect(filters).toContain('scale=960:540:force_original_aspect_ratio=decrease');
    expect(filters).toContain('overlay=x=100:y=540:eof_action=pass:format=auto:alpha=straight');
  });

  it('rejects absolute and traversal asset paths', () => {
    expect(() => resolveSafeProjectAssetPath('project-comp-render', '../secret.png')).toThrow(/Unsafe/);
    expect(() => resolveSafeProjectAssetPath('project-comp-render', '/tmp/secret.png')).toThrow(/Unsafe/);
  });
});

describe('composition scene renderer', () => {
  it('leaves scenes without composition on the historical blank path', async () => {
    const project = makeProject([makeScene(undefined)]);
    const plan = resolveRenderPlan(project);
    expect(plan.scenes[0].composition).toBeUndefined();
    const { result, outputPath } = await renderPlan(plan, 'legacy-blank');
    expect(result.status).toBe('completed');
    const info = await probe(outputPath);
    const video = info.streams.find((stream) => stream.codec_type === 'video');
    expect(video?.codec_name).toBe('h264');
    expect(video?.pix_fmt).toBe('yuv420p');
  }, 120_000);

  it('composites background, bigscreen, full-canvas alpha presenter and desk', async () => {
    const composition = createStudioComposition({
      canvas: { width: WIDTH, height: HEIGHT },
      backgroundAssetId: 'studio_back',
      backgroundLocalPath: 'assets/studio/studio_back.png',
      imageAssetId: 'screen',
      imageLocalPath: 'assets/studio/screen.png',
      foregroundAssetId: 'studio_desk',
      foregroundLocalPath: 'assets/studio/studio_desk.png',
      presenterMode: 'full_canvas'
    });
    composition.layers[1].rect = { x: 48, y: 24, width: 180, height: 100 };
    const project = makeProject(
      [makeScene(composition)],
      [
        makeAsset('presenter-1', {
          type: 'video',
          filename: 'presenter-alpha.webm',
          localPath: 'assets/presenter-alpha.webm',
          mimeType: 'video/webm'
        })
      ]
    );
    project.presenterClips = [
      {
        sceneId: 'scene-1',
        status: 'generated',
        provider: 'mock',
        outputFormat: 'webm',
        audioAssetId: '',
        narrationSignature: '',
        duration: DURATION,
        assetId: 'presenter-1'
      }
    ];

    const plan = resolveRenderPlan(project);
    const { result, outputPath } = await renderPlan(plan, 'studio-full');
    expect(result.status).toBe('completed');
    const info = await probe(outputPath);
    const video = info.streams.find((stream) => stream.codec_type === 'video');
    expect(video).toMatchObject({ codec_name: 'h264', width: WIDTH, height: HEIGHT, pix_fmt: 'yuv420p' });

    const corner = await samplePixel(outputPath, 8, 8);
    const screen = await samplePixel(outputPath, 90, 50);
    const avatar = await samplePixel(outputPath, 160, 70);
    const desk = await samplePixel(outputPath, 160, 160);
    expect(corner[2]).toBeGreaterThan(120);
    expect(screen[1]).toBeGreaterThan(120);
    expect(avatar[0]).toBeGreaterThan(140);
    expect(desk[0]).toBeLessThan(80);
    expect(desk[1]).toBeLessThan(60);
  }, 120_000);

  it('places a 50% bottom-left presenter PiP without covering the sampled background', async () => {
    const composition = createStudioComposition({
      canvas: { width: WIDTH, height: HEIGHT },
      backgroundAssetId: 'studio_back',
      backgroundLocalPath: 'assets/studio/studio_back.png',
      presenterMode: 'pip',
      presenterScale: 0.5,
      presenterOffsetX: 100,
      presenterOffsetY: 0,
      deskEnabled: false,
      bigscreenEnabled: false
    });
    const project = makeProject(
      [makeScene(composition)],
      [
        makeAsset('presenter-1', {
          type: 'video',
          filename: 'presenter-alpha.webm',
          localPath: 'assets/presenter-alpha.webm',
          mimeType: 'video/webm'
        })
      ]
    );
    project.presenterClips = [
      {
        sceneId: 'scene-1',
        status: 'generated',
        provider: 'mock',
        outputFormat: 'webm',
        audioAssetId: '',
        narrationSignature: '',
        duration: DURATION,
        assetId: 'presenter-1'
      }
    ];
    const plan = resolveRenderPlan(project);
    expect(plan.scenes[0].composition?.layers.find((layer) => layer.type === 'presenter')?.rect).toEqual({
      x: 100,
      y: 90,
      width: 160,
      height: 90
    });
    const { outputPath } = await renderPlan(plan, 'studio-pip-bottom-left');
    const pip = await samplePixel(outputPath, 180, 135);
    const outside = await samplePixel(outputPath, 20, 20);
    expect(pip[0]).toBeGreaterThan(140);
    expect(outside[2]).toBeGreaterThan(120);
  }, 120_000);

  it('places a PiP presenter using explicit pixel geometry', async () => {
    const composition = createStudioComposition({
      canvas: { width: WIDTH, height: HEIGHT },
      backgroundAssetId: 'studio_back',
      backgroundLocalPath: 'assets/studio/studio_back.png',
      imageAssetId: 'screen',
      imageLocalPath: 'assets/studio/screen.png',
      foregroundAssetId: 'studio_desk',
      foregroundLocalPath: 'assets/studio/studio_desk.png',
      presenterMode: 'pip',
      pipPreset: 'news',
      deskEnabled: false,
      bigscreenEnabled: false
    });
    composition.layers = composition.layers.map((layer) => (
      layer.type === 'presenter' ? { ...layer, rect: { x: 220, y: 20, width: 80, height: 45 } } : layer
    ));
    const project = makeProject(
      [makeScene(composition)],
      [
        makeAsset('presenter-1', {
          type: 'video',
          filename: 'presenter-alpha.webm',
          localPath: 'assets/presenter-alpha.webm',
          mimeType: 'video/webm'
        })
      ]
    );
    project.presenterClips = [
      {
        sceneId: 'scene-1',
        status: 'generated',
        provider: 'mock',
        outputFormat: 'webm',
        audioAssetId: '',
        narrationSignature: '',
        duration: DURATION,
        assetId: 'presenter-1'
      }
    ];
    const plan = resolveRenderPlan(project);
    const { outputPath } = await renderPlan(plan, 'studio-pip');
    const pip = await samplePixel(outputPath, 250, 35);
    const outside = await samplePixel(outputPath, 20, 20);
    expect(pip[0]).toBeGreaterThan(140);
    expect(outside[2]).toBeGreaterThan(120);
  }, 120_000);

  it('keeps the historical opaque MP4 presenter route rectangular', async () => {
    const composition = createStudioComposition({
      canvas: { width: WIDTH, height: HEIGHT },
      backgroundAssetId: 'studio_back',
      backgroundLocalPath: 'assets/studio/studio_back.png',
      deskEnabled: false,
      bigscreenEnabled: false,
      presenterMode: 'full_canvas'
    });
    const project = makeProject(
      [makeScene(composition)],
      [
        makeAsset('presenter-1', {
          type: 'video',
          filename: 'presenter-opaque.mp4',
          localPath: 'assets/presenter-opaque.mp4',
          mimeType: 'video/mp4'
        })
      ]
    );
    project.presenterClips = [
      {
        sceneId: 'scene-1',
        status: 'generated',
        provider: 'mock',
        outputFormat: 'mp4',
        audioAssetId: '',
        narrationSignature: '',
        duration: DURATION,
        assetId: 'presenter-1'
      }
    ];
    const plan = resolveRenderPlan(project);
    const { outputPath } = await renderPlan(plan, 'opaque-mp4');
    const center = await samplePixel(outputPath, 160, 90);
    expect(center[0]).toBeGreaterThan(140);
  }, 120_000);

  it('fails closed on a missing composition asset file', async () => {
    const composition = createStudioComposition({
      canvas: { width: WIDTH, height: HEIGHT },
      backgroundLocalPath: 'assets/studio/missing.png',
      deskEnabled: false,
      bigscreenEnabled: false
    });
    composition.layers = composition.layers.filter((layer) => layer.type !== 'presenter');
    const project = makeProject([makeScene(composition)]);
    const plan = resolveRenderPlan(project);
    await expect(renderPlan(plan, 'missing-asset')).rejects.toMatchObject({
      code: 'MISSING_ASSET'
    } satisfies Partial<SceneRenderError>);
  }, 60_000);

  it('exposes the authored studio bigscreen rect', () => {
    expect(STUDIO_BIGSCREEN_RECT).toEqual({ x: 293, y: 98, width: 1346, height: 761 });
  });
});
