import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as cancelVideoRoute } from '@/app/api/projects/[id]/scenes/[sceneId]/cancel-video/route';
import * as videoGenerationService from '@/lib/generation/video-generation-service';
import { clearThrottleStateForTests } from '@/lib/security/access-control';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { projectStore } from '@/lib/storage/project-store';

function withSession(subject: string): string {
  return `${SESSION_COOKIE_NAME}=${createUserSessionCookie(subject)}`;
}

function buildRequest(): Request {
  return new Request('http://localhost/api/projects/project-1/scenes/scene-1/cancel-video', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: withSession('user-a')
    }
  });
}

const context = { params: Promise.resolve({ id: 'project-1', sceneId: 'scene-1' }) };

describe('cancel-video route', () => {
  beforeEach(() => {
    clearThrottleStateForTests();
    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-1', ownerId: 'user-a' } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearThrottleStateForTests();
  });

  it('cancels the active video job and returns the cancellation result', async () => {
    const cancel = vi.spyOn(videoGenerationService, 'cancelSceneVideoGeneration').mockResolvedValue({
      sceneId: 'scene-1',
      generationAttemptId: 'generation_attempt_1',
      status: 'rejected',
      provider: 'fal',
      providerJobId: 'fal:minimax/h3-max-turbo:req-1',
      providerStatus: 'canceled'
    });

    const response = await cancelVideoRoute(buildRequest(), context);
    const body = (await response.json()) as { status?: string; providerStatus?: string };

    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith('project-1', 'scene-1');
    expect(body.status).toBe('rejected');
    expect(body.providerStatus).toBe('canceled');
  });

  it('surfaces an unsupported-provider cancellation error instead of swallowing it', async () => {
    vi.spyOn(videoGenerationService, 'cancelSceneVideoGeneration').mockRejectedValue(
      new videoGenerationService.SceneVideoGenerationError(
        'Provider openai does not support cancellation.',
        409,
        'generation.provider.cancelUnsupported'
      )
    );

    const response = await cancelVideoRoute(buildRequest(), context);
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(409);
    expect(body.code).toBe('generation.provider.cancelUnsupported');
  });
});
