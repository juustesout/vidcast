import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeImageGenerationProvider } from '@/lib/ai/image-generation/fake-provider';
import { stampHumanApproval } from '@/lib/explainer/human-approval';
import { generateSceneImage, SceneImageGenerationError } from '@/lib/generation/image-generation-service';
import { InMemoryPaidSubmitLedger, setPaidSubmitLedgerForTests } from '@/lib/spend/paid-submit-cap';
import type { MediaStore } from '@/lib/storage/media-store';
import type { ProjectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';

function createProject(): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-1',
    title: 'Generation Service Test',
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
        id: 'asset-old',
        type: 'image',
        status: 'available',
        provenance: 'generated',
        filename: 'old.png',
        localPath: 'assets/old.png',
        mimeType: 'image/png',
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
        id: 'scene-1',
        order: 1,
        duration: 5,
        type: 'image',
        narration: { text: '' },
        visual: {
          kind: 'generated_image',
          assetId: 'asset-old',
          generation: {
            id: 'gen-current',
            kind: 'image',
            status: 'generated',
            provider: 'openai',
            model: 'gpt-image-1',
            prompt: 'old prompt',
            referenceIds: ['ref-1'],
            aspectRatio: '16:9',
            assetId: 'asset-old',
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

function createInMemoryDependencies(project: Project, providerBehavior?: { throwError?: boolean }) {
  const state = { project: structuredClone(project) as Project };
  const fakeProvider = new FakeImageGenerationProvider();

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

  let createdAssetCount = 0;
  let generateImageCalls = 0;

  const media: Pick<MediaStore, 'saveGeneratedImage' | 'exists' | 'readRelativeFile'> = {
    async saveGeneratedImage(input) {
      createdAssetCount += 1;
      return {
        id: `asset-generated-${createdAssetCount}`,
        type: 'image',
        status: 'available',
        provenance: 'generated',
        filename: `scene-${input.sceneOrder}-generated.png`,
        localPath: `assets/scene-${input.sceneOrder}-generated.png`,
        mimeType: input.mimeType,
        width: 1,
        height: 1,
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
      return localPath === 'references/ref.png';
    },
    async readRelativeFile() {
      return Buffer.from('ref-bytes');
    }
  };

  const registry = {
    getProvider() {
      if (providerBehavior?.throwError) {
        return {
          providerId: 'fake',
          async generateImage() {
            generateImageCalls += 1;
            throw new Error('provider failed');
          }
        };
      }
      return {
        providerId: fakeProvider.providerId,
        async generateImage(request: Parameters<FakeImageGenerationProvider['generateImage']>[0]) {
          generateImageCalls += 1;
          return fakeProvider.generateImage(request);
        }
      };
    }
  };

  return { state, store, media, registry, generateImageCalls: () => generateImageCalls };
}

afterEach(() => {
  vi.unstubAllEnvs();
  setPaidSubmitLedgerForTests(undefined);
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

describe('image generation service', () => {
  it('successful regeneration creates new asset and updates scene', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project);

    const result = await generateSceneImage(project.id, 'scene-1', { regenerate: true }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

    expect(result.status).toBe('generated');
    expect(result.assetId).toBeDefined();

    const scene = deps.state.project.scenes[0];
    expect(scene.visual && (scene.visual.kind === 'generated_image')).toBe(true);
    if (scene.visual && scene.visual.kind === 'generated_image') {
      expect(scene.visual.assetId).toBe(result.assetId);
      expect(scene.visual.generation.status).toBe('generated');
      expect(scene.visual.attempts && scene.visual.attempts.length).toBeGreaterThan(0);
    }

    expect(deps.state.project.assets.length).toBe(2);
    const serialized = JSON.stringify(deps.state.project);
    expect(serialized.includes('iVBOR')).toBe(false);
  });

  it('fails before provider call when reference file is missing', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project);
    deps.media.exists = async () => false;

    await expect(
      generateSceneImage(project.id, 'scene-1', { regenerate: true }, {
        store: deps.store,
        media: deps.media,
        registry: deps.registry as never
      })
    ).rejects.toThrow(SceneImageGenerationError);
  });

  it('marks attempt failed and preserves previous asset on provider failure', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project, { throwError: true });

    await expect(
      generateSceneImage(project.id, 'scene-1', { regenerate: true }, {
        store: deps.store,
        media: deps.media,
        registry: deps.registry as never
      })
    ).rejects.toThrow(SceneImageGenerationError);

    const scene = deps.state.project.scenes[0];
    if (scene.visual && scene.visual.kind === 'generated_image') {
      expect(scene.visual.assetId).toBe('asset-old');
      expect(scene.visual.generation.status).toBe('failed');
      expect(scene.visual.generation.errorMessage).toBe('provider failed');
      expect(scene.visual.generation.errorCode).toBe('INTERNAL');
    }

    expect(deps.state.project.assets.length).toBe(1);
  });

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

  it('blocks real image generation without human approval', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const project = createProject();
    const deps = createInMemoryDependencies(project);

    await expect(
      generateSceneImage(project.id, 'scene-1', { regenerate: true, mode: 'real', provider: 'openai' }, {
        store: deps.store,
        media: deps.media,
        registry: deps.registry as never
      })
    ).rejects.toMatchObject({
      status: 403,
      code: 'generation.approval.required'
    });
  });

  it('allows real image generation after a matching human approval', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const project = withHumanApproval(createProject());
    const deps = createInMemoryDependencies(project);

    const result = await generateSceneImage(project.id, 'scene-1', { regenerate: true, mode: 'real', provider: 'openai' }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

    expect(result.status).toBe('generated');
  });

  it('blocks a real image submit when the host cap is exhausted', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '0', PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '2' });
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
    const project = withHumanApproval(createProject());
    const deps = createInMemoryDependencies(project);

    await expect(
      generateSceneImage(project.id, 'scene-1', { regenerate: true, mode: 'real', provider: 'openai' }, {
        store: deps.store,
        media: deps.media,
        registry: deps.registry as never
      })
    ).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.exceeded'
    });
    expect(deps.generateImageCalls()).toBe(0);
  });

  it('allows one remaining real image submit and denies a regenerate after the cap is spent', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '1', PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '1' });
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
    const project = withHumanApproval(createProject());
    const deps = createInMemoryDependencies(project);

    const first = await generateSceneImage(project.id, 'scene-1', { regenerate: true, mode: 'real', provider: 'openai' }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });
    expect(first.status).toBe('generated');
    expect(deps.generateImageCalls()).toBe(1);

    const secondProject = withHumanApproval(createProject());
    secondProject.id = 'project-2';
    const secondDeps = createInMemoryDependencies(secondProject);

    await expect(
      generateSceneImage(secondProject.id, 'scene-1', { regenerate: true, mode: 'real', provider: 'openai' }, {
        store: secondDeps.store,
        media: secondDeps.media,
        registry: secondDeps.registry as never
      })
    ).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.exceeded'
    });
    expect(secondDeps.generateImageCalls()).toBe(0);
  });

  it('does not consult the spend ledger for mock image generation', async () => {
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

    const result = await generateSceneImage(project.id, 'scene-1', { regenerate: true }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });
    expect(result.status).toBe('generated');
    expect(reserveCalls).toBe(0);
  });

  it('fails closed when the spend cap is enabled without limit env', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('PAID_SPEND_CAP_ENABLED', 'true');
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
    const project = withHumanApproval(createProject());
    const deps = createInMemoryDependencies(project);

    await expect(
      generateSceneImage(project.id, 'scene-1', { regenerate: true, mode: 'real', provider: 'openai' }, {
        store: deps.store,
        media: deps.media,
        registry: deps.registry as never
      })
    ).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.invalid'
    });
    expect(deps.generateImageCalls()).toBe(0);
  });
});
