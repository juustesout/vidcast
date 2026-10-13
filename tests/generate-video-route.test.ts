import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as generateVideoRoute } from '@/app/api/projects/[id]/scenes/[sceneId]/generate-video/route';
import * as videoGenerationService from '@/lib/generation/video-generation-service';
import { clearThrottleStateForTests } from '@/lib/security/access-control';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { projectStore } from '@/lib/storage/project-store';

function withSession(subject: string): string {
  return `${SESSION_COOKIE_NAME}=${createUserSessionCookie(subject)}`;
}

function buildRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/projects/project-1/scenes/scene-1/generate-video', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: withSession('user-a')
    },
    body: JSON.stringify(body)
  });
}

const context = { params: Promise.resolve({ id: 'project-1', sceneId: 'scene-1' }) };

describe('generate-video route provider/model forwarding', () => {
  beforeEach(() => {
    clearThrottleStateForTests();
    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-1', ownerId: 'user-a' } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearThrottleStateForTests();
  });

  it('forwards the explicitly selected provider and model to the service', async () => {
    const submit = vi.spyOn(videoGenerationService, 'submitSceneVideoGeneration').mockResolvedValue({
      sceneId: 'scene-1',
      generationAttemptId: 'generation_attempt_1',
      status: 'queued',
      provider: 'fal',
      model: 'minimax/h3-max-turbo/image-to-video',
      providerJobId: 'fal:minimax/h3-max-turbo:req-1'
    } as never);

    const response = await generateVideoRoute(
      buildRequest({ regenerate: true, provider: 'fal', model: 'minimax/h3-max-turbo/image-to-video' }),
      context
    );

    expect(response.status).toBe(200);
    expect(submit).toHaveBeenCalledWith('project-1', 'scene-1', {
      regenerate: true,
      provider: 'fal',
      model: 'minimax/h3-max-turbo/image-to-video'
    });
  });

  it('omits provider/model when the request does not include them', async () => {
    const submit = vi.spyOn(videoGenerationService, 'submitSceneVideoGeneration').mockResolvedValue({
      sceneId: 'scene-1',
      generationAttemptId: 'generation_attempt_1',
      status: 'queued',
      provider: 'local',
      providerJobId: 'job-1'
    } as never);

    const response = await generateVideoRoute(buildRequest({ regenerate: false }), context);

    expect(response.status).toBe(200);
    expect(submit).toHaveBeenCalledWith('project-1', 'scene-1', {
      regenerate: false,
      provider: undefined,
      model: undefined
    });
  });

  it('surfaces service policy errors without swallowing them', async () => {
    vi.spyOn(videoGenerationService, 'submitSceneVideoGeneration').mockRejectedValue(
      new videoGenerationService.SceneVideoGenerationError('Mock mode only allows fake/local providers.', 403, 'generation.provider.notAllowed')
    );

    const response = await generateVideoRoute(buildRequest({ regenerate: true, provider: 'fal' }), context);
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(403);
    expect(body.code).toBe('generation.provider.notAllowed');
  });
});
