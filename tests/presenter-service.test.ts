import fs from 'node:fs/promises';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { PresenterJobStatus, PresenterProvider } from '@/lib/ai/presenter/provider';
import {
  pollPresenterClip,
  PresenterGenerationError,
  submitPresenterClip
} from '@/lib/generation/presenter-service';
import type { MediaStore } from '@/lib/storage/media-store';
import type { ProjectStore } from '@/lib/storage/project-store';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import type { Asset } from '@/lib/types/asset';
import type { PresenterClipAttempt } from '@/lib/types/presenter';
import type { Project } from '@/lib/types/render';

const CREATED = '2026-01-01T00:00:00.000Z';
const createdRoots: string[] = [];

function audioAsset(): Asset {
  return {
    id: 'audio-1',
    type: 'audio',
    status: 'available',
    provenance: 'generated',
    filename: 'narration.wav',
    localPath: 'assets/narration.wav',
    mimeType: 'audio/wav',
    duration: 2,
    metadata: { voiceId: 'voice-1' },
    generation: { model: 'model-1', prompt: 'Hello world', referenceIds: [] },
    createdAt: CREATED,
    updatedAt: CREATED
  };
}

function buildProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-presenter-service',
    title: 'Presenter service test',
    description: '',
    durationTarget: 10,
    aspectRatio: '16:9',
    fps: 30,
    narration: { text: '', segments: [] },
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 2,
        type: 'text',
        visual: { kind: 'text', text: 'Hello world' },
        narration: {
          text: 'Hello world',
          voiceId: 'voice-1',
          model: 'model-1',
          format: 'wav',
          audioAssetId: 'audio-1',
          status: 'generated',
          duration: 2,
          attempts: [
            {
              id: 'narration-1',
              status: 'generated',
              provider: 'fake',
              model: 'model-1',
              voiceId: 'voice-1',
              format: 'wav',
              audioAssetId: 'audio-1',
              createdAt: CREATED
            }
          ]
        },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: '',
        renders: []
      }
    ],
    assets: [audioAsset()],
    references: [],
    compositions: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    presenter: {
      enabled: true,
      provider: 'mock',
      outputFormat: 'mp4',
      sceneSettings: [{ sceneId: 'scene-1', layout: 'pip' }],
      maxGeneratedSeconds: 20,
      maxPaidRequests: 2
    },
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides
  };
}

function realAttempt(overrides: Partial<PresenterClipAttempt> = {}): PresenterClipAttempt {
  return {
    id: 'presenter-attempt-old',
    status: 'failed',
    provider: 'heygen',
    providerJobId: 'job-old',
    outputFormat: 'mp4',
    audioAssetId: 'audio-1',
    narrationSignature: 'text:Hello world|voice:voice-1|model:model-1|format:wav|asset:audio-1',
    duration: 2,
    createdAt: CREATED,
    ...overrides
  };
}

