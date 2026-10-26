import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import {
  clearProjectMusic,
  generateProjectMusic,
  ProjectMusicGenerationError,
  selectProjectMusic
} from '@/lib/generation/music-service';
import { stampHumanApproval } from '@/lib/explainer/human-approval';
import { InMemoryMandateSpendLedger, setMandateSpendLedgerForTests, setMandateSpendReaderForTests } from '@/lib/spend/mandate-spend';
import { InMemoryPaidSubmitLedger, setPaidSubmitLedgerForTests } from '@/lib/spend/paid-submit-cap';
import { MusicProviderError } from '@/lib/ai/music/provider';
import type { GeneratedMusicInput } from '@/lib/storage/media-store';
import type { ProjectStore } from '@/lib/storage/project-store';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import { FileExclusiveLock, InMemoryExclusiveLock } from '@/lib/utils/exclusive-file-lock';

function createProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-1',
    title: 'Music Service Test',
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
      width: 1280,
      height: 720,
      background: { type: 'color', value: '#000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    assets: [],
    references: [],
    scenes: [],
    ...overrides
  };
}

function createAsset(id: string, type: Asset['type'] = 'music'): Asset {
  const now = new Date().toISOString();
  return {
    id,
    type,
    status: 'available',
    provenance: 'generated',
    filename: `${id}.wav`,
    localPath: `assets/${id}.wav`,
    mimeType: 'audio/wav',
    duration: 60,
    filesize: 100,
    metadata: {},
    createdAt: now,
    updatedAt: now
  };
}

function createScene(id: string, duration: number) {
  return {
    id,
    order: Number(id.replace(/\D/g, '')) || 1,
    duration,
    type: 'blank' as const,
    narration: { text: '' },
    visual: { kind: 'blank' as const },
    render: { motion: { preset: 'none' as const }, transition: { type: 'none' as const } },
    overlay: { type: 'none' as const },
    referenceIds: [],
    notes: ''
  };
}

