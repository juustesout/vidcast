import { describe, expect, it } from 'vitest';

import { refreshVideoGenerationAttempt, SceneVideoGenerationError, submitSceneVideoGeneration } from '@/lib/generation/video-generation-service';
import type { MediaStore } from '@/lib/storage/media-store';
import type { ProjectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';

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

function createInMemoryDependencies(project: Project, behavior?: { failOnSubmit?: boolean; failOnStatus?: boolean; failOnDownload?: boolean }) {
  const state = { project: structuredClone(project) as Project };
  let createdAssetCount = 0;

  const store: Pick<ProjectStore, 'getProject' | 'updateProject'> = {
    async getProject(id: string) {
      if (id !== state.project.id) return null;
      return structuredClone(state.project) as Project;
    },
    async updateProject(nextProject: Project) {
      state.project = structuredClone(nextProject) as Project;
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
      return localPath === 'references/ref.png';
    },
    async readRelativeFile() {
      return Buffer.from('ref-bytes');
    }
  };

  const registry = {
    getProvider() {
      return {
        providerId: 'fake',
        async submit() {
          if (behavior?.failOnSubmit) {
            throw new Error('submit failed');
          }
          return {
            providerJobId: 'job-1',
            status: 'queued' as const,
            providerStatus: 'queued'
          };
        },
        async getStatus() {
          if (behavior?.failOnStatus) {
            throw new Error('status failed');
          }
          return {
            status: 'generated' as const,
            providerStatus: 'completed'
          };
        },
        async download() {
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

  return { state, store, media, registry };
}

describe('video generation service', () => {
  it('submit + poll completion creates video asset and updates scene', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project);

    const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

    expect(submit.status).toBe('queued');
    expect(submit.providerJobId).toBe('job-1');

    const poll = await refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

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

    await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

    await expect(
      submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: false }, {
        store: deps.store,
        media: deps.media,
        registry: deps.registry as never
      })
    ).rejects.toThrow(SceneVideoGenerationError);
  });

  it('marks attempt failed and preserves previous asset when submit fails', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project, { failOnSubmit: true });

    await expect(
      submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
        store: deps.store,
        media: deps.media,
        registry: deps.registry as never
      })
    ).rejects.toThrow(SceneVideoGenerationError);

    const scene = deps.state.project.scenes[0];
    if (scene.visual && scene.visual.kind === 'generated_video') {
      expect(scene.visual.assetId).toBe('asset-old-video');
      expect(scene.visual.generation.status).toBe('failed');
    }
  });

  it('returns persisted state when polling a non-active historical attempt', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project);

    const submit = await submitSceneVideoGeneration(project.id, 'scene-video-1', { regenerate: true }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

    const firstAttemptId = 'gen-video-current';
    const historical = await refreshVideoGenerationAttempt(project.id, firstAttemptId, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

    expect(historical.generationAttemptId).toBe(firstAttemptId);
    expect(historical.status).toBe('generated');

    await refreshVideoGenerationAttempt(project.id, submit.generationAttemptId, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });
  });
});