async function createDependencies(project: Project, provider: PresenterProvider, statuses: PresenterJobStatus[] = []) {
  const root = getProjectRoot(project.id);
  createdRoots.push(root);
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'assets', 'narration.wav'), Buffer.from('fake-audio'));

  const state = { project: structuredClone(project) };
  const now = new Date().toISOString();
  let assetCount = 0;
  let submitCalls = 0;
  let statusCalls = 0;

  const store: Pick<ProjectStore, 'getProject' | 'mutateProject'> = {
    async getProject(id) {
      return id === state.project.id ? (structuredClone(state.project) as Project) : null;
    },
    async mutateProject(id, mutator) {
      if (id !== state.project.id) {
        return null;
      }
      const next = await mutator(structuredClone(state.project) as Project);
      state.project = structuredClone(next) as Project;
      return state.project;
    }
  };

  const media: Pick<MediaStore, 'saveGeneratedPresenter'> = {
    async saveGeneratedPresenter(input) {
      assetCount += 1;
      return {
        id: `presenter-asset-${assetCount}`,
        type: 'video',
        status: 'available',
        provenance: 'generated',
        filename: `scene-${input.sceneOrder}-presenter.mp4`,
        localPath: `assets/scene-${input.sceneOrder}-presenter.mp4`,
        mimeType: input.mimeType,
        duration: 2,
        width: 1080,
        height: 1920,
        filesize: input.data.byteLength,
        metadata: { presenter: true, presenterLayout: input.layout },
        generation: {
          generationId: input.generation.generationId,
          provider: input.generation.provider,
          model: input.generation.model,
          prompt: input.generation.prompt,
          referenceIds: [],
          providerJobId: input.generation.providerJobId
        },
        createdAt: now,
        updatedAt: now
      };
    }
  };

  const wrappedProvider: PresenterProvider = {
    ...provider,
    async submit(request) {
      submitCalls += 1;
      return provider.submit(request);
    },
    async getStatus(jobId) {
      statusCalls += 1;
      const next = statuses.shift();
      if (next) {
        return next;
      }
      return provider.getStatus(jobId);
    }
  };

  const registry = {
    getProvider(providerId: string) {
      if (providerId !== wrappedProvider.providerId) {
        throw new Error(`Unknown presenter provider: ${providerId}`);
      }
      return wrappedProvider;
    }
  };

  return {
    state,
    store,
    media,
    registry: registry as never,
    get submitCalls() {
      return submitCalls;
    },
    get statusCalls() {
      return statusCalls;
    }
  };
}