function createDependencies(
  project: Project,
  behavior: { fail?: boolean; providerError?: MusicProviderError; failFinalUpdate?: boolean; generateGate?: () => Promise<void> } = {}
) {
  const state = { project: structuredClone(project) as Project };
  const now = new Date().toISOString();
  const deletedAssets: string[] = [];
  const generatedRequests: Array<{ durationMs: number; model?: string; outputFormat?: string }> = [];
  let createdCount = 0;
  let generateCalls = 0;

  const store: Pick<ProjectStore, 'getProject' | 'updateProject' | 'mutateProject'> = {
    async getProject(id: string) {
      return id === state.project.id ? (structuredClone(state.project) as Project) : null;
    },
    async updateProject(next: Project) {
      if (behavior.failFinalUpdate && next.music?.status === 'generated') {
        throw new Error('disk full');
      }
      state.project = structuredClone(next) as Project;
      return state.project;
    },
    async mutateProject(id, mutator) {
      if (id !== state.project.id) {
        return null;
      }
      const next = await mutator(structuredClone(state.project) as Project);
      return store.updateProject(next);
    }
  };

  const media = {
    async saveGeneratedMusic(input: GeneratedMusicInput): Promise<Asset> {
      createdCount += 1;
      return {
        id: `asset-music-${createdCount}`,
        type: 'music',
        status: 'available',
        provenance: 'generated',
        filename: `music-${input.attemptId}.wav`,
        localPath: `assets/music-${input.attemptId}.wav`,
        mimeType: input.mimeType,
        duration: input.musicLengthMs ? input.musicLengthMs / 1000 : 60,
        filesize: input.data.byteLength,
        metadata: {},
        generation: input.generation,
        createdAt: now,
        updatedAt: now
      };
    },
    async deleteAssetFile(_projectId: string, asset: Asset): Promise<void> {
      deletedAssets.push(asset.id);
    }
  };

  const registry = {
    getProvider() {
      return {
        providerId: 'fake',
        async generate(request: { durationMs: number; model?: string; outputFormat?: string }) {
          generateCalls += 1;
          generatedRequests.push(request);
          if (behavior.generateGate) {
            await behavior.generateGate();
          }
          if (behavior.providerError) {
            throw behavior.providerError;
          }
          if (behavior.fail) {
            throw new Error('provider boom');
          }
          return {
            provider: 'fake',
            model: request.model ?? 'fake-music',
            mimeType: 'audio/wav',
            format: 'wav' as const,
            data: Buffer.alloc(128),
            duration: request.durationMs / 1000,
            providerRequestId: 'req-1'
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
    submitLocks: new InMemoryExclusiveLock(),
    createdCount: () => createdCount,
    deletedAssets,
    generatedRequests,
    generateCalls: () => generateCalls
  };
}

function musicServiceDeps(deps: ReturnType<typeof createDependencies>) {
  return {
    store: deps.store,
    media: deps.media,
    registry: deps.registry as never,
    submitLocks: deps.submitLocks
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

describe('project music generation service', () => {
  it('generates background music, saves a music asset and records the selection', async () => {
    const deps = createDependencies(createProject());

    const result = await generateProjectMusic('project-1', { prompt: 'calm ambient' }, musicServiceDeps(deps));

    expect(result.status).toBe('generated');
    expect(result.assetId).toBeDefined();
    expect(result.musicLengthMs).toBe(60_000);

    const music = deps.state.project.music;
    expect(music?.status).toBe('generated');
    expect(music?.assetId).toBe(result.assetId);
    expect(music?.prompt).toBe('calm ambient');
    expect(deps.state.project.assets).toHaveLength(1);
    expect(deps.state.project.assets[0].type).toBe('music');
  });

  it('clamps an out-of-range requested length to provider-safe bounds', async () => {
    const deps = createDependencies(createProject());
    const result = await generateProjectMusic('project-1', { prompt: 'p', musicLengthMs: 500 }, musicServiceDeps(deps));
    expect(result.musicLengthMs).toBe(3000);
  });

  it('derives the requested length from the resolved render timeline when none is given', async () => {
    const project = createProject({ scenes: [createScene('scene-1', 4), createScene('scene-2', 6)] });
    const deps = createDependencies(project);

    const result = await generateProjectMusic('project-1', { prompt: 'timeline' }, musicServiceDeps(deps));

    expect(deps.generatedRequests[0]?.durationMs).toBe(10_000);
    expect(result.musicLengthMs).toBe(10_000);
  });

  it('uses the timeline resolved from measured narration when it extends a scene', async () => {
    const narrationAsset = createAsset('audio-1', 'audio');
    narrationAsset.duration = 3.1;
    const scene = {
      ...createScene('scene-1', 2),
      narration: { text: 'measured', audioAssetId: narrationAsset.id, status: 'generated' as const, duration: 3.1 }
    };
    const project = createProject({ assets: [narrationAsset], scenes: [scene, createScene('scene-2', 4)] });
    const deps = createDependencies(project);

    const result = await generateProjectMusic('project-1', { prompt: 'timeline' }, musicServiceDeps(deps));

    expect(result.musicLengthMs).toBe(7350);
  });

  it('lets an explicit length win over the timeline', async () => {
    const project = createProject({ scenes: [createScene('scene-1', 10)] });
    const deps = createDependencies(project);

    const result = await generateProjectMusic('project-1', { prompt: 'explicit', musicLengthMs: 30_000 }, musicServiceDeps(deps));

    expect(result.musicLengthMs).toBe(30_000);
  });

  it('clamps a timeline above the provider maximum so the compositor can loop it', async () => {
    const project = createProject({ scenes: [createScene('scene-1', 600), createScene('scene-2', 600)] });
    const deps = createDependencies(project);

    const result = await generateProjectMusic('project-1', { prompt: 'long' }, musicServiceDeps(deps));

    expect(result.musicLengthMs).toBe(600_000);
  });

  it('preserves a previously requested length on regeneration', async () => {
    const existing = createAsset('asset-existing');
    const project = createProject({
      assets: [existing],
      scenes: [createScene('scene-1', 10)],
      music: { assetId: existing.id, status: 'generated', prompt: 'old', musicLengthMs: 45_000 }
    });
    const deps = createDependencies(project);

    const result = await generateProjectMusic('project-1', { prompt: 'new', regenerate: true }, musicServiceDeps(deps));

    expect(result.musicLengthMs).toBe(45_000);
  });

  it('refuses to overwrite existing generated music without regenerate', async () => {
    const existing = createAsset('asset-existing');
    const project = createProject({ assets: [existing], music: { assetId: existing.id, status: 'generated', prompt: 'old' } });
    const deps = createDependencies(project);

    await expect(
      generateProjectMusic('project-1', { prompt: 'new' }, musicServiceDeps(deps))
    ).rejects.toMatchObject({ code: 'music.alreadyGenerated', status: 409 });
  });

  it('regenerate replaces the selection but never deletes the previous asset', async () => {
    const existing = createAsset('asset-existing');
    const project = createProject({ assets: [existing], music: { assetId: existing.id, status: 'generated', prompt: 'old' } });
    const deps = createDependencies(project);

    const result = await generateProjectMusic('project-1', { prompt: 'new', regenerate: true }, musicServiceDeps(deps));

    expect(result.assetId).not.toBe(existing.id);
    expect(deps.state.project.assets.map((asset) => asset.id)).toContain('asset-existing');
    expect(deps.state.project.music?.assetId).toBe(result.assetId);
  });

  it('does not forward a stale stored asset format (e.g. "wav") as the provider output format', async () => {
    const existing = createAsset('asset-existing');
    const project = createProject({
      assets: [existing],
      music: { assetId: existing.id, status: 'generated', prompt: 'old', format: 'wav' }
    });
    const deps = createDependencies(project);

    await generateProjectMusic('project-1', { prompt: 'new', regenerate: true }, musicServiceDeps(deps));

    expect(deps.generatedRequests.at(-1)?.outputFormat).toBeUndefined();
  });

  it('marks the attempt failed and preserves the previous asset on provider failure', async () => {
    const existing = createAsset('asset-existing');
    const project = createProject({ assets: [existing], music: { assetId: existing.id, status: 'generated', prompt: 'old' } });
    const deps = createDependencies(project, { fail: true });

    await expect(
      generateProjectMusic('project-1', { prompt: 'new', regenerate: true }, musicServiceDeps(deps))
    ).rejects.toBeInstanceOf(ProjectMusicGenerationError);

    expect(deps.state.project.music?.status).toBe('failed');
    expect(deps.state.project.music?.assetId).toBe('asset-existing');
    expect(deps.state.project.assets).toHaveLength(1);
  });

  it('maps a provider rate-limit error to a 429 response', async () => {
    const deps = createDependencies(createProject(), {
      providerError: new MusicProviderError('quota exceeded', 429, 'PROVIDER_RATE_LIMIT')
    });

    await expect(
      generateProjectMusic('project-1', { prompt: 'calm' }, musicServiceDeps(deps))
    ).rejects.toMatchObject({ code: 'music.provider.rateLimited', status: 429 });

    expect(deps.state.project.music?.status).toBe('failed');
  });

  it('removes the stored file when the final project update fails so no orphan asset remains', async () => {
    const deps = createDependencies(createProject(), { failFinalUpdate: true });

    await expect(
      generateProjectMusic('project-1', { prompt: 'calm' }, musicServiceDeps(deps))
    ).rejects.toMatchObject({ code: 'music.provider.failed', status: 500 });

    expect(deps.deletedAssets).toHaveLength(1);
    expect(deps.state.project.assets).toHaveLength(0);
  });

  it('requires a prompt', async () => {
    const deps = createDependencies(createProject());
    await expect(
      generateProjectMusic('project-1', {}, musicServiceDeps(deps))
    ).rejects.toMatchObject({ code: 'music.invalid', status: 400 });
  });

  it('selects an existing music asset and rejects non-audio assets', async () => {
    const video = createAsset('asset-video', 'video');
    const audio = createAsset('asset-audio', 'audio');
    const project = createProject({ assets: [video, audio] });
    const deps = createDependencies(project);

    await expect(selectProjectMusic('project-1', 'asset-video', { store: deps.store })).rejects.toMatchObject({
      code: 'music.asset.invalidType'
    });

    const result = await selectProjectMusic('project-1', 'asset-audio', { store: deps.store });
    expect(result).toEqual({ assetId: 'asset-audio', status: 'generated' });
    expect(deps.state.project.music?.assetId).toBe('asset-audio');
  });

  it('clear drops the selection reference but keeps the asset', async () => {
    const asset = createAsset('asset-existing');
    const project = createProject({ assets: [asset], music: { assetId: asset.id, status: 'generated' } });
    const deps = createDependencies(project);

    const result = await clearProjectMusic('project-1', { store: deps.store });

    expect(result).toEqual({ status: 'cleared' });
    expect(deps.state.project.music).toBeUndefined();
    expect(deps.state.project.assets).toHaveLength(1);
  });

  it('does not consult the spend ledger for mock music generation', async () => {
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '0' });
    const ledger = new InMemoryPaidSubmitLedger();
    let reserveCalls = 0;
    const original = ledger.reserve.bind(ledger);
    ledger.reserve = async (input) => {
      reserveCalls += 1;
      return original(input);
    };
    setPaidSubmitLedgerForTests(ledger);
    const deps = createDependencies(createProject());

    const result = await generateProjectMusic('project-1', { prompt: 'calm ambient' }, musicServiceDeps(deps));
    expect(result.status).toBe('generated');
    expect(reserveCalls).toBe(0);
  });

  it('blocks a service token from real music generation even with human approval', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
    const deps = createDependencies(withHumanApproval(createProject()));

    await expect(
      generateProjectMusic(
        'project-1',
        {
          prompt: 'calm ambient',
          mode: 'real',
          provider: 'elevenlabs',
          identity: { kind: 'service', subject: 'service:api_token', authType: 'service_token' }
        },
        musicServiceDeps(deps)
      )
    ).rejects.toMatchObject({
      status: 403,
      code: 'music.policy.denied'
    });
    expect(deps.generateCalls()).toBe(0);
  });

  it('fails closed for a real music submit when the spend cap is disabled', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
    const deps = createDependencies(withHumanApproval(createProject()));

    await expect(
      generateProjectMusic('project-1', { prompt: 'calm ambient', mode: 'real', provider: 'elevenlabs' }, musicServiceDeps(deps))
    ).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.invalid'
    });
    expect(deps.generateCalls()).toBe(0);
  });

  it('blocks a real music submit when the host cap is exhausted', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '0', PAID_SPEND_CAP_MAX_MUSIC_SUBMITS: '1' });
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
    const deps = createDependencies(withHumanApproval(createProject()));

    await expect(
      generateProjectMusic('project-1', { prompt: 'calm ambient', mode: 'real', provider: 'elevenlabs' }, musicServiceDeps(deps))
    ).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.exceeded'
    });
    expect(deps.generateCalls()).toBe(0);
  });

  it('blocks a real music submit when the mandate music budget is exhausted', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '5', PAID_SPEND_CAP_MAX_MUSIC_SUBMITS: '5' });
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
    setMandateSpendLedgerForTests(new InMemoryMandateSpendLedger());
    setMandateSpendReaderForTests(async () => ({
      mandateId: 'mandate_1',
      projectId: 'project-1',
      issuedBy: 'user_test',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      brief: '',
      allowedActions: ['manage_project_music'],
      budgets: { maxMusicSubmits: 0 }
    }));
    const deps = createDependencies(withHumanApproval(createProject()));

    await expect(
      generateProjectMusic('project-1', { prompt: 'calm ambient', mode: 'real', provider: 'elevenlabs' }, musicServiceDeps(deps))
    ).rejects.toMatchObject({
      status: 403,
      code: 'mandate.budget.exceeded'
    });
    expect(deps.generateCalls()).toBe(0);
  });

  describe('concurrent project submit reservation', () => {
    it('lets only one of two overlapping submits reach the provider', async () => {
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let enteredGenerate: () => void = () => {};
      const generateEntered = new Promise<void>((resolve) => {
        enteredGenerate = resolve;
      });
      const deps = createDependencies(createProject(), {
        generateGate: async () => {
          enteredGenerate();
          await gate;
        }
      });

      const first = generateProjectMusic('project-1', { prompt: 'calm ambient' }, musicServiceDeps(deps));
      await generateEntered;

      await expect(
        generateProjectMusic('project-1', { prompt: 'calm ambient' }, musicServiceDeps(deps))
      ).rejects.toMatchObject({ code: 'music.alreadyRunning' });

      releaseGate();
      await first;
      expect(deps.generateCalls()).toBe(1);
    });

    it('lets only one of two independent file locks reach the provider', async () => {
      const dir = path.join(os.tmpdir(), `music-submit-lock-${process.pid}-${Date.now()}`);
      const resolvePath = (key: string) => path.join(dir, `${key.replace(/[^A-Za-z0-9._-]+/g, '_')}.lock`);
      const holder = new FileExclusiveLock({ resolvePath });
      const challenger = new FileExclusiveLock({ resolvePath });
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let enteredGenerate: () => void = () => {};
      const generateEntered = new Promise<void>((resolve) => {
        enteredGenerate = resolve;
      });
      const deps = createDependencies(createProject(), {
        generateGate: async () => {
          enteredGenerate();
          await gate;
        }
      });

      const first = generateProjectMusic('project-1', { prompt: 'calm ambient' }, {
        ...musicServiceDeps(deps),
        submitLocks: holder
      });
      await generateEntered;

      await expect(
        generateProjectMusic('project-1', { prompt: 'calm ambient' }, {
          ...musicServiceDeps(deps),
          submitLocks: challenger
        })
      ).rejects.toMatchObject({ code: 'music.alreadyRunning' });

      releaseGate();
      await first;
      expect(deps.generateCalls()).toBe(1);
    });

    it('releases the lock after a provider failure so a retry can run', async () => {
      const failing = createDependencies(createProject(), { fail: true });
      await expect(
        generateProjectMusic('project-1', { prompt: 'calm ambient' }, musicServiceDeps(failing))
      ).rejects.toThrow(ProjectMusicGenerationError);

      const retry = createDependencies(failing.state.project);
      const result = await generateProjectMusic('project-1', { prompt: 'calm ambient', regenerate: true }, {
        ...musicServiceDeps(retry),
        submitLocks: failing.submitLocks
      });
      expect(result.status).toBe('generated');
      expect(retry.generateCalls()).toBe(1);
    });
  });
});
