import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FakeVideoGenerationProvider } from '@/lib/ai/video-generation/fake-provider';
import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';
import { probeMedia } from '@/lib/render/ffprobe';
import { LocalFFmpegRenderer } from '@/lib/render/renderer';
import type { RenderPlan } from '@/lib/types/render';

describe('fake video generation provider', () => {
  it('produces a deterministic, decodable H.264 clip that the renderer can render', async () => {
    const provider = new FakeVideoGenerationProvider();

    const submission = await provider.submit({ prompt: 'deterministic mock clip' });
    await provider.getStatus(submission.providerJobId);
    await provider.getStatus(submission.providerJobId);
    const terminal = await provider.getStatus(submission.providerJobId);
    expect(terminal.status).toBe('generated');

    const download = await provider.download(submission.providerJobId);
    expect(download.mimeType).toBe('video/mp4');
    expect(download.metadata?.fake).toBe(true);

    const second = await provider.download(submission.providerJobId);
    expect(download.data.equals(second.data)).toBe(true);

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'explainer-fake-video-render-'));
    const inputPath = path.join(tempRoot, 'fake-provider.mp4');
    const outputPath = path.join(tempRoot, 'rendered.mp4');
    const tempDir = path.join(tempRoot, 'tmp');

    await fs.writeFile(inputPath, download.data);

    const runtime = createFFmpegRuntime();
    const probe = await probeMedia(inputPath, runtime);
    const videoStream = probe.streams.find((stream) => stream.codec_type === 'video');
    expect(videoStream?.codec_name).toBe('h264');
    expect(videoStream?.width).toBe(64);
    expect(videoStream?.height).toBe(64);
    expect(probe.streams.some((stream) => stream.codec_type === 'audio')).toBe(false);

    const plan: RenderPlan = {
      projectId: 'project-fake-video-render',
      title: 'Fake Video Render',
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
          duration: 2,
          status: 'renderable',
          source: {
            kind: 'video',
            assetPath: inputPath,
            assetType: 'video',
            duration: 1
          },
          motion: { preset: 'none' },
          transition: { type: 'none' },
          overlay: { type: 'none' },
          referenceIds: [],
          issues: []
        }
      ]
    };

    const renderer = new LocalFFmpegRenderer(runtime);
    const result = await renderer.render(plan, {
      projectId: plan.projectId,
      sceneId: 'scene-1',
      renderId: 'render-fake-video-test',
      outputPath,
      tempDir,
      sceneWidth: plan.width,
      sceneHeight: plan.height,
      sceneFps: plan.fps
    });

    expect(result.status).toBe('completed');
    expect(result.filesize).toBeGreaterThan(0);

    const outputProbe = await probeMedia(outputPath, runtime);
    const outputVideo = outputProbe.streams.find((stream) => stream.codec_type === 'video');
    expect(outputVideo?.codec_name).toBe('h264');
    expect(outputVideo?.width).toBe(1280);
    expect(outputVideo?.height).toBe(720);
  }, 120000);
});
