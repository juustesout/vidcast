import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FalVideoGenerationProvider, encodeFalJobId } from '@/lib/ai/video-generation/fal-provider';
import { stampHumanApproval } from '@/lib/explainer/human-approval';
import {
  refreshVideoGenerationAttempt,
  submitSceneVideoGeneration
} from '@/lib/generation/video-generation-service';
import type { MediaStore } from '@/lib/storage/media-store';
import type { ProjectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';
import { InMemoryPaidSubmitLedger, setPaidSubmitLedgerForTests } from '@/lib/spend/paid-submit-cap';
import { InMemoryExclusiveLock } from '@/lib/utils/exclusive-file-lock';

const BASE_URL = 'https://queue.test';
const ENDPOINT = 'minimax/h3-max-turbo/text-to-video';
const I2V_ENDPOINT = 'minimax/h3-max-turbo/image-to-video';
const VIDEO_BYTES = Buffer.from('000000186674797069736F6D0000020069736F6D69736F32', 'hex');

function createProject(): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-fal-service',
    title: 'FAL service test',
    description: 'desc',
    durationTarget: 20,
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
    assets: [],
    references: [],
    scenes: [
      {
        id: 'scene-fal-1',
        order: 1,
        duration: 5,
        type: 'video',
        narration: { text: '' },
        visual: {
          kind: 'generated_video',
          generation: {
            id: 'gen-fal-current',
            kind: 'video',
            status: 'generated',
            provider: 'fal',
            model: ENDPOINT,
            prompt: 'a lighthouse at dusk',
            referenceIds: [],
            aspectRatio: '16:9',
            duration: 5,
            createdAt: now,
            completedAt: now
          },
          attempts: []
        },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
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

interface Harness {
  store: Pick<ProjectStore, 'getProject' | 'mutateProject' | 'updateProject'>;
  media: Pick<MediaStore, 'saveGeneratedVideo' | 'exists' | 'readRelativeFile'>;
  registry: { getProvider(id: string): unknown };
  state: { project: Project };
  submitCalls: () => number;
  savedAssets: () => number;
  submitBodies: () => string[];
  sceneSubmitLocks: InMemoryExclusiveLock;
  attemptPollLocks: InMemoryExclusiveLock;
}

function createHarness(
  project: Project,
  opts: { failSubmit?: boolean; failStatus?: boolean; endpoint?: string; withReferences?: boolean; queueUrls?: boolean } = {}
): Harness {
  const state = { project: structuredClone(project) as Project };
  let submitCalls = 0;
  let savedAssets = 0;
  const submitBodies: string[] = [];
  const sceneSubmitLocks = new InMemoryExclusiveLock();
  const attemptPollLocks = new InMemoryExclusiveLock();

  const store = {
    async getProject(id: string) {
      return id === state.project.id ? (structuredClone(state.project) as Project) : null;
    },
    async updateProject(next: Project) {
      state.project = structuredClone(next) as Project;
      return state.project;
    },
    async mutateProject(id: string, mutator: (p: Project) => Project | Promise<Project>) {
      if (id !== state.project.id) return null;
      const next = await mutator(structuredClone(state.project) as Project);
      state.project = structuredClone(next) as Project;
      return state.project;
    }
  };

  const media = {
    async saveGeneratedVideo(input: { mimeType: string; data: Buffer; sceneOrder: number }) {
      savedAssets += 1;
      const now = new Date().toISOString();
      return {
        id: `asset-fal-${savedAssets}`,
        type: 'video' as const,
        status: 'available' as const,
        provenance: 'generated' as const,
        filename: `scene-${input.sceneOrder}-generated.mp4`,
        localPath: `assets/scene-${input.sceneOrder}-generated.mp4`,
        mimeType: input.mimeType,
        filesize: input.data.byteLength,
        metadata: {},
        createdAt: now,
        updatedAt: now
      };
    },
    async exists(_projectId: string, localPath: string) {
      return opts.withReferences === true && localPath.startsWith('references/');
    },
    async readRelativeFile() {
      return opts.withReferences === true ? Buffer.from('frame-bytes') : Buffer.from('');
    }
  };

  let pollCount = 0;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') {
      submitCalls += 1;
      if (opts.failSubmit) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      if (typeof init?.body === 'string') submitBodies.push(init.body);
      const payload: Record<string, string> = { request_id: 'req-service-1', status: 'IN_QUEUE' };
      if (opts.queueUrls) {
        payload.response_url = `${BASE_URL}/minimax/h3-max-turbo/requests/req-service-1`;
        payload.status_url = `${BASE_URL}/minimax/h3-max-turbo/requests/req-service-1/status`;
        payload.cancel_url = `${BASE_URL}/minimax/h3-max-turbo/requests/req-service-1/cancel`;
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    if (method === 'PUT' && url.endsWith('/cancel')) {
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (url.endsWith('/status?logs=1')) {
      if (opts.failStatus) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      pollCount += 1;
      const status = pollCount === 1 ? 'IN_QUEUE' : pollCount === 2 ? 'IN_PROGRESS' : 'COMPLETED';
      return new Response(JSON.stringify({ status }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (url.endsWith('/requests/req-service-1')) {
      return new Response(JSON.stringify({ video: { url: 'https://v3.fal.media/clip.mp4', content_type: 'video/mp4' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    if (url === 'https://v3.fal.media/clip.mp4') {
      return new Response(new Uint8Array(VIDEO_BYTES), { status: 200, headers: { 'content-type': 'video/mp4' } });
    }

    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };

  const registry = {
    getProvider(id: string) {
      expect(id).toBe('fal');
      return new FalVideoGenerationProvider({
        apiKey: 'fal-test-key',
        baseUrl: BASE_URL,
        endpoint: opts.endpoint ?? ENDPOINT,
        fetchImpl
      });
    }
  };

  return {
    store,
    media,
    registry,
    state,
    submitCalls: () => submitCalls,
    savedAssets: () => savedAssets,
    submitBodies: () => submitBodies,
    sceneSubmitLocks,
    attemptPollLocks
  };
}

function enablePaidSpendCap(overrides: Record<string, string> = {}): void {
  vi.stubEnv('PAID_SPEND_CAP_ENABLED', 'true');
  vi.stubEnv('PAID_SPEND_CAP_WINDOW_HOURS', '24');
  vi.stubEnv('PAID_SPEND_CAP_MAX_SUBMITS', '10');
  vi.stubEnv('PAID_SPEND_CAP_MAX_IMAGE_SUBMITS', '4');
  vi.stubEnv('PAID_SPEND_CAP_MAX_VIDEO_SUBMITS', '4');
  vi.stubEnv('PAID_SPEND_CAP_MAX_NARRATION_SUBMITS', '4');
  vi.stubEnv('PAID_SPEND_CAP_MAX_MUSIC_SUBMITS', '1');
  vi.stubEnv('PAID_SPEND_CAP_MAX_PRESENTER_SUBMITS', '1');
  for (const [name, value] of Object.entries(overrides)) {
    vi.stubEnv(name, value);
  }
}

beforeEach(() => {
  vi.stubEnv('FAL_KEY', 'fal-test-key');
  vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
  enablePaidSpendCap();
  setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
});

afterEach(() => {
  vi.unstubAllEnvs();
  setPaidSubmitLedgerForTests(undefined);
});

function depsOf(harness: Harness) {
  return {
    store: harness.store,
    media: harness.media,
    registry: harness.registry as never,
    sceneSubmitLocks: harness.sceneSubmitLocks,
    attemptPollLocks: harness.attemptPollLocks
  };
}

describe('FAL video generation through the scene service', () => {
  it('persists fal provider identity and endpoint across submit and poll', async () => {
    const harness = createHarness(withHumanApproval(createProject()));

    const submission = await submitSceneVideoGeneration(
      'project-fal-service',
      'scene-fal-1',
      { regenerate: true, provider: 'fal', mode: 'real' },
      depsOf(harness)
    );

    expect(submission.provider).toBe('fal');
    expect(submission.providerJobId).toBe(encodeFalJobId(ENDPOINT, 'req-service-1'));

    const persisted = harness.state.project.scenes[0];
    if (persisted.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    expect(persisted.visual.generation.provider).toBe('fal');
    expect(persisted.visual.generation.providerJobId).toBe(encodeFalJobId(ENDPOINT, 'req-service-1'));

    // Poll until complete. The composite job id carries the endpoint, so the
    // registry's freshly constructed provider polls the same model.
    let poll = await refreshVideoGenerationAttempt('project-fal-service', submission.generationAttemptId, depsOf(harness), {
      mode: 'real'
    });
    expect(poll.status).toBe('queued');
    poll = await refreshVideoGenerationAttempt('project-fal-service', submission.generationAttemptId, depsOf(harness), {
      mode: 'real'
    });
    expect(poll.status).toBe('generating');
    poll = await refreshVideoGenerationAttempt('project-fal-service', submission.generationAttemptId, depsOf(harness), {
      mode: 'real'
    });

    expect(poll.status).toBe('generated');
    expect(poll.provider).toBe('fal');
    expect(poll.assetId).toBeDefined();
    expect(harness.savedAssets()).toBe(1);
  });

  it('never resolves fal in mock mode (policy blocks before any provider call)', async () => {
    const harness = createHarness(withHumanApproval(createProject()));
    const getProvider = vi.spyOn(harness.registry, 'getProvider');

    await expect(
      submitSceneVideoGeneration(
        'project-fal-service',
        'scene-fal-1',
        { regenerate: true, provider: 'fal', mode: 'mock' },
        depsOf(harness)
      )
    ).rejects.toThrow(/mock mode/i);

    expect(getProvider).not.toHaveBeenCalled();
    expect(harness.submitCalls()).toBe(0);
  });

  it('keeps an ambiguous submit timeout active without a job id so it cannot be resubmitted', async () => {
    const harness = createHarness(withHumanApproval(createProject()), { failSubmit: true });

    await expect(
      submitSceneVideoGeneration(
        'project-fal-service',
        'scene-fal-1',
        { regenerate: true, provider: 'fal', mode: 'real' },
        depsOf(harness)
      )
    ).rejects.toMatchObject({ code: 'generation.attempt.submitUnresolved' });

    expect(harness.submitCalls()).toBe(1);

    const persisted = harness.state.project.scenes[0];
    if (persisted.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    // The request may have reached FAL before the timeout, so the attempt stays
    // active (no job id) and blocks a second paid submission.
    expect(persisted.visual.generation.status).toBe('queued');
    expect(persisted.visual.generation.providerJobId).toBeUndefined();
    expect(persisted.visual.generation.providerStatus).toBe('submit_unresolved');
    expect(persisted.visual.generation.metadata?.submitUnresolved).toBe(true);

    await expect(
      submitSceneVideoGeneration(
        'project-fal-service',
        'scene-fal-1',
        { regenerate: true, provider: 'fal', mode: 'real' },
        depsOf(harness)
      )
    ).rejects.toMatchObject({ code: 'generation.scene.busy' });
    expect(harness.submitCalls()).toBe(1);
  });

  it('keeps a timed-out poll attempt active (resumable, same job id) instead of failing it', async () => {
    const harness = createHarness(withHumanApproval(createProject()), { failStatus: true });

    const submission = await submitSceneVideoGeneration(
      'project-fal-service',
      'scene-fal-1',
      { regenerate: true, provider: 'fal', mode: 'real' },
      depsOf(harness)
    );

    await expect(
      refreshVideoGenerationAttempt('project-fal-service', submission.generationAttemptId, depsOf(harness), { mode: 'real' })
    ).rejects.toMatchObject({ code: 'generation.attempt.statusUnresolved' });

    const persisted = harness.state.project.scenes[0];
    if (persisted.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    // A transient poll failure must not fail the attempt: the remote job may still
    // be running, so the attempt stays active with its job identity preserved for
    // recovery (and a new paid submission is blocked in the meantime).
    expect(persisted.visual.generation.status).not.toBe('failed');
    expect(persisted.visual.generation.providerStatus).toBe('status_unresolved');
    expect(persisted.visual.generation.providerJobId).toBe(encodeFalJobId(ENDPOINT, 'req-service-1'));
    expect(persisted.visual.generation.providerJobId).toContain(ENDPOINT);
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

  it('submits, resumes and downloads an image-to-video job using keyframe data URIs', async () => {
    const project = createProject();
    addReference(project, 'ref-fal-1');
    addReference(project, 'ref-fal-2');
    const scene = project.scenes[0];
    if (scene.visual?.kind !== 'generated_video') throw new Error('expected generated_video');
    scene.visual.generation = {
      ...scene.visual.generation,
      model: I2V_ENDPOINT,
      referenceIds: ['ref-fal-1', 'ref-fal-2'],
      startFrameReferenceId: 'ref-fal-1',
      endFrameReferenceId: 'ref-fal-2'
    };
    scene.referenceIds = ['ref-fal-1', 'ref-fal-2'];

    const harness = createHarness(withHumanApproval(project), { endpoint: I2V_ENDPOINT, withReferences: true, queueUrls: true });

    const submission = await submitSceneVideoGeneration(
      'project-fal-service',
      'scene-fal-1',
      { regenerate: true, provider: 'fal', mode: 'real' },
      depsOf(harness)
    );

    // The response URLs carry the shortened queue path, which the composite job id records.
    expect(submission.providerJobId).toBe(encodeFalJobId('minimax/h3-max-turbo', 'req-service-1'));

    const body = JSON.parse(harness.submitBodies()[0]) as Record<string, unknown>;
    const frameUri = `data:image/png;base64,${Buffer.from('frame-bytes').toString('base64')}`;
    expect(body.image_url).toBe(frameUri);
    expect(body.end_image_url).toBe(frameUri);
    expect(body.sync_mode).toBe(false);
    expect(body).not.toHaveProperty('aspect_ratio');

    // Each poll constructs a fresh provider through the registry; the composite job id
    // lets the new instance resolve the same queue path without the original provider.
    let poll = await refreshVideoGenerationAttempt('project-fal-service', submission.generationAttemptId, depsOf(harness), {
      mode: 'real'
    });
    expect(poll.status).toBe('queued');
    poll = await refreshVideoGenerationAttempt('project-fal-service', submission.generationAttemptId, depsOf(harness), {
      mode: 'real'
    });
    expect(poll.status).toBe('generating');
    poll = await refreshVideoGenerationAttempt('project-fal-service', submission.generationAttemptId, depsOf(harness), {
      mode: 'real'
    });

    expect(poll.status).toBe('generated');
    expect(poll.provider).toBe('fal');
    expect(poll.assetId).toBeDefined();
    expect(harness.savedAssets()).toBe(1);
  });
});
