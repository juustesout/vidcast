import { createHash } from 'node:crypto';

import type { GenerationStatus } from '@/lib/types/generation';
import { FAKE_VIDEO_CLIP_BYTES, FAKE_VIDEO_CLIP_METADATA } from './fake-video-fixture';
import { VideoGenerationProviderError, type VideoGenerationCapabilities, type VideoGenerationDownload, type VideoGenerationProvider, type VideoGenerationRequest, type VideoGenerationStatusResult, type VideoGenerationSubmission } from './provider';

interface FakeVideoJob {
  id: string;
  scenario: 'success' | 'fail';
  pollCount: number;
  status: GenerationStatus;
  submittedAt: string;
}

const JOBS = new Map<string, FakeVideoJob>();

export class FakeVideoGenerationProvider implements VideoGenerationProvider {
  readonly providerId = 'fake';

  getCapabilities(): VideoGenerationCapabilities {
    return {
      supportsTextToVideo: true,
      supportsImageToVideo: true,
      supportsReferences: true,
      maxReferences: 8,
      supportedAspectRatios: ['16:9', '1:1', '9:16'],
      supportsCancellation: false
    };
  }

  async submit(request: VideoGenerationRequest): Promise<VideoGenerationSubmission> {
    if (!request.prompt.trim()) {
      throw new VideoGenerationProviderError('Prompt is required for fake video generation.', 400, 'INVALID_REQUEST');
    }

    const hash = createHash('sha1').update(request.prompt).digest('hex').slice(0, 10);
    const id = `fake-video-job-${hash}-${Date.now()}`;
    const scenario: FakeVideoJob['scenario'] = request.prompt.toLowerCase().includes('fail') ? 'fail' : 'success';

    JOBS.set(id, {
      id,
      scenario,
      pollCount: 0,
      status: 'queued',
      submittedAt: new Date().toISOString()
    });

    return {
      providerJobId: id,
      status: 'queued',
      providerStatus: 'queued'
    };
  }

  async getStatus(providerJobId: string): Promise<VideoGenerationStatusResult> {
    const job = JOBS.get(providerJobId);
    if (!job) {
      throw new VideoGenerationProviderError(`Unknown fake job ${providerJobId}`, 404, 'INVALID_REQUEST');
    }

    job.pollCount += 1;

    if (job.scenario === 'fail') {
      if (job.pollCount <= 1) {
        job.status = 'generating';
        return { status: 'generating', providerStatus: 'in_progress' };
      }

      job.status = 'failed';
      return {
        status: 'failed',
        providerStatus: 'error',
        errorCode: 'PROVIDER_FAILED',
        errorMessage: 'Fake provider scenario configured to fail.'
      };
    }

    if (job.pollCount === 1) {
      job.status = 'queued';
      return { status: 'queued', providerStatus: 'queued' };
    }

    if (job.pollCount === 2) {
      job.status = 'generating';
      return { status: 'generating', providerStatus: 'in_progress' };
    }

    job.status = 'generated';
    return { status: 'generated', providerStatus: 'completed' };
  }

  async download(providerJobId: string): Promise<VideoGenerationDownload> {
    const job = JOBS.get(providerJobId);
    if (!job) {
      throw new VideoGenerationProviderError(`Unknown fake job ${providerJobId}`, 404, 'INVALID_REQUEST');
    }

    if (job.status !== 'generated') {
      throw new VideoGenerationProviderError('Fake job is not completed yet.', 409, 'INVALID_REQUEST');
    }

    return {
      mimeType: 'video/mp4',
      data: FAKE_VIDEO_CLIP_BYTES,
      metadata: {
        ...FAKE_VIDEO_CLIP_METADATA,
        jobId: providerJobId
      }
    };
  }
}
