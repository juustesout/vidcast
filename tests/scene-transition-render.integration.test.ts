import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import { normalizeProject } from '@/lib/projects/normalize-project';
import { runProcess } from '@/lib/render/ffmpeg-executor';
import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';
import { LocalFFmpegRenderer } from '@/lib/render/renderer';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { Project } from '@/lib/types/render';
import type { TransitionSpec } from '@/lib/types/scene';

const WIDTH = 320;
const HEIGHT = 180;
const FPS = 30;
const DURATION = 3;
const runtime = createFFmpegRuntime();

function makeProject(transition: TransitionSpec): Project {
  return normalizeProject({
    id: 'project-transition-render',
    title: 'Transition Render',
    description: '',
    durationTarget: DURATION,
    aspectRatio: '16:9',
    fps: FPS,
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
    narration: { text: '', segments: [] },
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: DURATION,
        type: 'graphic',
        narration: { text: '' },
        visual: {
          kind: 'graphic',
          template: 'title_card',
          templateData: { title: 'Fade', subtitle: '' },
          style: { background: '#ffffff', textColor: '#000000' }
        },
        render: { motion: { preset: 'none' }, transition },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ],
    assets: [],
    references: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      background: { type: 'color', value: '#ffffff' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: false
    }
  } as Project);
}

async function renderScene(transition: TransitionSpec, name: string): Promise<string> {
  const project = makeProject(transition);
  const plan = resolveRenderPlan(project);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `scene-transition-${name}-`));
  const outputPath = path.join(tempRoot, `${name}.mp4`);

  const result = await new LocalFFmpegRenderer().render(plan, {
    projectId: plan.projectId,
    sceneId: 'scene-1',
    renderId: `render-${name}`,
    outputPath,
    tempDir: path.join(tempRoot, 'tmp'),
    sceneWidth: plan.width,
    sceneHeight: plan.height,
    sceneFps: plan.fps
  });
  expect(result.status).toBe('completed');
  return outputPath;
}

async function frameLuminance(videoPath: string, atSeconds: number, name: string): Promise<number> {
  const framePath = path.join(path.dirname(videoPath), `${name}.png`);
  await runProcess(
    runtime.ffmpegPath,
    ['-y', '-v', 'error', '-ss', String(atSeconds), '-i', videoPath, '-frames:v', '1', framePath],
    { timeoutMs: 60000 }
  );
  const { data, info } = await sharp(framePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let total = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return total / (data.length / info.channels);
}

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await runProcess(runtime.ffmpegPath, ['-version'], { timeoutMs: 10000 });
    return true;
  } catch {
    return false;
  }
}

describe('scene transition semantics -> ffmpeg render (integration)', () => {
  let available = false;

  beforeAll(async () => {
    available = await ffmpegAvailable();
  });

  it('renders a fade scene dark at the head and tail and bright in the middle', async () => {
    if (!available) return;
    const outputPath = await renderScene({ type: 'fade', duration: 0.3 }, 'fade');

    const head = await frameLuminance(outputPath, 0.02, 'head');
    const middle = await frameLuminance(outputPath, DURATION / 2, 'middle');
    const tail = await frameLuminance(outputPath, DURATION - 0.15, 'tail');

    expect(middle).toBeGreaterThan(50);
    expect(head).toBeLessThan(middle * 0.5);
    expect(tail).toBeLessThan(middle * 0.5);
  }, 120000);

  it('renders a none scene bright from the first frame and leaves duration untouched', async () => {
    if (!available) return;
    const outputPath = await renderScene({ type: 'none' }, 'none');

    const head = await frameLuminance(outputPath, 0.02, 'none-head');
    const middle = await frameLuminance(outputPath, DURATION / 2, 'none-middle');

    expect(head).toBeGreaterThan(50);
    expect(middle).toBeGreaterThan(50);
    expect(Math.abs(head - middle)).toBeLessThan(4);
  }, 120000);

  it('renders a crossfade scene without a scene fade', async () => {
    if (!available) return;
    const outputPath = await renderScene({ type: 'crossfade', duration: 0.3 }, 'crossfade');

    const head = await frameLuminance(outputPath, 0.02, 'crossfade-head');
    const middle = await frameLuminance(outputPath, DURATION / 2, 'crossfade-middle');

    expect(head).toBeGreaterThan(50);
    expect(Math.abs(head - middle)).toBeLessThan(4);
  }, 120000);
});
