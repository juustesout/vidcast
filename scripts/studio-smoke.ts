/**
 * Local, zero-provider smoke renderer for the reusable news-studio set.
 *
 * It writes sample assets under `.tmp/studio-smoke`, builds an intro / news /
 * outro vertical slice through the normal render plan, renders each scene with
 * the studio overlay, applies a mock presenter PiP to the news scene, and
 * concatenates the result into one prototype MP4:
 *
 *   intro: title card, no presenter
 *   news:  stock image + headline + presenter PiP
 *   outro: closing title card
 *
 * Usage:
 *   npm run smoke:studio
 *
 * No network access and no paid provider calls.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { buildMockPresenterArgs } from '../lib/ai/presenter/fake-provider';
import { createFFmpegRuntime } from '../lib/render/ffmpeg-runtime';
import { runFfmpeg, runProcess } from '../lib/render/ffmpeg-executor';
import { AI_DEV_FORUM_GRAPHIC_STYLE } from '../lib/render/graphic-style';
import { buildPresenterOverlayArgs } from '../lib/render/presenter-overlay';
import { LocalFFmpegRenderer } from '../lib/render/renderer';
import { resolveRenderPlan } from '../lib/render/scene-resolver';
import type { CompositionPlan, RenderPlanScene } from '../lib/types/render';
import type { Asset } from '../lib/types/asset';
import type { Project } from '../lib/types/render';
import type { Scene } from '../lib/types/scene';

const WIDTH = 960;
const HEIGHT = 540;
const FPS = 30;
const OUTPUT_ROOT = path.resolve('.tmp/studio-smoke');
const PROJECT_ID = 'studio-smoke';

const runtime = createFFmpegRuntime();

function nowIso(): string {
  return new Date().toISOString();
}

function imageAsset(id: string, filename: string): Asset {
  return {
    id,
    type: 'image',
    status: 'available',
    provenance: 'imported',
    filename,
    localPath: path.join(OUTPUT_ROOT, filename),
    mimeType: 'image/png',
    metadata: {},
    createdAt: nowIso()
  };
}

function scene(id: string, order: number, duration: number, visual: Scene['visual'], type: Scene['type'], overlay: Scene['overlay']): Scene {
  return {
    id,
    order,
    duration,
    type,
    visual,
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay,
    logo: { assetId: 'logo', position: 'bottom_right', scale: 0.12, margin: 24 },
    referenceIds: [],
    notes: ''
  };
}

async function main(): Promise<void> {
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });

  await sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#0056a7' }
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0056a7"/><stop offset="100%" stop-color="#07121f"/></linearGradient></defs><rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)"/><circle cx="${WIDTH * 0.7}" cy="${HEIGHT * 0.35}" r="${HEIGHT * 0.3}" fill="#0b2c4d"/><circle cx="${WIDTH * 0.35}" cy="${HEIGHT * 0.75}" r="${HEIGHT * 0.22}" fill="#ff5a5f" opacity="0.35"/></svg>`
        )
      }
    ])
    .png()
    .toFile(path.join(OUTPUT_ROOT, 'stock.png'));

  await sharp({
    create: { width: 480, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="480" height="120" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="26" width="10" height="68" rx="4" fill="#ff5a5f"/><text x="24" y="84" fill="#ffffff" font-family="DejaVu Sans, Arial, sans-serif" font-size="52" font-weight="700">AI DEV FORUM</text></svg>`
        )
      }
    ])
    .png()
    .toFile(path.join(OUTPUT_ROOT, 'logo.png'));

  const project: Project = {
    id: PROJECT_ID,
    title: 'Studio Vertical Slice',
    description: 'Local visual inspection fixture for the reusable news studio.',
    durationTarget: 9,
    aspectRatio: '16:9',
    fps: FPS,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    narration: { text: '', segments: [] },
    assets: [imageAsset('stock', 'stock.png'), imageAsset('logo', 'logo.png')],
    references: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      background: { type: 'color', value: '#07121f' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: false,
      graphicStyle: AI_DEV_FORUM_GRAPHIC_STYLE,
      logo: { assetId: 'logo', position: 'bottom_right', scale: 0.12, margin: 28, opacity: 0.9 },
      studio: {
        brand: 'AI DEV FORUM',
        program: 'NEWS',
        accentColor: '#ff5a5f',
        screen: { x: 0.05, y: 0.09, width: 0.64, height: 0.7 }
      }
    },
    scenes: [
      scene(
        'intro',
        1,
        2.5,
        { kind: 'graphic', template: 'title_card', templateData: { title: 'AI NEWS', subtitle: 'Daily AI Dev Forum' } },
        'graphic',
        { type: 'none' }
      ),
      scene('news', 2, 4, { kind: 'asset', assetId: 'stock' }, 'image', {
        type: 'text',
        text: 'Models ship faster than\nteams can evaluate them',
        position: 'bottom',
        style: { fontSize: 32, color: '#ffffff', box: false, margin: 62 }
      }),
      scene(
        'outro',
        3,
        2.5,
        { kind: 'graphic', template: 'title_card', templateData: { title: 'Thanks', subtitle: 'See you next time' } },
        'graphic',
        { type: 'none' }
      )
    ]
  };

  const fullPlan = resolveRenderPlan(project);
  if (!fullPlan.studio) {
    throw new Error('Studio overlay was not resolved.');
  }

  const presenterClip = path.join(OUTPUT_ROOT, 'presenter-mock.mp4');
  await runFfmpeg(runtime.ffmpegPath, buildMockPresenterArgs(presenterClip, 4), { timeoutMs: 120_000 }, 'presenter_generate');

  const renderer = new LocalFFmpegRenderer(runtime);
  const scenePaths: string[] = [];

  for (const scenePlan of fullPlan.scenes) {
    if (scenePlan.status !== 'renderable') {
      throw new Error(`Scene ${scenePlan.sceneId} is not renderable: ${scenePlan.issues.map((issue) => issue.message).join('; ')}`);
    }

    const scenePath = path.join(OUTPUT_ROOT, `${scenePlan.sceneId}.mp4`);
    await renderer.render(
      { ...fullPlan, ready: true, scenes: [scenePlan] },
      {
        projectId: PROJECT_ID,
        sceneId: scenePlan.sceneId,
        renderId: `smoke-${scenePlan.sceneId}`,
        outputPath: scenePath,
        tempDir: path.join(OUTPUT_ROOT, `tmp-${scenePlan.sceneId}`),
        sceneWidth: WIDTH,
        sceneHeight: HEIGHT,
        sceneFps: FPS
      }
    );

    let finalScenePath = scenePath;
    if (scenePlan.sceneId === 'news') {
      const plan: CompositionPlan = {
        projectId: PROJECT_ID,
        items: [],
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        totalDuration: scenePlan.duration,
        transition: { type: 'none' },
        presenter: {
          placements: [
            {
              sceneId: scenePlan.sceneId,
              clipPath: presenterClip,
              clipDuration: 4,
              startTime: 0,
              duration: scenePlan.duration,
              layout: 'pip',
              startOffsetSeconds: 0,
              pip: { position: 'top_right', widthRatio: 0.21, marginRatio: 0.06 }
            }
          ]
        }
      };
      finalScenePath = path.join(OUTPUT_ROOT, 'news-with-presenter.mp4');
      await runFfmpeg(runtime.ffmpegPath, buildPresenterOverlayArgs(scenePath, finalScenePath, plan), { timeoutMs: 180_000 }, 'scene_render');
    }

    const framePath = path.join(OUTPUT_ROOT, `${scenePlan.sceneId}.png`);
    await runProcess(runtime.ffmpegPath, [
      '-y',
      '-ss',
      String(scenePlan.duration * 0.6),
      '-i',
      finalScenePath,
      '-frames:v',
      '1',
      framePath
    ]);
    scenePaths.push(finalScenePath);
    console.log(`${scenePlan.sceneId}: ${scenePlan.duration}s -> ${finalScenePath}`);
  }

  const concatList = path.join(OUTPUT_ROOT, 'scenes.txt');
  await fs.writeFile(concatList, scenePaths.map((scenePath) => `file '${scenePath}'`).join('\n'), 'utf8');
  const finalPath = path.join(OUTPUT_ROOT, 'studio-prototype.mp4');
  await runFfmpeg(
    runtime.ffmpegPath,
    ['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', '-movflags', '+faststart', finalPath],
    { timeoutMs: 120_000 },
    'scene_render'
  );

  console.log(`\nPrototype: ${finalPath}`);
  console.log(`Frames: ${path.join(OUTPUT_ROOT, 'intro.png')}, news.png, outro.png`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
