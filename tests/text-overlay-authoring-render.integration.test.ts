import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyProjectUpdate } from '@/lib/projects/project-update';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { LocalFFmpegRenderer } from '@/lib/render/renderer';
import { runProcess } from '@/lib/render/ffmpeg-executor';
import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';
import { probeMedia } from '@/lib/render/ffprobe';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { Project } from '@/lib/types/render';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const DURATION = 2;

function authoredProject(): Project {
  const now = new Date().toISOString();
  return normalizeProject({
    id: 'project-overlay-authoring-render',
    title: 'Overlay Authoring Render',
    description: 'desc',
    durationTarget: DURATION,
    aspectRatio: '16:9',
    fps: FPS,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: DURATION,
        type: 'image',
        narration: { text: 'Narration for rendering.' },
        visual: { kind: 'blank' },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
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
      background: { type: 'color', value: '#020617' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    }
  });
}

// FFmpeg integration: this exercises the same authoring path (applyProjectUpdate
// -> normalizeProject -> resolveRenderPlan) and then renders the authored
// overlay with the real renderer. It is intentionally separate from the
// mock/API tests because it requires a local ffmpeg/ffprobe.
describe('overlay authoring -> ffmpeg render (integration)', () => {
  it('renders an overlay authored through the update path and fully decodes it', async () => {
    const project = authoredProject();
    const { project: updated, validation } = applyProjectUpdate(project, {
      ...project,
      scenes: [
        {
          ...project.scenes[0],
          overlay: {
            type: 'title',
            text: "Authored 50% cut: \"fast\"",
            position: 'top',
            style: { fontSize: 72, color: '#f8fafc', box: true, margin: 64 },
            timing: { fadeInSeconds: 0.5, fadeOutSeconds: 0.5 }
          }
        }
      ]
    });

    expect(validation.valid).toBe(true);
    expect(updated.scenes[0].overlay?.style?.fontSize).toBe(72);

    const plan = resolveRenderPlan(updated);
    expect(plan.scenes[0].overlay?.text).toBe("Authored 50% cut: \"fast\"");

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-authoring-render-'));
    const outputPath = path.join(tempRoot, 'render.mp4');

    const result = await new LocalFFmpegRenderer().render(plan, {
      projectId: plan.projectId,
      sceneId: 'scene-1',
      renderId: 'render-authored-overlay',
      outputPath,
      tempDir: path.join(tempRoot, 'tmp'),
      sceneWidth: plan.width,
      sceneHeight: plan.height,
      sceneFps: plan.fps
    });

    expect(result.status).toBe('completed');
    expect(result.width).toBe(WIDTH);
    expect(result.height).toBe(HEIGHT);
    expect(result.fps).toBe(FPS);

    const runtime = createFFmpegRuntime();
    await runProcess(runtime.ffmpegPath, ['-v', 'error', '-i', outputPath, '-f', 'null', '-'], { timeoutMs: 120000 });

    const probe = await probeMedia(outputPath, runtime);
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    expect(video).toBeDefined();
    expect(video!.codec_name).toBe('h264');
    expect(video!.width).toBe(WIDTH);
    expect(video!.height).toBe(HEIGHT);
  }, 120000);
});
