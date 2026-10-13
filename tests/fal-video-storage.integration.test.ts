import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FalVideoGenerationProvider, encodeFalJobId } from '@/lib/ai/video-generation/fal-provider';
import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';
import { runProcess } from '@/lib/render/ffmpeg-executor';
import { probeMedia } from '@/lib/render/ffprobe';
import { mediaStore } from '@/lib/storage/media-store';
import { getProjectRoot } from '@/lib/storage/storage-paths';

const ENDPOINT = 'minimax/h3-max-turbo/text-to-video';
const I2V_ENDPOINT = 'minimax/h3-max-turbo/image-to-video';

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await runProcess('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

// Builds a real, decodable MP4 so the download → media store → render-chain
// compatibility is exercised against genuine bytes, not a stub.
async function createFixtureVideo(outputPath: string): Promise<void> {
  const runtime = createFFmpegRuntime();
  await runProcess(
    runtime.ffmpegPath,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=teal:s=160x120:r=15:d=1',
      '-pix_fmt',
      'yuv420p',
      '-t',
      '1',
      outputPath
    ],
    { timeoutMs: 30_000 }
  );
}

function createFalFetchImpl(fixtureBytes: Buffer): (url: string) => Promise<Response> {
  return async (url: string): Promise<Response> => {
    if (url.endsWith('/status?logs=1')) {
      return new Response(JSON.stringify({ status: 'COMPLETED' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.endsWith('/requests/req-media-1')) {
      return new Response(
        JSON.stringify({ video: { url: 'https://v3.fal.media/generated.mp4', content_type: 'video/mp4' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url === 'https://v3.fal.media/generated.mp4') {
      return new Response(new Uint8Array(fixtureBytes), {
        status: 200,
        headers: { 'content-type': 'video/mp4' }
      });
    }
    return new Response('{}', { status: 404 });
  };
}

describe('FAL video storage integration', () => {
  const createdProjectIds: string[] = [];

  afterEach(async () => {
    for (const id of createdProjectIds.splice(0).values()) {
      await fs.rm(getProjectRoot(id), { recursive: true, force: true });
    }
  });

  it('persists a downloaded FAL video through the real media store as a usable asset', async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }

    vi.stubEnv('FAL_KEY', 'fal-test-key');
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fal-video-storage-'));
    const fixturePath = path.join(tempRoot, 'fixture.mp4');
    await createFixtureVideo(fixturePath);
    const fixtureBytes = await fs.readFile(fixturePath);

    try {
      const fetchImpl = createFalFetchImpl(fixtureBytes);

      const provider = new FalVideoGenerationProvider({
        apiKey: 'fal-test-key',
        baseUrl: 'https://queue.test',
        endpoint: ENDPOINT,
        fetchImpl
      });

      const jobId = encodeFalJobId(ENDPOINT, 'req-media-1');
      expect((await provider.getStatus(jobId)).status).toBe('generated');

      const download = await provider.download(jobId);
      expect(download.mimeType).toBe('video/mp4');
      expect(download.data.equals(fixtureBytes)).toBe(true);

      const projectId = `test-fal-asset-${Date.now().toString(36)}`;
      createdProjectIds.push(projectId);

      const asset = await mediaStore.saveGeneratedVideo({
        projectId,
        sceneOrder: 1,
        attemptId: 'attempt-fal-1',
        mimeType: download.mimeType,
        data: download.data,
        generation: {
          generationId: 'gen-fal-1',
          provider: 'fal',
          model: ENDPOINT,
          prompt: 'a teal scene',
          referenceIds: [],
          providerJobId: jobId
        }
      });

      expect(asset.type).toBe('video');
      expect(asset.status).toBe('available');
      expect(asset.provenance).toBe('generated');
      expect(asset.mimeType).toBe('video/mp4');
      expect(asset.metadata?.providerJobId).toBe(jobId);

      const storedPath = path.join(getProjectRoot(projectId), asset.localPath ?? '');
      const stat = await fs.stat(storedPath);
      expect(stat.size).toBeGreaterThan(0);

      // The existing render/compose chain consumes these assets through FFmpeg
      // and FFprobe; a real decode + probe proves the stored asset is compatible.
      try {
        await runProcess('ffmpeg', ['-v', 'error', '-i', storedPath, '-f', 'null', '-'], { timeoutMs: 30_000 });
      } catch (error) {
        throw new Error(`Stored FAL asset failed to decode: ${(error as Error).message}`);
      }

      const probe = await probeMedia(storedPath);
      const videoStream = probe.streams.find((stream) => stream.codec_type === 'video');
      expect(videoStream).toBeDefined();
      expect(videoStream?.width).toBe(160);
      expect(videoStream?.height).toBe(120);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  }, 60_000);

  it('stores an image-to-video download using the shortened queue path', async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }

    vi.stubEnv('FAL_KEY', 'fal-test-key');
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fal-video-i2v-storage-'));
    const fixturePath = path.join(tempRoot, 'fixture.mp4');
    await createFixtureVideo(fixturePath);
    const fixtureBytes = await fs.readFile(fixturePath);

    try {
      const provider = new FalVideoGenerationProvider({
        apiKey: 'fal-test-key',
        baseUrl: 'https://queue.test',
        endpoint: I2V_ENDPOINT,
        fetchImpl: createFalFetchImpl(fixtureBytes)
      });

      // Submit records the app queue path (not the endpoint sub-path) in the composite
      // job id; here we construct that resolved form directly to exercise poll/download.
      const jobId = encodeFalJobId('minimax/h3-max-turbo', 'req-media-1');
      expect(jobId).not.toContain('image-to-video');
      expect((await provider.getStatus(jobId)).status).toBe('generated');

      const download = await provider.download(jobId);
      expect(download.mimeType).toBe('video/mp4');

      const projectId = `test-fal-i2v-asset-${Date.now().toString(36)}`;
      createdProjectIds.push(projectId);

      const asset = await mediaStore.saveGeneratedVideo({
        projectId,
        sceneOrder: 1,
        attemptId: 'attempt-fal-i2v-1',
        mimeType: download.mimeType,
        data: download.data,
        generation: {
          generationId: 'gen-fal-i2v-1',
          provider: 'fal',
          model: I2V_ENDPOINT,
          prompt: 'animate the start frame',
          referenceIds: [],
          providerJobId: jobId
        }
      });

      expect(asset.metadata?.providerJobId).toBe(jobId);

      const storedPath = path.join(getProjectRoot(projectId), asset.localPath ?? '');
      await runProcess('ffmpeg', ['-v', 'error', '-i', storedPath, '-f', 'null', '-'], { timeoutMs: 30_000 });
      const probe = await probeMedia(storedPath);
      const videoStream = probe.streams.find((stream) => stream.codec_type === 'video');
      expect(videoStream?.width).toBe(160);
      expect(videoStream?.height).toBe(120);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  }, 60_000);
});
