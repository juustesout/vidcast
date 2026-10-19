/**
 * Local, zero-provider smoke renderer for per-scene logo overlays.
 *
 * It writes sample assets under `.tmp/logo-overlay-smoke`, builds a project
 * with three scenes, resolves the render plan through the normal resolver and
 * renders one MP4 plus one PNG frame per scene:
 *
 *   scene-1: graphic statistic card + green logo (top-left)
 *   scene-2: stock-style image        + the SAME green logo (top-left)
 *   scene-3: graphic title card       + a DIFFERENT blue logo (bottom-right)
 *
 * Usage:
 *   npm run smoke:logo
 *
 * No network access and no paid provider calls. Inspector commands are printed
 * at the end.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { runProcess } from '../lib/render/ffmpeg-executor';
import { createFFmpegRuntime } from '../lib/render/ffmpeg-runtime';
import { LocalFFmpegRenderer } from '../lib/render/renderer';
import { resolveRenderPlan } from '../lib/render/scene-resolver';
import { AI_DEV_FORUM_GRAPHIC_STYLE } from '../lib/render/graphic-style';
import type { Asset } from '../lib/types/asset';
import type { Project } from '../lib/types/render';
import type { Scene } from '../lib/types/scene';

const WIDTH = 640;
const HEIGHT = 360;
const FPS = 30;
const DURATION = 1.2;
const OUTPUT_ROOT = path.resolve('.tmp/logo-overlay-smoke');
const PROJECT_ID = 'logo-overlay-smoke';

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

function scene(
  id: string,
  order: number,
  visual: Scene['visual'],
  type: Scene['type'],
  logo: Scene['logo']
): Scene {
  return {
    id,
    order,
    duration: DURATION,
    type,
    visual,
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    logo,
    referenceIds: [],
    notes: ''
  };
}

async function main(): Promise<void> {
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });

  await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#a31818' } })
    .png()
    .toFile(path.join(OUTPUT_ROOT, 'stock.png'));
  await sharp({ create: { width: 128, height: 64, channels: 4, background: { r: 0, g: 220, b: 90, alpha: 1 } } })
    .png()
    .toFile(path.join(OUTPUT_ROOT, 'logo-green.png'));
  await sharp({ create: { width: 128, height: 64, channels: 4, background: { r: 60, g: 120, b: 255, alpha: 1 } } })
    .png()
    .toFile(path.join(OUTPUT_ROOT, 'logo-blue.png'));

  const project: Project = {
    id: PROJECT_ID,
    title: 'Logo Overlay Smoke',
    description: 'Local visual inspection fixture for per-scene logos.',
    durationTarget: DURATION * 3,
    aspectRatio: '16:9',
    fps: FPS,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    narration: { text: '', segments: [] },
    assets: [
      imageAsset('asset-stock', 'stock.png'),
      imageAsset('logo-green', 'logo-green.png'),
      imageAsset('logo-blue', 'logo-blue.png')
    ],
    references: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      background: { type: 'color', value: '#070b10' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true,
      graphicStyle: AI_DEV_FORUM_GRAPHIC_STYLE
    },
    scenes: [
      scene(
        'scene-1',
        1,
        { kind: 'graphic', template: 'statistic', templateData: { value: '82%', label: 'Adoption' } },
        'graphic',
        { assetId: 'logo-green', position: 'top_left', scale: 0.2, margin: 40 }
      ),
      scene('scene-2', 2, { kind: 'asset', assetId: 'asset-stock' }, 'image', {
        assetId: 'logo-green',
        position: 'top_left',
        scale: 0.2,
        margin: 40
      }),
      scene(
        'scene-3',
        3,
        { kind: 'graphic', template: 'title_card', templateData: { title: 'AI Dev Forum', subtitle: 'Different logo' } },
        'graphic',
        { assetId: 'logo-blue', position: 'bottom_right', scale: 0.2, margin: 32, opacity: 0.85 }
      )
    ]
  };

  const fullPlan = resolveRenderPlan(project);
  const renderer = new LocalFFmpegRenderer();
  const runtime = createFFmpegRuntime();

  for (const scenePlan of fullPlan.scenes) {
    if (scenePlan.status !== 'renderable') {
      throw new Error(`Scene ${scenePlan.sceneId} is not renderable: ${scenePlan.issues.map((issue) => issue.message).join('; ')}`);
    }

    const singlePlan = { ...fullPlan, ready: true, scenes: [scenePlan] };
    const outputPath = path.join(OUTPUT_ROOT, `${scenePlan.sceneId}.mp4`);
    const framePath = path.join(OUTPUT_ROOT, `${scenePlan.sceneId}.png`);

    await renderer.render(singlePlan, {
      projectId: PROJECT_ID,
      sceneId: scenePlan.sceneId,
      renderId: `smoke-${scenePlan.sceneId}`,
      outputPath,
      tempDir: path.join(OUTPUT_ROOT, `tmp-${scenePlan.sceneId}`),
      sceneWidth: WIDTH,
      sceneHeight: HEIGHT,
      sceneFps: FPS
    });

    await runProcess(runtime.ffmpegPath, [
      '-y',
      '-ss',
      '0.8',
      '-i',
      outputPath,
      '-frames:v',
      '1',
      framePath
    ]);

    const logo = scenePlan.logo;
    console.log(
      `${scenePlan.sceneId}: ${logo ? `${logo.assetId} @ ${logo.position ?? 'bottom_right'}` : 'no logo'} -> ${outputPath}`
    );
  }

  console.log(`\nFrames: ${OUTPUT_ROOT}/scene-1.png, scene-2.png, scene-3.png`);
  console.log('Scene 1 and 2 must show the SAME green logo; scene 3 must show the blue logo.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
