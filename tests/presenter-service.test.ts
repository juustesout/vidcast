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

function presenterAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'presenter-asset-existing',
    type: 'video',
    status: 'available',
    provenance: 'generated',
    filename: 'presenter.mp4',
    localPath: 'assets/presenter.mp4',
    mimeType: 'video/mp4',
    duration: 2,
    metadata: {},
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides
  };
}

const CURRENT_NARRATION_SIGNATURE = 'text:Hello world|voice:voice-1|model:model-1|format:wav|asset:audio-1';

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
  let balanceCalls = 0;

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
    ...(provider.getBillingBalanceUsd
      ? {
          async getBillingBalanceUsd() {
            balanceCalls += 1;
            return provider.getBillingBalanceUsd?.();
          }
        }
      : {}),
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
    },
    get balanceCalls() {
      return balanceCalls;
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

function heygenProvider(balances: Array<number | undefined> = []): PresenterProvider {
  let balanceIndex = 0;
  return {
    providerId: 'heygen',
    displayName: 'Injected HeyGen',
    capabilities: { supportsAudioInput: true, supportsTransparency: false, supportsWebm: false },
    async submit() {
      return { providerJobId: 'heygen-job-1', providerStatus: 'pending' };
    },
    async getStatus() {
      return { status: 'generated', providerStatus: 'completed', durationSeconds: 2 };
    },
    async download() {
      return { data: Buffer.from('fake-video'), mimeType: 'video/mp4', durationSeconds: 2 };
    },
    async getBillingBalanceUsd() {
      const value = balances[Math.min(balanceIndex, balances.length - 1)];
      balanceIndex += 1;
      return value;
    }
  };
}

function configureRealPresenterPricing(pricing = JSON.stringify({
  billingIncrementSeconds: 1,
  rates: [
    { engine: 'avatar_iii', avatarType: 'photo_avatar', resolution: '1080p', usdPerSecond: 0.05 }
  ]
})): void {
  vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
  vi.stubEnv('HEYGEN_API_KEY', 'test-key');
  vi.stubEnv('HEYGEN_AVATAR_TYPE', 'photo_avatar');
  vi.stubEnv('HEYGEN_PRESENTER_ENGINE', 'avatar_iii');
  vi.stubEnv('HEYGEN_PRICING_JSON', pricing);
}

function realProject(overrides: {
  maxCostUsd?: number;
  outputFormat?: 'mp4' | 'webm';
  presenterClips?: Project['presenterClips'];
  assets?: Asset[];
} = {}): Project {
  return buildProject({
    presenter: {
      enabled: true,
      provider: 'heygen',
      avatarId: 'avatar-1',
      outputFormat: overrides.outputFormat ?? 'mp4',
      sceneSettings: [{ sceneId: 'scene-1', layout: 'fullscreen' }],
      maxGeneratedSeconds: 20,
      maxPaidRequests: 2,
      maxCostUsd: overrides.maxCostUsd ?? 0.2
    },
    presenterClips: overrides.presenterClips,
    ...(overrides.assets ? { assets: overrides.assets } : {})
  });
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
      assets: [audioAsset(), presenterAsset()],
      presenterClips: [
        {
          sceneId: 'scene-1',
          status: 'generated',
          provider: 'mock',
          outputFormat: 'mp4',
          assetId: 'presenter-asset-existing',
          audioAssetId: 'audio-1',
          narrationSignature: CURRENT_NARRATION_SIGNATURE,
          duration: 2
        }
      ]
    });
    const deps = await createDependencies(project, mockProvider());

    await expect(submitPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps)).rejects.toMatchObject({
      code: 'presenter.scene.alreadyGenerated'
    });
    expect(deps.submitCalls).toBe(0);
  });

  it('submits a WebM request even when an MP4 clip already exists', async () => {
    const project = buildProject({
      presenter: {
        enabled: true,
        provider: 'mock',
        outputFormat: 'webm',
        sceneSettings: [{ sceneId: 'scene-1', layout: 'pip' }],
        maxGeneratedSeconds: 20,
        maxPaidRequests: 2
      },
      assets: [audioAsset(), presenterAsset()],
      presenterClips: [
        {
          sceneId: 'scene-1',
          status: 'generated',
          provider: 'mock',
          outputFormat: 'mp4',
          assetId: 'presenter-asset-existing',
          audioAssetId: 'audio-1',
          narrationSignature: CURRENT_NARRATION_SIGNATURE,
          duration: 2
        }
      ]
    });
    const deps = await createDependencies(project, mockProvider());

    const submitted = await submitPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps);
    expect(submitted.status).toBe('accepted');
    expect(deps.submitCalls).toBe(1);
    expect(deps.state.project.presenterClips?.[0]?.outputFormat).toBe('webm');
  });

  it('submits an MP4 request even when a WebM clip already exists', async () => {
    const project = buildProject({
      assets: [audioAsset(), presenterAsset({ filename: 'presenter.webm', mimeType: 'video/webm' })],
      presenterClips: [
        {
          sceneId: 'scene-1',
          status: 'generated',
          provider: 'mock',
          outputFormat: 'webm',
          assetId: 'presenter-asset-existing',
          audioAssetId: 'audio-1',
          narrationSignature: CURRENT_NARRATION_SIGNATURE,
          duration: 2
        }
      ]
    });
    const deps = await createDependencies(project, mockProvider());

    const submitted = await submitPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps);
    expect(submitted.status).toBe('accepted');
    expect(deps.submitCalls).toBe(1);
    expect(deps.state.project.presenterClips?.[0]?.outputFormat).toBe('mp4');
  });

  it('submits once for a stale clip instead of treating it as current', async () => {
    const project = buildProject({
      assets: [audioAsset(), presenterAsset()],
      presenterClips: [
        {
          sceneId: 'scene-1',
          status: 'generated',
          provider: 'mock',
          outputFormat: 'mp4',
          assetId: 'presenter-asset-existing',
          audioAssetId: 'audio-1',
          narrationSignature: 'stale-signature',
          duration: 2
        }
      ]
    });
    const deps = await createDependencies(project, mockProvider());

    const submitted = await submitPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps);
    expect(submitted.status).toBe('accepted');
    expect(deps.submitCalls).toBe(1);

    await expect(submitPresenterClip(project.id, 'scene-1', { mode: 'mock' }, deps)).rejects.toMatchObject({
      code: 'presenter.scene.alreadyRunning'
    });
    expect(deps.submitCalls).toBe(1);
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

  it('records the conservative estimate and measured wallet delta for a paid clip', async () => {
    configureRealPresenterPricing();
    const project = realProject();
    const deps = await createDependencies(project, heygenProvider([5, 4.9]));

    const submitted = await submitPresenterClip(project.id, 'scene-1', { mode: 'real' }, deps);
    expect(submitted.status).toBe('accepted');
    expect(deps.balanceCalls).toBe(2);

    const attempt = deps.state.project.presenterClips?.[0]?.attempts?.[0];
    expect(attempt?.cost).toMatchObject({
      currency: 'USD',
      engine: 'avatar_iii',
      avatarType: 'photo_avatar',
      resolution: '1080p',
      seconds: 2,
      billableSeconds: 2,
      usdPerSecond: 0.05,
      linearUsd: 0.1,
      estimatedUsd: 0.1,
      maxCostUsd: 0.2,
      observedUsd: 0.1,
      observedSource: 'wallet_delta'
    });
    expect(attempt?.walletBalanceBeforeUsd).toBe(5);

    const completed = await pollPresenterClip(project.id, 'scene-1', { mode: 'real' }, deps);
    expect(completed.status).toBe('generated');
    expect(deps.state.project.presenterClips?.[0]?.attempts?.[0]?.cost?.observedUsd).toBe(0.1);
  });

  it('blocks a paid submission before any provider call when pricing config is missing', async () => {
    configureRealPresenterPricing();
    vi.stubEnv('HEYGEN_PRICING_JSON', '');
    const project = realProject();
    const deps = await createDependencies(project, heygenProvider([5]));

    await expect(
      submitPresenterClip(project.id, 'scene-1', { mode: 'real' }, deps)
    ).rejects.toMatchObject({ code: 'presenter.cost.notConfigured' });
    expect(deps.submitCalls).toBe(0);
    expect(deps.balanceCalls).toBe(0);
    expect(deps.state.project.presenterClips ?? []).toEqual([]);
  });

  it('blocks a paid submission before any provider call when the rate is unknown', async () => {
    configureRealPresenterPricing(JSON.stringify({
      billingIncrementSeconds: 1,
      rates: [
        { engine: 'avatar_iii', avatarType: 'photo_avatar', resolution: '720p', usdPerSecond: 0.05 }
      ]
    }));
    const project = realProject();
    const deps = await createDependencies(project, heygenProvider([5]));

    await expect(
      submitPresenterClip(project.id, 'scene-1', { mode: 'real' }, deps)
    ).rejects.toMatchObject({ code: 'presenter.cost.notConfigured' });
    expect(deps.submitCalls).toBe(0);
    expect(deps.balanceCalls).toBe(0);
  });

  it('blocks a paid submission before any provider call when the USD limit is missing', async () => {
    configureRealPresenterPricing();
    const project = realProject({ maxCostUsd: 0 });
    const deps = await createDependencies(project, heygenProvider([5]));

    await expect(
      submitPresenterClip(project.id, 'scene-1', { mode: 'real' }, deps)
    ).rejects.toMatchObject({ code: 'presenter.cost.notConfigured' });
    expect(deps.submitCalls).toBe(0);
    expect(deps.balanceCalls).toBe(0);
    expect(deps.state.project.presenterClips ?? []).toEqual([]);
  });

  it('blocks a WebM pilot before provider submit when the USD limit is negative', async () => {
    configureRealPresenterPricing();
    const project = realProject({ maxCostUsd: -1, outputFormat: 'webm' });
    const deps = await createDependencies(project, heygenProvider([5]));

    await expect(
      submitPresenterClip(project.id, 'scene-1', { mode: 'real' }, deps)
    ).rejects.toMatchObject({ code: 'presenter.cost.notConfigured' });
    expect(deps.submitCalls).toBe(0);
    expect(deps.balanceCalls).toBe(0);
    expect(deps.state.project.presenterClips ?? []).toEqual([]);
  });

  it('blocks a WebM pilot before provider submit when pricing JSON is missing', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('HEYGEN_API_KEY', 'test-key');
    vi.stubEnv('HEYGEN_AVATAR_TYPE', 'photo_avatar');
    vi.stubEnv('HEYGEN_PRESENTER_ENGINE', 'avatar_iii');
    const project = realProject({ outputFormat: 'webm' });
    const deps = await createDependencies(project, heygenProvider([5]));

    await expect(
      submitPresenterClip(project.id, 'scene-1', { mode: 'real' }, deps)
    ).rejects.toMatchObject({ code: 'presenter.cost.notConfigured' });
    expect(deps.submitCalls).toBe(0);
    expect(deps.balanceCalls).toBe(0);
    expect(deps.state.project.presenterClips ?? []).toEqual([]);
  });

  it('blocks a paid submission when the USD estimate exceeds the project limit', async () => {
    configureRealPresenterPricing();
    const project = realProject({ maxCostUsd: 0.01 });
    const deps = await createDependencies(project, heygenProvider([5]));

    await expect(
      submitPresenterClip(project.id, 'scene-1', { mode: 'real' }, deps)
    ).rejects.toMatchObject({ code: 'presenter.budget.exceeded' });
    expect(deps.submitCalls).toBe(0);
    expect(deps.balanceCalls).toBe(0);
    expect(deps.state.project.presenterClips ?? []).toEqual([]);
  });

  it('allows an explicit retry after a failed paid attempt within the budget', async () => {
    configureRealPresenterPricing();
    const project = realProject({
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
    const deps = await createDependencies(project, heygenProvider([5, 4.9]));

    const submitted = await submitPresenterClip(project.id, 'scene-1', { mode: 'real', regenerate: true }, deps);
    expect(submitted.status).toBe('accepted');
    expect(deps.submitCalls).toBe(1);
    expect(deps.state.project.presenterClips?.[0]?.attempts).toHaveLength(2);
  });
});
