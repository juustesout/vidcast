import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import { buildSilentWav } from '@/lib/ai/audio/silent-wav';
import { TextToSpeechProviderError } from '@/lib/ai/text-to-speech/provider';
import { stampHumanApproval } from '@/lib/explainer/human-approval';
import { generateSceneNarration, SceneNarrationGenerationError } from '@/lib/generation/narration-service';
import { InMemoryPaidSubmitLedger, setPaidSubmitLedgerForTests } from '@/lib/spend/paid-submit-cap';
import type { MediaStore } from '@/lib/storage/media-store';
import type { ProjectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';
import { FileExclusiveLock, InMemoryExclusiveLock } from '@/lib/utils/exclusive-file-lock';

function createProject(): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-1',
    title: 'Narration Service Test',
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
        id: 'asset-old-audio',
        type: 'audio',
        status: 'available',
        provenance: 'generated',
        filename: 'old.mp3',
        localPath: 'assets/old.mp3',
        mimeType: 'audio/mpeg',
        duration: 1.2,
        filesize: 10,
        metadata: {},
        createdAt: now,
        updatedAt: now
      }
    ],
    references: [],
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 2,
        type: 'image',
        narration: {
          text: 'Original narration',
          voiceId: 'voice-a',
          model: 'model-a',
          format: 'mp3',
          audioAssetId: 'asset-old-audio',
          status: 'generated',
          duration: 1.2,
          attempts: []
        },
        visual: {
          kind: 'blank'
        },
        render: { motion: { preset: 'none' }, transition: { type: 'fade' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ]
  };
}

const SAMPLE_ALIGNMENT = {
  characters: {
    characters: ['H', 'i'],
    characterStartTimesSeconds: [0, 0.1],
    characterEndTimesSeconds: [0.1, 0.3]
  },
  words: [{ word: 'Hi', startSeconds: 0, endSeconds: 0.3 }]
};

