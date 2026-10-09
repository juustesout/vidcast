import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FakeImageGenerationProvider } from '@/lib/ai/image-generation/fake-provider';
import { LocalFFmpegRenderer } from '@/lib/render/renderer';
import type { RenderPlan } from '@/lib/types/render';

describe('fake image generation provider', () => {
  it('produces deterministic PNG bytes that the renderer can decode and render', async () => {
    const provider = new FakeImageGenerationProvider();

    const first = await provider.generateImage({
      prompt: 'Deterministic mock render test',
      aspectRatio: '16:9'
    });
    const second = await provider.generateImage({
      prompt: 'Deterministic mock render test',
      aspectRatio: '16:9'
    });

    expect(first.mimeType).toBe('image/png');
    expect(first.data.equals(second.data)).toBe(true);
    expect(first.width).toBe(1280);
    expect(first.height).toBe(720);

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explainer-fake-image-render-'));
    const inputPath = path.join(tempRoot, 'fake-provider.png');
    const outputPath = path.join(tempRoot, 'rendered.mp4');
    const tempDir = path.join(tempRoot, 'tmp');

    await fs.writeFile(inputPath, first.data);

    const plan: RenderPlan = {
      projectId: 'project-fake-render',
      title: 'Fake Render',
      aspectRatio: '16:9',
      fps: 30,
      width: 1280,
      height: 720,
      background: { type: 'color', value: '#000000' },
      ready: true,
      narration: { text: '', segments: [] },
      issues: [],
      scenes: [
        {
          sceneId: 'scene-1',
          order: 1,
          duration: 1,
          status: 'renderable',
          source: {
            kind: 'image',
            assetPath: inputPath,
            assetType: 'image'
          },
          motion: { preset: 'none' },
          transition: { type: 'none' },
          overlay: { type: 'none' },
          referenceIds: [],
          issues: []
        }
      ]
    };

    const renderer = new LocalFFmpegRenderer();
    const result = await renderer.render(plan, {
      projectId: plan.projectId,
      sceneId: 'scene-1',
      renderId: 'render-fake-image-test',
      outputPath,
      tempDir,
      sceneWidth: plan.width,
      sceneHeight: plan.height,
      sceneFps: plan.fps
    });

    expect(result.status).toBe('completed');
    expect(result.filesize).toBeGreaterThan(0);

    const stat = await fs.stat(outputPath);
    expect(stat.size).toBeGreaterThan(0);
  }, 120000);
});
