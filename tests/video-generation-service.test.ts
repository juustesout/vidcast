import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import { stampHumanApproval } from '@/lib/explainer/human-approval';
import { cancelSceneVideoGeneration, classifyStatusPollError, refreshVideoGenerationAttempt, SceneVideoGenerationError, submitSceneVideoGeneration } from '@/lib/generation/video-generation-service';
import { InMemoryMandateSpendLedger, setMandateSpendLedgerForTests, setMandateSpendReaderForTests } from '@/lib/spend/mandate-spend';
import { InMemoryPaidSubmitLedger, setPaidSubmitLedgerForTests } from '@/lib/spend/paid-submit-cap';
import { VideoGenerationProviderError } from '@/lib/ai/video-generation/provider';
import { reconcileInterruptedGenerations } from '@/lib/production/run-recovery';
import type { VideoGenerationRequest } from '@/lib/ai/video-generation/provider';
import type { MediaStore } from '@/lib/storage/media-store';
import type { ProjectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';
import { FileExclusiveLock, InMemoryExclusiveLock } from '@/lib/utils/exclusive-file-lock';

afterEach(() => {
  vi.unstubAllEnvs();
  setPaidSubmitLedgerForTests(undefined);
  setMandateSpendLedgerForTests(undefined);
  setMandateSpendReaderForTests(undefined);
});

function enablePaidSpendCap(overrides: Record<string, string> = {}): void {
  vi.stubEnv('PAID_SPEND_CAP_ENABLED', 'true');
  vi.stubEnv('PAID_SPEND_CAP_WINDOW_HOURS', '24');
  vi.stubEnv('PAID_SPEND_CAP_MAX_SUBMITS', '3');
  vi.stubEnv('PAID_SPEND_CAP_MAX_IMAGE_SUBMITS', '2');
  vi.stubEnv('PAID_SPEND_CAP_MAX_VIDEO_SUBMITS', '1');
  vi.stubEnv('PAID_SPEND_CAP_MAX_NARRATION_SUBMITS', '3');
  vi.stubEnv('PAID_SPEND_CAP_MAX_MUSIC_SUBMITS', '1');
  vi.stubEnv('PAID_SPEND_CAP_MAX_PRESENTER_SUBMITS', '1');
  for (const [name, value] of Object.entries(overrides)) {
    vi.stubEnv(name, value);
  }
}

function createProject(): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-video-1',
    title: 'Video Generation Service Test',
    description: 'desc',
    durationTarget: 30,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    assets: [
      {
        id: 'asset-old-video',
        type: 'video',
        status: 'available',
        provenance: 'generated',
        filename: 'old.mp4',
        localPath: 'assets/old.mp4',
        mimeType: 'video/mp4',
        duration: 5,
        filesize: 10,
        metadata: {},
        createdAt: now,
        updatedAt: now
      }
    ],
    references: [
      {
        id: 'ref-1',
        name: 'Main Character',
        description: 'ref',
        filePath: 'references/ref.png',
        tags: ['character'],
        metadata: { mimeType: 'image/png' },
        createdAt: now,
        updatedAt: now
      }
    ],
    scenes: [
      {
        id: 'scene-video-1',
        order: 1,
        duration: 5,
        type: 'video',
        narration: { text: '' },
        visual: {
          kind: 'generated_video',
          assetId: 'asset-old-video',
          generation: {
            id: 'gen-video-current',
            kind: 'video',
            status: 'generated',
            provider: 'openai',
            model: 'sora-1',
            prompt: 'old prompt',
            referenceIds: ['ref-1'],
            aspectRatio: '16:9',
            duration: 5,
            assetId: 'asset-old-video',
            createdAt: now,
            completedAt: now
          },
          attempts: []
        },
        render: { motion: { preset: 'none' }, transition: { type: 'fade' } },
        overlay: { type: 'none' },
        referenceIds: ['ref-1'],
        notes: ''
      }
    ]
  };
}

function withHumanApproval(project: Project): Project {
  const next: Project = {
    ...project,
    explainer: {
      brief: project.explainer?.brief ?? {
        topic: '',
        goal: '',
        audience: '',
        tone: '',
        targetDurationSeconds: project.durationTarget,
        notes: ''
      },
      story: project.explainer?.story ?? {
        title: project.title,
        hook: '',
        script: '',
        beats: [],
        cta: '',
        notes: '',
        versions: []
      },
      sceneIntents: project.explainer?.sceneIntents ?? []
    }
  };
  next.explainer = {
    ...next.explainer!,
    humanApproval: stampHumanApproval(next, { subject: 'user_test' })
  };
  return next;
}