function createInMemoryDependencies(project: Project, behavior?: { providerFails?: boolean; durationSeconds?: number; providerError?: Error; alignment?: typeof SAMPLE_ALIGNMENT; synthesizeGate?: () => Promise<void> }) {
  const state = { project: structuredClone(project) as Project };
  const now = new Date().toISOString();

  const store: Pick<ProjectStore, 'getProject' | 'updateProject' | 'mutateProject'> = {
    async getProject(id: string) {
      if (id !== state.project.id) {
        return null;
      }
      return structuredClone(state.project) as Project;
    },
    async updateProject(nextProject: Project) {
      state.project = structuredClone(nextProject) as Project;
      return state.project;
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

  let createdAssetCount = 0;

  const media: Pick<MediaStore, 'saveGeneratedAudio'> = {
    async saveGeneratedAudio(input) {
      createdAssetCount += 1;
      return {
        id: `asset-generated-${createdAssetCount}`,
        type: 'audio',
        status: 'available',
        provenance: 'generated',
        filename: `scene-${input.sceneOrder}-narration.mp3`,
        localPath: `assets/scene-${input.sceneOrder}-narration.mp3`,
        mimeType: input.mimeType,
        duration: behavior?.durationSeconds ?? 1.4,
        filesize: input.data.byteLength,
        metadata: {
          generationAttemptId: input.attemptId
        },
        generation: {
          generationId: input.generation.generationId,
          provider: input.generation.provider,
          model: input.generation.model,
          prompt: input.generation.prompt,
          referenceIds: []
        },
        createdAt: now,
        updatedAt: now
      };
    }
  };

  let synthesizeCalls = 0;

  const registry = {
    getProvider() {
      return {
        providerId: 'fake',
        async synthesize() {
          synthesizeCalls += 1;
          if (behavior?.synthesizeGate) {
            await behavior.synthesizeGate();
          }
          if (behavior?.providerError) {
            throw behavior.providerError;
          }
          if (behavior?.providerFails) {
            throw new Error('provider failed');
          }

          const durationSeconds = behavior?.durationSeconds ?? 1.4;

          return {
            provider: 'fake',
            model: 'fake-tts',
            mimeType: 'audio/wav',
            format: 'wav' as const,
            data: buildSilentWav(durationSeconds * 1000),
            duration: durationSeconds,
            providerRequestId: 'req-1',
            alignment: behavior?.alignment
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
    synthesizeCalls: () => synthesizeCalls
  };
}

function narrationServiceDeps(deps: ReturnType<typeof createInMemoryDependencies>) {
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

describe('narration generation service', () => {
  it('successful regeneration creates new audio asset and updates scene narration link', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project);

    const result = await generateSceneNarration(project.id, 'scene-1', {
      regenerate: true,
      text: 'Updated narration script',
      voiceId: 'voice-b',
      model: 'model-b',
      format: 'mp3'
    }, narrationServiceDeps(deps));

    expect(result.status).toBe('generated');
    expect(result.assetId).toBeDefined();

    const scene = deps.state.project.scenes[0];
    expect(scene.narration?.audioAssetId).toBe(result.assetId);
    expect(scene.narration?.status).toBe('generated');
    expect((scene.narration?.attempts ?? []).length).toBeGreaterThan(0);
    expect(deps.state.project.assets.length).toBe(2);
  });

  it('marks narration attempt failed and preserves previous asset on provider failure', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project, { providerFails: true });

    await expect(generateSceneNarration(project.id, 'scene-1', { regenerate: true }, narrationServiceDeps(deps))).rejects.toThrow(SceneNarrationGenerationError);

    const scene = deps.state.project.scenes[0];
    expect(scene.narration?.audioAssetId).toBe('asset-old-audio');
    expect(scene.narration?.status).toBe('failed');
    expect(deps.state.project.assets.length).toBe(1);
  });

  it('records a failed attempt and preserves previous asset on provider rate limiting', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project, {
      providerError: new TextToSpeechProviderError('Too many concurrent requests', 429, 'PROVIDER_RATE_LIMIT')
    });

    await expect(generateSceneNarration(project.id, 'scene-1', { regenerate: true }, narrationServiceDeps(deps))).rejects.toMatchObject({ code: 'narration.provider.failed' });

    const scene = deps.state.project.scenes[0];
    expect(scene.narration?.audioAssetId).toBe('asset-old-audio');
    expect(scene.narration?.status).toBe('failed');
    expect(scene.narration?.attempts?.at(-1)?.status).toBe('failed');
    expect(deps.state.project.assets.length).toBe(1);
  });

  it('accepts narration longer than the authored scene duration', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project, { durationSeconds: 3.1 });

    const result = await generateSceneNarration(project.id, 'scene-1', { regenerate: true }, narrationServiceDeps(deps));

    expect(result.status).toBe('generated');
    expect(result.duration).toBe(3.1);

    const scene = deps.state.project.scenes[0];
    expect(scene.narration?.audioAssetId).toBe(result.assetId);
    expect(scene.narration?.status).toBe('generated');
    expect(scene.narration?.duration).toBe(3.1);
    expect(scene.duration).toBe(2);
    expect(deps.state.project.assets.length).toBe(2);
  });

  it('persists provider alignment with the generated audio and does not invent timings when missing', async () => {
    const withAlignment = createInMemoryDependencies(createProject(), { alignment: SAMPLE_ALIGNMENT });
    await generateSceneNarration(createProject().id, 'scene-1', { regenerate: true }, narrationServiceDeps(withAlignment));
    expect(withAlignment.state.project.scenes[0].narration?.alignment?.words).toEqual(SAMPLE_ALIGNMENT.words);
    expect(withAlignment.state.project.scenes[0].narration?.attempts?.at(-1)?.alignment?.words).toEqual(SAMPLE_ALIGNMENT.words);

    const withoutAlignment = createInMemoryDependencies(createProject());
    await generateSceneNarration(createProject().id, 'scene-1', { regenerate: true }, narrationServiceDeps(withoutAlignment));
    expect(withoutAlignment.state.project.scenes[0].narration?.alignment).toBeUndefined();
  });

  it('does not consult the spend ledger for mock narration generation', async () => {
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

    const result = await generateSceneNarration(project.id, 'scene-1', { regenerate: true }, narrationServiceDeps(deps));
    expect(result.status).toBe('generated');
    expect(reserveCalls).toBe(0);
  });

  it('blocks a service token from real narration generation even with human approval', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
    const project = withHumanApproval(createProject());
    const deps = createInMemoryDependencies(project);

    await expect(
      generateSceneNarration(
        project.id,
        'scene-1',
        {
          regenerate: true,
          mode: 'real',
          provider: 'elevenlabs',
          identity: { kind: 'service', subject: 'service:api_token', authType: 'service_token' }
        },
        narrationServiceDeps(deps)
      )
    ).rejects.toMatchObject({
      status: 403,
      code: 'narration.policy.denied'
    });
    expect(deps.synthesizeCalls()).toBe(0);
  });

  it('fails closed for a real narration submit when the spend cap is disabled', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
    const project = withHumanApproval(createProject());
    const deps = createInMemoryDependencies(project);

    await expect(
      generateSceneNarration(project.id, 'scene-1', { regenerate: true, mode: 'real', provider: 'elevenlabs' }, narrationServiceDeps(deps))
    ).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.invalid'
    });
    expect(deps.synthesizeCalls()).toBe(0);
  });

  it('blocks a real narration submit when the host cap is exhausted', async () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '0', PAID_SPEND_CAP_MAX_NARRATION_SUBMITS: '3' });
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
    const project = withHumanApproval(createProject());
    const deps = createInMemoryDependencies(project);

    await expect(
      generateSceneNarration(project.id, 'scene-1', { regenerate: true, mode: 'real', provider: 'elevenlabs' }, narrationServiceDeps(deps))
    ).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.exceeded'
    });
    expect(deps.synthesizeCalls()).toBe(0);
  });

  describe('concurrent scene submit reservation', () => {
    it('lets only one of two overlapping submits reach the provider', async () => {
      const project = createProject();
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let enteredSynthesize: () => void = () => {};
      const synthesizeEntered = new Promise<void>((resolve) => {
        enteredSynthesize = resolve;
      });
      const deps = createInMemoryDependencies(project, {
        synthesizeGate: async () => {
          enteredSynthesize();
          await gate;
        }
      });

      const first = generateSceneNarration(project.id, 'scene-1', { regenerate: true }, narrationServiceDeps(deps));
      await synthesizeEntered;

      await expect(
        generateSceneNarration(project.id, 'scene-1', { regenerate: true }, narrationServiceDeps(deps))
      ).rejects.toMatchObject({ code: 'narration.scene.alreadyRunning' });

      releaseGate();
      await first;
      expect(deps.synthesizeCalls()).toBe(1);
    });

    it('lets only one of two independent file locks reach the provider', async () => {
      const project = createProject();
      const dir = path.join(os.tmpdir(), `narration-submit-lock-${process.pid}-${Date.now()}`);
      const resolvePath = (key: string) => path.join(dir, `${key.replace(/[^A-Za-z0-9._-]+/g, '_')}.lock`);
      const holder = new FileExclusiveLock({ resolvePath });
      const challenger = new FileExclusiveLock({ resolvePath });
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let enteredSynthesize: () => void = () => {};
      const synthesizeEntered = new Promise<void>((resolve) => {
        enteredSynthesize = resolve;
      });
      const deps = createInMemoryDependencies(project, {
        synthesizeGate: async () => {
          enteredSynthesize();
          await gate;
        }
      });

      const first = generateSceneNarration(project.id, 'scene-1', { regenerate: true }, {
        ...narrationServiceDeps(deps),
        submitLocks: holder
      });
      await synthesizeEntered;

      await expect(
        generateSceneNarration(project.id, 'scene-1', { regenerate: true }, {
          ...narrationServiceDeps(deps),
          submitLocks: challenger
        })
      ).rejects.toMatchObject({ code: 'narration.scene.alreadyRunning' });

      releaseGate();
      await first;
      expect(deps.synthesizeCalls()).toBe(1);
    });

    it('releases the lock after a provider failure so a retry can run', async () => {
      const project = createProject();
      const failing = createInMemoryDependencies(project, { providerFails: true });
      await expect(
        generateSceneNarration(project.id, 'scene-1', { regenerate: true }, narrationServiceDeps(failing))
      ).rejects.toThrow(SceneNarrationGenerationError);

      const retry = createInMemoryDependencies(failing.state.project);
      const result = await generateSceneNarration(project.id, 'scene-1', { regenerate: true }, {
        ...narrationServiceDeps(retry),
        submitLocks: failing.submitLocks
      });
      expect(result.status).toBe('generated');
      expect(retry.synthesizeCalls()).toBe(1);
    });
  });
});
