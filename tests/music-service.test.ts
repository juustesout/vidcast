import { describe, expect, it } from 'vitest';

import {
  clearProjectMusic,
  generateProjectMusic,
  ProjectMusicGenerationError,
  selectProjectMusic
} from '@/lib/generation/music-service';
import { MusicProviderError } from '@/lib/ai/music/provider';
import type { GeneratedMusicInput } from '@/lib/storage/media-store';
import type { ProjectStore } from '@/lib/storage/project-store';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';

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
  behavior: { fail?: boolean; providerError?: MusicProviderError; failFinalUpdate?: boolean } = {}
) {
  const state = { project: structuredClone(project) as Project };
  const now = new Date().toISOString();
  const deletedAssets: string[] = [];
  const generatedRequests: Array<{ durationMs: number; model?: string; outputFormat?: string }> = [];
  let createdCount = 0;

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
          generatedRequests.push(request);
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

  return { state, store, media, registry, createdCount: () => createdCount, deletedAssets, generatedRequests };
}

describe('project music generation service', () => {
  it('generates background music, saves a music asset and records the selection', async () => {
    const deps = createDependencies(createProject());

    const result = await generateProjectMusic('project-1', { prompt: 'calm ambient' }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

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
    const result = await generateProjectMusic('project-1', { prompt: 'p', musicLengthMs: 500 }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });
    expect(result.musicLengthMs).toBe(3000);
  });

  it('derives the requested length from the resolved render timeline when none is given', async () => {
    const project = createProject({ scenes: [createScene('scene-1', 4), createScene('scene-2', 6)] });
    const deps = createDependencies(project);

    const result = await generateProjectMusic('project-1', { prompt: 'timeline' }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

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

    const result = await generateProjectMusic('project-1', { prompt: 'timeline' }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

    expect(result.musicLengthMs).toBe(7350);
  });

  it('lets an explicit length win over the timeline', async () => {
    const project = createProject({ scenes: [createScene('scene-1', 10)] });
    const deps = createDependencies(project);

    const result = await generateProjectMusic('project-1', { prompt: 'explicit', musicLengthMs: 30_000 }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

    expect(result.musicLengthMs).toBe(30_000);
  });

  it('clamps a timeline above the provider maximum so the compositor can loop it', async () => {
    const project = createProject({ scenes: [createScene('scene-1', 600), createScene('scene-2', 600)] });
    const deps = createDependencies(project);

    const result = await generateProjectMusic('project-1', { prompt: 'long' }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

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

    const result = await generateProjectMusic('project-1', { prompt: 'new', regenerate: true }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

    expect(result.musicLengthMs).toBe(45_000);
  });

  it('refuses to overwrite existing generated music without regenerate', async () => {
    const existing = createAsset('asset-existing');
    const project = createProject({ assets: [existing], music: { assetId: existing.id, status: 'generated', prompt: 'old' } });
    const deps = createDependencies(project);

    await expect(
      generateProjectMusic('project-1', { prompt: 'new' }, { store: deps.store, media: deps.media, registry: deps.registry as never })
    ).rejects.toMatchObject({ code: 'music.alreadyGenerated', status: 409 });
  });

  it('regenerate replaces the selection but never deletes the previous asset', async () => {
    const existing = createAsset('asset-existing');
    const project = createProject({ assets: [existing], music: { assetId: existing.id, status: 'generated', prompt: 'old' } });
    const deps = createDependencies(project);

    const result = await generateProjectMusic('project-1', { prompt: 'new', regenerate: true }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

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

    await generateProjectMusic('project-1', { prompt: 'new', regenerate: true }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

    expect(deps.generatedRequests.at(-1)?.outputFormat).toBeUndefined();
  });

  it('marks the attempt failed and preserves the previous asset on provider failure', async () => {
    const existing = createAsset('asset-existing');
    const project = createProject({ assets: [existing], music: { assetId: existing.id, status: 'generated', prompt: 'old' } });
    const deps = createDependencies(project, { fail: true });

    await expect(
      generateProjectMusic('project-1', { prompt: 'new', regenerate: true }, {
        store: deps.store,
        media: deps.media,
        registry: deps.registry as never
      })
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
      generateProjectMusic('project-1', { prompt: 'calm' }, { store: deps.store, media: deps.media, registry: deps.registry as never })
    ).rejects.toMatchObject({ code: 'music.provider.rateLimited', status: 429 });

    expect(deps.state.project.music?.status).toBe('failed');
  });

  it('removes the stored file when the final project update fails so no orphan asset remains', async () => {
    const deps = createDependencies(createProject(), { failFinalUpdate: true });

    await expect(
      generateProjectMusic('project-1', { prompt: 'calm' }, { store: deps.store, media: deps.media, registry: deps.registry as never })
    ).rejects.toMatchObject({ code: 'music.provider.failed', status: 500 });

    expect(deps.deletedAssets).toHaveLength(1);
    expect(deps.state.project.assets).toHaveLength(0);
  });

  it('requires a prompt', async () => {
    const deps = createDependencies(createProject());
    await expect(
      generateProjectMusic('project-1', {}, { store: deps.store, media: deps.media, registry: deps.registry as never })
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
});