function mockProvider(behavior: { failSubmit?: boolean } = {}): PresenterProvider {
  return {
    providerId: 'mock',
    displayName: 'Mock presenter',
    capabilities: { supportsAudioInput: true, supportsTransparency: false, supportsWebm: false },
    async submit() {
      if (behavior.failSubmit) {
        throw new Error('submit exploded');
      }
      return { providerJobId: 'mock-job-1', providerStatus: 'queued' };
    },
    async getStatus() {
      return { status: 'generated', providerStatus: 'completed', durationSeconds: 2 };
    },
    async download() {
      return { data: Buffer.from('fake-video'), mimeType: 'video/mp4', durationSeconds: 2 };
    }
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await Promise.all(createdRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('presenter generation service', () => {
  it('submits narration audio and stores the generated presenter clip', async () => {
    const project = buildProject();
    const deps = await createDependencies(project, mockProvider(), [
      { status: 'generating', providerStatus: 'processing' },
      { status: 'generated', providerStatus: 'completed', durationSeconds: 2 }
    ]);

    const submitted = await submitPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps);
    expect(submitted).toMatchObject({
      status: 'accepted',
      provider: 'mock',
      providerJobId: 'mock-job-1'
    });
    expect(deps.state.project.presenterClips?.[0]).toMatchObject({
      status: 'generating',
      audioAssetId: 'audio-1'
    });

    const pending = await pollPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps);
    expect(pending.status).toBe('generating');

    const completed = await pollPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps);
    expect(completed.status).toBe('generated');
    expect(completed.assetId).toBe('presenter-asset-1');

    const clip = deps.state.project.presenterClips?.[0];
    expect(clip).toMatchObject({ status: 'generated', assetId: 'presenter-asset-1' });
    expect(deps.state.project.assets.some((asset) => asset.id === 'presenter-asset-1')).toBe(true);
  });

  it('rejects duplicate submission while a generated clip already exists', async () => {
    const project = buildProject({
      presenterClips: [
        {
          sceneId: 'scene-1',
          status: 'generated',
          provider: 'mock',
          outputFormat: 'mp4',
          assetId: 'presenter-asset-existing',
          audioAssetId: 'audio-1',
          narrationSignature: 'text:Hello world|voice:voice-1|model:model-1|format:wav|asset:audio-1',
          duration: 2
        }
      ]
    });
    const deps = await createDependencies(project, mockProvider());

    await expect(submitPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps)).rejects.toMatchObject({
      code: 'presenter.scene.alreadyGenerated'
    });
  });

  it('rejects stale narration before calling the provider', async () => {
    const project = buildProject();
    project.scenes[0].narration = { ...project.scenes[0].narration!, text: 'Changed script' };
    const deps = await createDependencies(project, mockProvider());

    await expect(submitPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps)).rejects.toMatchObject({
      code: 'presenter.narration.notCurrent'
    });
    expect(deps.submitCalls).toBe(0);
  });

  it('prevents mock mode from submitting to a real provider', async () => {
    const makeProject = () => buildProject({
      presenter: {
        enabled: true,
        provider: 'heygen',
        avatarId: 'avatar-1',
        outputFormat: 'mp4',
        sceneSettings: [{ sceneId: 'scene-1', layout: 'fullscreen' }]
      }
    });
    const project = makeProject();
    const provider: PresenterProvider = {
      ...mockProvider(),
      providerId: 'heygen',
      displayName: 'Injected HeyGen'
    };
    const deps = await createDependencies(project, provider);

    await expect(submitPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps)).rejects.toMatchObject({
      code: 'presenter.provider.unsupported'
    });
    expect(deps.submitCalls).toBe(0);
    expect(deps.state.project.presenterClips ?? []).toEqual([]);
  });

  it('prevents mock mode from polling a real provider job', async () => {
    const project = buildProject({
      presenterClips: [
        {
          sceneId: 'scene-1',
          status: 'generating',
          provider: 'heygen',
          outputFormat: 'mp4',
          audioAssetId: 'audio-1',
          narrationSignature: 'signature',
          duration: 2,
          lastAttemptId: 'real-attempt',
          attempts: [realAttempt({ id: 'real-attempt', status: 'generating' })]
        }
      ]
    });
    const deps = await createDependencies(project, mockProvider());

    await expect(pollPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps)).rejects.toMatchObject({
      code: 'presenter.provider.unsupported'
    });
    expect(deps.statusCalls).toBe(0);
  });

  it('blocks a paid submission when the request budget is exhausted', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('HEYGEN_API_KEY', 'test-key');
    const project = buildProject({
      presenter: {
        enabled: true,
        provider: 'heygen',
        avatarId: 'avatar-1',
        outputFormat: 'mp4',
        sceneSettings: [{ sceneId: 'scene-1', layout: 'fullscreen' }],
        maxGeneratedSeconds: 2,
        maxPaidRequests: 1
      },
      presenterClips: [
        {
          sceneId: 'scene-1',
          status: 'failed',
          provider: 'heygen',
          outputFormat: 'mp4',
          audioAssetId: 'audio-1',
          narrationSignature: 'signature',
          duration: 2,
          lastAttemptId: 'presenter-attempt-old',
          attempts: [realAttempt()]
        }
      ]
    });
    const provider: PresenterProvider = {
      ...mockProvider(),
      providerId: 'heygen',
      displayName: 'Injected HeyGen'
    };
    const deps = await createDependencies(project, provider);

    await expect(
      submitPresenterClip(project.id, 'scene-1', { mode: 'real', regenerate: true }, deps)
    ).rejects.toMatchObject({ code: 'presenter.budget.exceeded' });
    expect(deps.submitCalls).toBe(0);
  });

  it('blocks a second concurrent submission for the same scene', async () => {
    const project = buildProject();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = mockProvider();
    const slowProvider: PresenterProvider = {
      ...provider,
      async submit(request) {
        await gate;
        return provider.submit(request);
      }
    };
    const deps = await createDependencies(project, slowProvider);

    const first = submitPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps);
    await expect(submitPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps)).rejects.toMatchObject({
      code: 'presenter.scene.alreadyRunning'
    });
    release?.();
    await expect(first).resolves.toMatchObject({ status: 'accepted' });
  });

  it('surfaces provider failures with a recoverable error code', async () => {
    const project = buildProject();
    const deps = await createDependencies(project, mockProvider({ failSubmit: true }));

    await expect(submitPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps)).rejects.toBeInstanceOf(
      PresenterGenerationError
    );
    expect(deps.state.project.presenterClips?.[0]?.status).toBe('failed');
  });
});
