import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { LocalFFmpegRenderer } from '@/lib/render/renderer';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { Project } from '@/lib/types/render';

function createProject(): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-render-1',
    title: 'Renderer Test',
    description: 'desc',
    durationTarget: 5,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1280,
      height: 720,
      background: { type: 'color', value: '#020617' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    assets: [],
    references: [],
    scenes: [
      {
        id: 'scene-blank',
        order: 1,
        duration: 1.5,
        type: 'blank',
        narration: { text: '' },
        visual: { kind: 'blank' },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ]
  };
}

describe('LocalFFmpegRenderer', () => {
  it('renders a blank scene into a valid mp4', async () => {
    const project = createProject();
    const plan = resolveRenderPlan(project);
    const scenePlan = plan.scenes[0];
    expect(scenePlan.status).toBe('renderable');

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explainer-render-'));
    const outputPath = path.join(tempRoot, 'scene-blank.mp4');
    const renderer = new LocalFFmpegRenderer();

    const result = await renderer.render(plan, {
      projectId: project.id,
      sceneId: scenePlan.sceneId,
      renderId: 'render-test-1',
      outputPath,
      tempDir: path.join(tempRoot, 'tmp'),
      sceneWidth: plan.width,
      sceneHeight: plan.height,
      sceneFps: plan.fps
    });

    expect(result.status).toBe('completed');
    expect(result.mimeType).toBe('video/mp4');
    expect(result.width).toBe(plan.width);
    expect(result.height).toBe(plan.height);
    expect(result.fps).toBe(plan.fps);
    expect(result.duration).toBeGreaterThan(0);
    expect(result.filesize).toBeGreaterThan(0);

    const fileStat = await fs.stat(outputPath);
    expect(fileStat.size).toBeGreaterThan(0);
  }, 120000);
});