function createInMemoryDependencies(
  project: Project,
  behavior?: {
    failOnSubmit?: boolean;
    submitError?: unknown;
    providerId?: 'fake' | 'fal' | 'openai';
    failOnStatus?: boolean;
    failOnDownload?: boolean;
    statusError?: unknown;
    supportsCancellation?: boolean;
    failOnCancel?: boolean;
    // Awaited inside getStatus so a test can hold a poll in flight.
    statusGate?: () => Promise<void>;
    // Awaited inside submit so a test can hold a submit in flight.
    submitGate?: () => Promise<void>;
  }
) {
  const state = { project: structuredClone(project) as Project };
  let createdAssetCount = 0;
  let submitCalls = 0;
  let downloadCalls = 0;
  const submitRequests: VideoGenerationRequest[] = [];
  const canceledJobIds: string[] = [];
  const sceneSubmitLocks = new InMemoryExclusiveLock();
  const attemptPollLocks = new InMemoryExclusiveLock();

  const store: Pick<ProjectStore, 'getProject' | 'updateProject' | 'mutateProject'> = {
    async getProject(id: string) {
      if (id !== state.project.id) return null;
      return structuredClone(state.project) as Project;
    },
    async updateProject(nextProject: Project) {
      state.project = structuredClone(nextProject) as Project;
      return state.project;
    },
    async mutateProject(id, mutator) {
      if (id !== state.project.id) return null;
      const next = await mutator(structuredClone(state.project) as Project);
      state.project = structuredClone(next) as Project;
      return state.project;
    }
  };

  const media: Pick<MediaStore, 'saveGeneratedVideo' | 'exists' | 'readRelativeFile'> = {
    async saveGeneratedVideo(input) {
      createdAssetCount += 1;
      return {
        id: `asset-generated-video-${createdAssetCount}`,
        type: 'video',
        status: 'available',
        provenance: 'generated',
        filename: `scene-${input.sceneOrder}-generated.mp4`,
        localPath: `assets/scene-${input.sceneOrder}-generated.mp4`,
        mimeType: input.mimeType,
        duration: 5,
        width: 1920,
        height: 1080,
        filesize: input.data.byteLength,
        metadata: {
          generationAttemptId: input.attemptId
        },
        generation: {
          generationId: input.generation.generationId,
          provider: input.generation.provider,
          model: input.generation.model,
          prompt: input.generation.prompt,
          referenceIds: input.generation.referenceIds
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    },
    async exists(_projectId: string, localPath: string) {
      return localPath.startsWith('references/');
    },
    async readRelativeFile() {
      return Buffer.from('ref-bytes');
    }
  };

  const registry = {
    getProvider() {
      return {
        providerId: behavior?.providerId ?? 'fake',
        getCapabilities() {
          return {
            supportsTextToVideo: true,
            supportsImageToVideo: true,
            supportsReferences: true,
            maxReferences: 8,
            supportsCancellation: behavior?.supportsCancellation ?? true
          };
        },
        async cancel(providerJobId: string) {
          if (behavior?.failOnCancel) {
            throw new Error('cancel failed');
          }
          canceledJobIds.push(providerJobId);
        },
        async submit(request: VideoGenerationRequest) {
          submitCalls += 1;
          if (behavior?.submitGate) {
            await behavior.submitGate();
          }
          if (behavior?.submitError !== undefined) {
            throw behavior.submitError;
          }
          if (behavior?.failOnSubmit) {
            throw new Error('submit failed');
          }
          submitRequests.push(request);
          return {
            providerJobId: 'job-1',
            status: 'queued' as const,
            providerStatus: 'queued'
          };
        },
        async getStatus() {
          if (behavior?.statusGate) {
            await behavior.statusGate();
          }
          if (behavior?.statusError !== undefined) {
            throw behavior.statusError;
          }
          if (behavior?.failOnStatus) {
            throw new Error('status failed');
          }
          return {
            status: 'generated' as const,
            providerStatus: 'completed'
          };
        },
        async download() {
          downloadCalls += 1;
          if (behavior?.failOnDownload) {
            throw new Error('download failed');
          }
          return {
            mimeType: 'video/mp4',
            data: Buffer.from('000000186674797069736F6D0000020069736F6D69736F32', 'hex'),
            metadata: { fake: true }
          };
        }
      };
    }
  };

  return {
    state,
    store,
    media,
    registry,
    submitRequests,
    canceledJobIds,
    sceneSubmitLocks,
    attemptPollLocks,
    submitCalls: () => submitCalls,
    downloadCalls: () => downloadCalls
  };
}

function videoServiceDeps(deps: ReturnType<typeof createInMemoryDependencies>) {
  return {
    store: deps.store,
    media: deps.media,
    registry: deps.registry as never,
    sceneSubmitLocks: deps.sceneSubmitLocks,
    attemptPollLocks: deps.attemptPollLocks
  };
}

describe('video generation service', () => {
  it('submit + poll completion creates video asset and updates scene', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project);

    const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, videoServiceDeps(deps));

    expect(submit.status).toBe('queued');
    expect(submit.providerJobId).toBe('job-1');

    const poll = await refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, videoServiceDeps(deps));

    expect(poll.status).toBe('generated');
    expect(poll.assetId).toBeDefined();

    const scene = deps.state.project.scenes[0];
    if (scene.visual && scene.visual.kind === 'generated_video') {
      expect(scene.visual.generation.status).toBe('generated');
      expect(scene.visual.assetId).toBe(poll.assetId);
      expect(scene.visual.generation.providerJobId).toBe('job-1');
    }

    expect(deps.state.project.assets.length).toBe(2);
  });

  it('prevents duplicate submit while active job exists', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project);

    await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, videoServiceDeps(deps));

    await expect(
      submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: false }, {
        ...videoServiceDeps(deps)
      })
    ).rejects.toThrow(SceneVideoGenerationError);
  });

  it('marks attempt failed and preserves previous asset when submit fails', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project, { failOnSubmit: true });

    await expect(
      submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      })
    ).rejects.toThrow(SceneVideoGenerationError);

    const scene = deps.state.project.scenes[0];
    if (scene.visual && scene.visual.kind === 'generated_video') {
      expect(scene.visual.assetId).toBe('asset-old-video');
      expect(scene.visual.generation.status).toBe('failed');
    }
  });

  it('clears attempt-scoped failure flags when a recovered attempt is retried', async () => {
    const project = createProject();
    const scene = project.scenes[0];
    if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    scene.visual.generation = {
      ...scene.visual.generation,
      status: 'failed',
      providerStatus: 'submit_unresolved',
      error: 'The provider submit outcome could not be confirmed.',
      errorCode: 'PROVIDER_FAILED',
      metadata: {
        submitUnresolved: true,
        pollUnresolved: true,
        lastPollErrorCode: 'PROVIDER_FAILED',
        cancelFailed: true,
        idempotencyKey: 'previous-attempt'
      }
    };
    const deps = createInMemoryDependencies(project);

    const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, videoServiceDeps(deps));

    const retried = deps.state.project.scenes[0];
    if (retried.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    expect(retried.visual.generation.metadata).toMatchObject({
      idempotencyKey: submit.generationAttemptId
    });
    expect(retried.visual.generation.metadata?.submitUnresolved).toBeUndefined();
    expect(retried.visual.generation.metadata?.pollUnresolved).toBeUndefined();
    expect(retried.visual.generation.metadata?.lastPollErrorCode).toBeUndefined();
    expect(retried.visual.generation.metadata?.cancelFailed).toBeUndefined();
    expect(retried.visual.generation.metadata?.downloadFailed).toBeUndefined();

    const poll = await refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, videoServiceDeps(deps));
    expect(poll.status).toBe('generated');
  });

  it('blocks real video generation without human approval', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('FAL_KEY', 'fal-test-key');
    const project = createProject();
    const deps = createInMemoryDependencies(project, { providerId: 'fal' });

    await expect(
      submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true, provider: 'fal', mode: 'real' }, {
        ...videoServiceDeps(deps)
      })
    ).rejects.toMatchObject({
      status: 403,
      code: 'generation.approval.required'
    });
    expect(deps.submitCalls()).toBe(0);
  });

  it('fails closed for a real video submit when the spend cap is disabled', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('FAL_KEY', 'fal-test-key');
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
    const project = withHumanApproval(createProject());
    const deps = createInMemoryDependencies(project, { providerId: 'fal' });

    await expect(
      submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true, provider: 'fal', mode: 'real' }, {
        ...videoServiceDeps(deps)
      })
    ).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.invalid'
    });
    expect(deps.submitCalls()).toBe(0);
  });

  it('blocks a service token from real video generation even with human approval', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('FAL_KEY', 'fal-test-key');
    const project = withHumanApproval(createProject());
    const deps = createInMemoryDependencies(project, { providerId: 'fal' });

    await expect(
      submitSceneVideoGeneration(
        project.id,
        'scene-video-1',
        {
          regenerate: true,
          provider: 'fal',
          mode: 'real',
          identity: { kind: 'service', subject: 'service:api_token', authType: 'service_token' }
        },
        {
          ...videoServiceDeps(deps)
        }
      )
    ).rejects.toMatchObject({
      status: 403,
      code: 'generation.policy.denied'
    });
    expect(deps.submitCalls()).toBe(0);
  });

  it('keeps an ambiguous real-provider submit active and blocks a duplicate paid submit', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('FAL_KEY', 'fal-test-key');
    enablePaidSpendCap();
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
    const project = withHumanApproval(createProject());
    const deps = createInMemoryDependencies(project, {
      providerId: 'fal',
      submitError: new VideoGenerationProviderError('FAL video generation timed out or was aborted.', 504, 'PROVIDER_FAILED')
    });

    await expect(
      submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true, provider: 'fal', mode: 'real' }, {
        ...videoServiceDeps(deps)
      })
    ).rejects.toMatchObject({ code: 'generation.attempt.submitUnresolved' });

    const scene = deps.state.project.scenes[0];
    if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    expect(scene.visual.generation.status).toBe('queued');
    expect(scene.visual.generation.providerJobId).toBeUndefined();
    expect(scene.visual.generation.providerStatus).toBe('submit_unresolved');
    expect(scene.visual.generation.metadata?.submitUnresolved).toBe(true);
    expect(scene.visual.generation.metadata?.idempotencyKey).toBe(scene.visual.generation.id);

    await expect(
      submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true, provider: 'fal', mode: 'real' }, {
        ...videoServiceDeps(deps)
      })
    ).rejects.toMatchObject({ code: 'generation.scene.busy' });
    expect(deps.submitCalls()).toBe(1);

    // A restart reconciles the unconfirmed attempt as failed and suppresses the
    // automatic video submit instead of billing a second job.
    const recovery = reconcileInterruptedGenerations(deps.state.project, 'real');
    const recovered = recovery.updatedProject?.scenes[0].visual;
    expect(recovered).toMatchObject({
      generation: {
        status: 'failed',
        providerStatus: 'submit_unresolved',
        metadata: { submitUnresolved: true }
      }
    });
    expect(recovery.suppressedActionIds).toEqual(['scene:scene-video-1:video_submit']);
  });

  it('returns persisted state when polling a non-active historical attempt', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project);

    const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, videoServiceDeps(deps));

    const firstAttemptId = 'gen-video-current';
    const historical = await refreshVideoGenerationAttempt(project.id, firstAttemptId, videoServiceDeps(deps));

    expect(historical.generationAttemptId).toBe(firstAttemptId);
    expect(historical.status).toBe('generated');

    await refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, videoServiceDeps(deps));
  });

  function addReference(project: Project, id: string): void {
    project.references.push({
      id,
      name: id,
      description: '',
      filePath: `references/${id}.png`,
      tags: [],
      metadata: { mimeType: 'image/png' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  function setFrames(project: Project, frames: { start?: string; end?: string; referenceIds?: string[] }): void {
    const scene = project.scenes[0];
    if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    scene.visual.generation = {
      ...scene.visual.generation,
      ...(frames.referenceIds ? { referenceIds: frames.referenceIds } : {}),
      startFrameReferenceId: frames.start,
      endFrameReferenceId: frames.end
    };
    if (frames.referenceIds) {
      scene.referenceIds = frames.referenceIds;
    }
  }

  function submit(deps: ReturnType<typeof createInMemoryDependencies>) {
    return submitSceneVideoGeneration('project-video-1', 'scene-video-1', { regenerate: true }, videoServiceDeps(deps));
  }

  it('maps designated keyframes to start_frame/end_frame and leaves other references plain', async () => {
    const project = createProject();
    addReference(project, 'ref-2');
    setFrames(project, { start: 'ref-1', end: 'ref-2', referenceIds: ['ref-1', 'ref-2'] });
    const deps = createInMemoryDependencies(project);

    await submit(deps);

    expect(deps.submitRequests).toHaveLength(1);
    expect(deps.submitRequests[0].references?.map((reference) => [reference.id, reference.role])).toEqual([
      ['ref-1', 'start_frame'],
      ['ref-2', 'end_frame']
    ]);
  });

  it('keeps references plain when no keyframes are designated', async () => {
    const deps = createInMemoryDependencies(createProject());

    await submit(deps);

    expect(deps.submitRequests[0].references?.map((reference) => reference.role)).toEqual(['reference']);
  });

  it('rejects a designated frame that is not part of the scene references', async () => {
    const project = createProject();
    setFrames(project, { start: 'ref-missing' });
    const deps = createInMemoryDependencies(project);

    await expect(submit(deps)).rejects.toMatchObject({ code: 'generation.reference.startFrameInvalid' });
    expect(deps.submitRequests).toHaveLength(0);
  });

  it('rejects identical start and end frame references', async () => {
    const project = createProject();
    setFrames(project, { start: 'ref-1', end: 'ref-1' });
    const deps = createInMemoryDependencies(project);

    await expect(submit(deps)).rejects.toMatchObject({ code: 'generation.reference.frameConflict' });
    expect(deps.submitRequests).toHaveLength(0);
  });

  it('persists the keyframe designations on the accepted attempt', async () => {
    const project = createProject();
    setFrames(project, { start: 'ref-1' });
    const deps = createInMemoryDependencies(project);

    await submit(deps);

    const scene = deps.state.project.scenes[0];
    if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    expect(scene.visual.generation.startFrameReferenceId).toBe('ref-1');
  });

  it('uses the stored scene model when no model override is provided', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project);

    await submit(deps);

    expect(deps.submitRequests).toHaveLength(1);
    expect(deps.submitRequests[0].model).toBe('sora-1');
  });

  it('threads an explicit model override to the provider and the persisted attempt', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project);

    const result = await submitSceneVideoGeneration(
      project.id,
      'scene-video-1',
      { regenerate: true, model: 'minimax/h3-max-turbo/image-to-video' },
      videoServiceDeps(deps)
    );

    expect(deps.submitRequests).toHaveLength(1);
    expect(deps.submitRequests[0].model).toBe('minimax/h3-max-turbo/image-to-video');
    expect(result.model).toBe('minimax/h3-max-turbo/image-to-video');

    const scene = deps.state.project.scenes[0];
    if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    expect(scene.visual.generation.model).toBe('minimax/h3-max-turbo/image-to-video');
  });

  it('rejects a real provider in mock mode without submitting to any provider', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project);

    await expect(
      submitSceneVideoGeneration(
        project.id,
        'scene-video-1',
        { regenerate: true, provider: 'fal', mode: 'mock' },
        videoServiceDeps(deps)
      )
    ).rejects.toMatchObject({ code: 'generation.provider.notAllowed' });

    expect(deps.submitRequests).toHaveLength(0);
  });

  describe('cancellation', () => {
    it('cancels the active remote job and marks the attempt rejected', async () => {
      const project = createProject();
      const deps = createInMemoryDependencies(project);
      const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });

      const result = await cancelSceneVideoGeneration(project.id, 'scene-video-1', {}, {
        ...videoServiceDeps(deps)
      });

      expect(deps.canceledJobIds).toEqual(['job-1']);
      expect(result.status).toBe('rejected');
      expect(result.providerStatus).toBe('canceled');

      const scene = deps.state.project.scenes[0];
      if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(scene.visual.generation.status).toBe('rejected');
      expect(scene.visual.generation.providerStatus).toBe('canceled');
      expect(scene.visual.generation.id).toBe(submit.generationAttemptId);
    });

    it('rejects cancellation when the provider does not support it (never silent)', async () => {
      const project = createProject();
      const deps = createInMemoryDependencies(project, { supportsCancellation: false });
      await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });

      await expect(
        cancelSceneVideoGeneration(project.id, 'scene-video-1', {}, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.provider.cancelUnsupported' });

      expect(deps.canceledJobIds).toHaveLength(0);
      const scene = deps.state.project.scenes[0];
      if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(scene.visual.generation.status).toBe('queued');
    });

    it('rejects cancellation when no attempt is active', async () => {
      const project = createProject();
      // The fixture's current attempt is already `generated`.
      const deps = createInMemoryDependencies(project);

      await expect(
        cancelSceneVideoGeneration(project.id, 'scene-video-1', {}, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.scene.notActive' });
    });

    it('surfaces a remote cancellation failure and keeps the attempt active (no double billing)', async () => {
      const project = createProject();
      const deps = createInMemoryDependencies(project, { failOnCancel: true });
      await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });

      await expect(
        cancelSceneVideoGeneration(project.id, 'scene-video-1', {}, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.provider.cancelFailed' });

      const scene = deps.state.project.scenes[0];
      if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      // Still active and resumable; a new submit is not silently started.
      expect(scene.visual.generation.status).toBe('queued');
      expect(scene.visual.generation.providerJobId).toBe('job-1');
      expect(scene.visual.generation.providerStatus).toBe('cancel_failed');
    });

    it('keeps a completed job recoverable when the remote cancel fails (job finished mid-cancel)', async () => {
      const project = createProject();
      const deps = createInMemoryDependencies(project, { failOnCancel: true });
      await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });

      // FAL rejects the cancel because the job already completed remotely: the
      // cancellation is surfaced, the attempt is NOT marked terminal, and the
      // completed result is still recoverable by a later poll.
      await expect(
        cancelSceneVideoGeneration(project.id, 'scene-video-1', {}, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.provider.cancelFailed' });

      const active = deps.state.project.scenes[0];
      if (active.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(active.visual.generation.status).toBe('queued');

      const polled = await refreshVideoGenerationAttempt(project.id, active.visual.generation.id, {
        ...videoServiceDeps(deps)
      });
      expect(polled.status).toBe('generated');
      expect(polled.assetId).toBeDefined();
    });

    it('rejects a cancel while a status poll is in flight (poll and cancel are serialized)', async () => {
      const project = createProject();
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let enteredPoll: () => void = () => {};
      const pollEntered = new Promise<void>((resolve) => {
        enteredPoll = resolve;
      });
      const deps = createInMemoryDependencies(project, {
        statusGate: async () => {
          enteredPoll();
          await gate;
        }
      });

      const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });

      const poll = refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
        ...videoServiceDeps(deps)
      });
      await pollEntered;

      await expect(
        cancelSceneVideoGeneration(project.id, 'scene-video-1', {}, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.attempt.pollBusy' });

      // The remote cancel was never invoked while the poll owned the attempt.
      expect(deps.canceledJobIds).toHaveLength(0);

      releaseGate();
      const polled = await poll;
      expect(polled.status).toBe('generated');

      // The completed generation is intact: the blocked cancel did not clobber it.
      const scene = deps.state.project.scenes[0];
      if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(scene.visual.generation.status).toBe('generated');
      expect(scene.visual.assetId).toBe(polled.assetId);
    });

    it('never overwrites a just-completed generation with a cancellation', async () => {
      const project = createProject();
      const deps = createInMemoryDependencies(project);

      const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });

      // A poll completes the job (active -> generated) before cancellation starts.
      const polled = await refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
        ...videoServiceDeps(deps)
      });
      expect(polled.status).toBe('generated');

      // Cancelling the (now terminal) attempt must be refused, not applied.
      await expect(
        cancelSceneVideoGeneration(project.id, 'scene-video-1', {}, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.scene.notActive' });

      expect(deps.canceledJobIds).toHaveLength(0);
      const scene = deps.state.project.scenes[0];
      if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(scene.visual.generation.status).toBe('generated');
      expect(scene.visual.assetId).toBe(polled.assetId);
    });
  });

  describe('safe recovery of a possibly-live remote job', () => {
    it('keeps the attempt active (same job id) on a transient status error and never allows a second submit', async () => {
      const project = createProject();
      const behavior: { failOnStatus?: boolean } = { failOnStatus: true };
      const deps = createInMemoryDependencies(project, behavior);

      const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });
      expect(submit.providerJobId).toBe('job-1');

      await expect(
        refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.attempt.statusUnresolved' });

      // The attempt is NOT failed: it stays active and keeps its provider job id.
      const scene = deps.state.project.scenes[0];
      if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(scene.visual.generation.status).toBe('queued');
      expect(scene.visual.generation.providerJobId).toBe('job-1');
      expect(scene.visual.generation.providerStatus).toBe('status_unresolved');

      // A retry/new run must not start a second paid submission while the job may
      // still be running.
      await expect(
        submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.scene.busy' });

      // Recovery keeps the same job resumable, and re-polling succeeds on the
      // SAME attempt/job once the provider is reachable again (no re-submission).
      behavior.failOnStatus = false;
      const resumed = await refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
        ...videoServiceDeps(deps)
      });
      expect(resumed.generationAttemptId).toBe(submit.generationAttemptId);
      expect(resumed.providerJobId).toBe('job-1');
      expect(resumed.status).toBe('generated');
    });

    it('treats a transport/5xx provider error (PROVIDER_FAILED) as transient', async () => {
      const project = createProject();
      const deps = createInMemoryDependencies(project, {
        statusError: new VideoGenerationProviderError('Could not reach the FAL video generation service.', 502, 'PROVIDER_FAILED')
      });

      const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });

      await expect(
        refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.attempt.statusUnresolved' });

      const scene = deps.state.project.scenes[0];
      if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(scene.visual.generation.status).not.toBe('failed');
      expect(scene.visual.generation.providerJobId).toBe('job-1');
    });

    it('keeps the attempt active on an HTTP 4xx status error (PROVIDER_REJECTED is not proof the job is dead)', async () => {
      const project = createProject();
      const deps = createInMemoryDependencies(project, {
        statusError: new VideoGenerationProviderError('FAL status endpoint rejected the request.', 422, 'PROVIDER_REJECTED')
      });

      const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });

      // A 4xx from the *status* endpoint (e.g. 404 for a not-yet-registered
      // request or 405 for a non-canonical queue path) does not prove the remote
      // job stopped, so the attempt must stay resumable and must not be failed
      // (failing it lets the planner auto-resubmit with regenerate).
      await expect(
        refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.attempt.statusUnresolved' });

      const scene = deps.state.project.scenes[0];
      if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(scene.visual.generation.status).not.toBe('failed');
      expect(scene.visual.generation.providerJobId).toBe('job-1');
      expect(scene.visual.generation.providerStatus).toBe('status_unresolved');

      await expect(
        submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.scene.busy' });
    });

    it('keeps the attempt active on a provider auth status error (PROVIDER_AUTH = unknown remote state)', async () => {
      const project = createProject();
      const deps = createInMemoryDependencies(project, {
        statusError: new VideoGenerationProviderError('FAL status call not authorized.', 502, 'PROVIDER_AUTH')
      });

      const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });

      await expect(
        refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.attempt.statusUnresolved' });

      const scene = deps.state.project.scenes[0];
      if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(scene.visual.generation.status).not.toBe('failed');
      expect(scene.visual.generation.providerJobId).toBe('job-1');
    });

    it('keeps an existing job recoverable when the credential is missing (never fails into a new submission)', async () => {
      const project = createProject();
      const deps = createInMemoryDependencies(project, {
        // Analogous to assertConfigured() throwing when FAL_KEY is absent.
        statusError: new VideoGenerationProviderError('FAL video generation is not configured. Set FAL_KEY on the server.', 409, 'NOT_CONFIGURED')
      });

      const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });

      // The poll cannot confirm status, but the job id is fully recoverable once
      // the credential returns, so the attempt must NOT be failed.
      await expect(
        refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.attempt.statusUnresolved' });

      const scene = deps.state.project.scenes[0];
      if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(scene.visual.generation.status).toBe('queued');
      expect(scene.visual.generation.providerJobId).toBe('job-1');

      // While the attempt stays active the busy-guard blocks any resubmission, so
      // a missing credential can never leak into a second paid job.
      await expect(
        submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.scene.busy' });
      // No provider submit was attempted at all.
      expect(deps.submitRequests).toHaveLength(1);
    });

    it('fails the attempt only on a locally-definitive status error (malformed job id)', async () => {
      const project = createProject();
      const deps = createInMemoryDependencies(project, {
        statusError: new VideoGenerationProviderError('Malformed FAL video job id.', 400, 'INVALID_REQUEST')
      });

      const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });

      await expect(
        refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

      const scene = deps.state.project.scenes[0];
      if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(scene.visual.generation.status).toBe('failed');
      // The job id is retained for audit even when the attempt is failed.
      expect(scene.visual.generation.providerJobId).toBe('job-1');
    });

    it('never fails an attempt for an unrecognized provider status payload', async () => {
      const project = createProject();
      const deps = createInMemoryDependencies(project);
      // An unknown/forward-compatible status must be treated as still-processing.
      (deps.registry as unknown as { getProvider: () => { getStatus: () => Promise<unknown> } }).getProvider = () => ({
        providerId: 'fake',
        getCapabilities: () => ({
          supportsTextToVideo: true,
          supportsImageToVideo: true,
          supportsReferences: true,
          maxReferences: 8,
          supportsCancellation: true
        }),
        submit: async () => ({ providerJobId: 'job-1', status: 'queued' as const, providerStatus: 'queued' }),
        getStatus: async () => ({ status: 'generating' as const, providerStatus: 'SOMETHING_NEW' }),
        download: async () => ({ mimeType: 'video/mp4', data: Buffer.from('00', 'hex') })
      });

      const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });

      const poll = await refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
        ...videoServiceDeps(deps)
      });

      expect(poll.status).toBe('generating');
      expect(poll.providerStatus).toBe('SOMETHING_NEW');

      const scene = deps.state.project.scenes[0];
      if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(scene.visual.generation.status).toBe('generating');
    });

    it('leaves an unresolved active job resumable through run recovery (no suppression, poll retained)', async () => {
      const project = createProject();
      const behavior: { failOnStatus?: boolean } = { failOnStatus: true };
      const deps = createInMemoryDependencies(project, behavior);

      const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });
      await expect(
        refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.attempt.statusUnresolved' });

      const recovery = reconcileInterruptedGenerations(deps.state.project, 'real');

      // Nothing is marked failed or suppressed; the active job is left to resume by poll.
      expect(recovery.suppressedActionIds).toEqual([]);
      expect(recovery.notes.some((note) => note.actionType === 'video_poll')).toBe(true);
      const scene = deps.state.project.scenes[0];
      if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(scene.visual.generation.status).toBe('queued');
    });
  });

  describe('download retry without a second paid submit', () => {
    it('keeps the remote job id after a download failure and retries download only', async () => {
      const project = createProject();
      const behavior: { failOnDownload?: boolean } = { failOnDownload: true };
      const deps = createInMemoryDependencies(project, behavior);

      const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, videoServiceDeps(deps));
      expect(deps.submitCalls()).toBe(1);

      const failedPoll = await refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, videoServiceDeps(deps));
      expect(failedPoll.status).toBe('generating');
      expect(failedPoll.providerJobId).toBe('job-1');
      expect(failedPoll.providerStatus).toBe('download_failed');
      expect(failedPoll.errorCode).toBe('DOWNLOAD_FAILED');
      expect(deps.downloadCalls()).toBe(1);

      const scene = deps.state.project.scenes[0];
      if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(scene.visual.generation.status).toBe('generating');
      expect(scene.visual.generation.providerJobId).toBe('job-1');
      expect(scene.visual.generation.metadata?.downloadFailed).toBe(true);

      await expect(
        submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, videoServiceDeps(deps))
      ).rejects.toMatchObject({ code: 'generation.scene.busy' });
      expect(deps.submitCalls()).toBe(1);

      const recovery = reconcileInterruptedGenerations(deps.state.project, 'real');
      expect(recovery.suppressedActionIds).toEqual([]);
      expect(recovery.notes.some((note) => note.actionType === 'video_poll')).toBe(true);

      behavior.failOnDownload = false;
      const resumed = await refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, videoServiceDeps(deps));
      expect(resumed.generationAttemptId).toBe(submit.generationAttemptId);
      expect(resumed.providerJobId).toBe('job-1');
      expect(resumed.status).toBe('generated');
      expect(deps.submitCalls()).toBe(1);
      expect(deps.downloadCalls()).toBe(2);

      const completed = deps.state.project.scenes[0];
      if (completed.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
      expect(completed.visual.generation.metadata?.downloadFailed).toBeUndefined();
    });
  });

  describe('concurrent scene submit reservation', () => {
    it('lets only one of two overlapping submits reach the provider', async () => {
      const project = createProject();
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let enteredSubmit: () => void = () => {};
      const submitEntered = new Promise<void>((resolve) => {
        enteredSubmit = resolve;
      });
      const deps = createInMemoryDependencies(project, {
        submitGate: async () => {
          enteredSubmit();
          await gate;
        }
      });

      const first = submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, videoServiceDeps(deps));
      await submitEntered;

      await expect(
        submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, videoServiceDeps(deps))
      ).rejects.toMatchObject({ code: 'generation.scene.alreadyRunning' });

      releaseGate();
      const submitted = await first;
      expect(submitted.providerJobId).toBe('job-1');
      expect(deps.submitCalls()).toBe(1);
    });

    it('lets only one of two independent file locks reach the provider', async () => {
      const project = createProject();
      const dir = path.join(os.tmpdir(), `video-submit-lock-${process.pid}-${Date.now()}`);
      const resolvePath = (key: string) => path.join(dir, `${key.replace(/[^A-Za-z0-9._-]+/g, '_')}.lock`);
      const holder = new FileExclusiveLock({ resolvePath });
      const challenger = new FileExclusiveLock({ resolvePath });
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let enteredSubmit: () => void = () => {};
      const submitEntered = new Promise<void>((resolve) => {
        enteredSubmit = resolve;
      });
      const deps = createInMemoryDependencies(project, {
        submitGate: async () => {
          enteredSubmit();
          await gate;
        }
      });

      const first = submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps),
        sceneSubmitLocks: holder
      });
      await submitEntered;

      await expect(
        submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
          ...videoServiceDeps(deps),
          sceneSubmitLocks: challenger
        })
      ).rejects.toMatchObject({ code: 'generation.scene.alreadyRunning' });

      releaseGate();
      await first;
      expect(deps.submitCalls()).toBe(1);
    });
  });

  describe('classifyStatusPollError', () => {
    it('only treats a locally-unrecoverable job id as terminal', () => {
      expect(classifyStatusPollError(new VideoGenerationProviderError('x', 400, 'INVALID_REQUEST'))).toBe('terminal');
      // A missing credential never proves the remote job is gone (it is
      // recoverable once the credential returns), so it must stay transient.
      for (const code of ['NOT_CONFIGURED', 'PROVIDER_FAILED', 'PROVIDER_RATE_LIMIT', 'PROVIDER_AUTH', 'PROVIDER_REJECTED'] as const) {
        expect(classifyStatusPollError(new VideoGenerationProviderError('x', 500, code))).toBe('transient');
      }
      expect(classifyStatusPollError(new Error('unexpected'))).toBe('transient');
      expect(classifyStatusPollError('boom')).toBe('transient');
    });
  });

  describe('paid submit cap', () => {
    it('counts a real video submit and does not increment on poll', async () => {
      vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
      vi.stubEnv('FAL_KEY', 'fal-test-key');
      enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '1', PAID_SPEND_CAP_MAX_VIDEO_SUBMITS: '1' });
      const ledger = new InMemoryPaidSubmitLedger();
      setPaidSubmitLedgerForTests(ledger);
      const project = withHumanApproval(createProject());
      const deps = createInMemoryDependencies(project, { providerId: 'fal' });

      const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true, provider: 'fal', mode: 'real' }, {
        ...videoServiceDeps(deps)
      });
      expect(deps.submitCalls()).toBe(1);
      expect((await ledger.snapshot()).entries).toHaveLength(1);

      await refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
        ...videoServiceDeps(deps)
      }, { mode: 'real' });
      expect((await ledger.snapshot()).entries).toHaveLength(1);
      expect(deps.submitCalls()).toBe(1);
    });

    it('does not debit an unresolved retry that never POSTs', async () => {
      vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
      vi.stubEnv('FAL_KEY', 'fal-test-key');
      enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '2', PAID_SPEND_CAP_MAX_VIDEO_SUBMITS: '2' });
      const ledger = new InMemoryPaidSubmitLedger();
      setPaidSubmitLedgerForTests(ledger);
      const project = withHumanApproval(createProject());
      const deps = createInMemoryDependencies(project, {
        providerId: 'fal',
        submitError: new VideoGenerationProviderError('FAL video generation timed out or was aborted.', 504, 'PROVIDER_FAILED')
      });

      await expect(
        submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true, provider: 'fal', mode: 'real' }, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.attempt.submitUnresolved' });
      expect((await ledger.snapshot()).entries).toHaveLength(1);
      expect(deps.submitCalls()).toBe(1);

      await expect(
        submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true, provider: 'fal', mode: 'real' }, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({ code: 'generation.scene.busy' });
      expect((await ledger.snapshot()).entries).toHaveLength(1);
      expect(deps.submitCalls()).toBe(1);
    });

    it('blocks a real video submit when the mandate video budget is exhausted', async () => {
      vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
      vi.stubEnv('FAL_KEY', 'fal-test-key');
      enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '5', PAID_SPEND_CAP_MAX_VIDEO_SUBMITS: '5' });
      setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
      setMandateSpendLedgerForTests(new InMemoryMandateSpendLedger());
      setMandateSpendReaderForTests(async () => ({
        mandateId: 'mandate_1',
        projectId: 'project-video-1',
        issuedBy: 'user_test',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: 'active',
        brief: '',
        allowedActions: ['generate_video'],
        budgets: { maxVideoSubmits: 0 }
      }));
      const project = withHumanApproval(createProject());
      const deps = createInMemoryDependencies(project, { providerId: 'fal' });

      await expect(
        submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true, provider: 'fal', mode: 'real' }, {
          ...videoServiceDeps(deps)
        })
      ).rejects.toMatchObject({
        status: 403,
        code: 'mandate.budget.exceeded'
      });
      expect(deps.submitCalls()).toBe(0);
    });

    it('does not consult the spend ledger for mock video submit or poll', async () => {
      enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '0' });
      const ledger = new InMemoryPaidSubmitLedger();
      let reserveCalls = 0;
      const original = ledger.reserve.bind(ledger);
      ledger.reserve = async (input) => {
        reserveCalls += 1;
        return original(input);
      };
      setPaidSubmitLedgerForTests(ledger);
      const project = createProject();
      const deps = createInMemoryDependencies(project);

      const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        ...videoServiceDeps(deps)
      });
      await refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
        ...videoServiceDeps(deps)
      });
      expect(reserveCalls).toBe(0);
    });
  });
});
