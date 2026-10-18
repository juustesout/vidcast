import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';
import { runFfmpeg } from '@/lib/render/ffmpeg-executor';
import { createId } from '@/lib/utils/ids';
import {
  PresenterProviderError,
  type PresenterDownloadResult,
  type PresenterJobStatus,
  type PresenterProvider,
  type PresenterSubmitRequest,
  type PresenterSubmitResult
} from './provider';

const MOCK_WIDTH = 640;
const MOCK_HEIGHT = 360;
const MOCK_FPS = 25;

function clampDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 3;
  }
  return Math.min(60, Math.max(0.5, value));
}

function formatDuration(seconds: number): string {
  return seconds.toFixed(3);
}

export function buildMockPresenterArgs(outputPath: string, durationSeconds: number): string[] {
  const duration = formatDuration(clampDuration(durationSeconds));
  return [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x111827:s=${MOCK_WIDTH}x${MOCK_HEIGHT}:r=${MOCK_FPS}:d=${duration}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${duration}`,
    '-vf',
    `drawbox=x='mod(t*140,iw+160)-160':y='ih/2-50':w=160:h=100:color=0x38bdf8@0.85:t=fill`,
    '-t',
    duration,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    outputPath
  ];
}

interface MockJob {
  request: PresenterSubmitRequest;
  bytes: Buffer;
  polls: number;
  fail: boolean;
  duration: number;
}

const jobs = new Map<string, MockJob>();

export class FakePresenterProvider implements PresenterProvider {
  readonly providerId = 'mock';
  readonly displayName = 'Mock presenter';
  readonly capabilities = {
    supportsAudioInput: true,
    supportsTransparency: false,
    supportsWebm: false
  };

  private readonly runtime = createFFmpegRuntime();

  async submit(request: PresenterSubmitRequest): Promise<PresenterSubmitResult> {
    const duration = clampDuration(request.audio.duration);
    const jobId = createId('mock_presenter');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-presenter-'));
    const outputPath = path.join(directory, 'clip.mp4');

    try {
      await runFfmpeg(
        this.runtime.ffmpegPath,
        buildMockPresenterArgs(outputPath, duration),
        { timeoutMs: 120_000 },
        'presenter_generate'
      );
      const bytes = await fs.readFile(outputPath);
      jobs.set(jobId, {
        request,
        bytes,
        polls: 0,
        fail: request.avatarId.toLowerCase().includes('fail'),
        duration
      });
    } catch {
      throw new PresenterProviderError('Mock presenter generation failed.', 'PROVIDER_ERROR');
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
      providerJobId: jobId,
      providerStatus: 'queued'
    };
  }

  async getStatus(providerJobId: string): Promise<PresenterJobStatus> {
    const job = jobs.get(providerJobId);
    if (!job) {
      throw new PresenterProviderError('Mock presenter job was not found.', 'INVALID_REQUEST');
    }

    job.polls += 1;

    if (job.fail) {
      return {
        status: 'failed',
        providerStatus: 'failed',
        error: 'Mock presenter was asked to fail.'
      };
    }

    // The first poll mirrors a real asynchronous provider so the run pipeline
    // exercises the poll action, not just an inline submit.
    if (job.polls < 2) {
      return {
        status: 'generating',
        providerStatus: 'processing'
      };
    }

    return {
      status: 'generated',
      providerStatus: 'completed',
      videoUrl: `mock://presenter/${providerJobId}`,
      durationSeconds: job.duration,
      width: MOCK_WIDTH,
      height: MOCK_HEIGHT
    };
  }

  async download(status: PresenterJobStatus): Promise<PresenterDownloadResult> {
    const jobId = status.videoUrl?.split('/').pop() ?? '';
    const job = jobs.get(jobId);
    if (!job) {
      throw new PresenterProviderError('Mock presenter download is unavailable.', 'PROVIDER_ERROR');
    }
    return {
      data: job.bytes,
      mimeType: 'video/mp4',
      durationSeconds: job.duration
    };
  }
}
