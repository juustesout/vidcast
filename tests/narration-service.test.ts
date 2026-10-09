import { describe, expect, it } from 'vitest';

import { generateSceneNarration, SceneNarrationGenerationError } from '@/lib/generation/narration-service';
import type { MediaStore } from '@/lib/storage/media-store';
import type { ProjectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';

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

function createInMemoryDependencies(project: Project, behavior?: { providerFails?: boolean; durationSeconds?: number }) {
  const state = { project: structuredClone(project) as Project };
  const now = new Date().toISOString();

  const store: Pick<ProjectStore, 'getProject' | 'updateProject'> = {
    async getProject(id: string) {
      if (id !== state.project.id) {
        return null;
      }
      return structuredClone(state.project) as Project;
    },
    async updateProject(nextProject: Project) {
      state.project = structuredClone(nextProject) as Project;
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

  const registry = {
    getProvider() {
      return {
        providerId: 'fake',
        async synthesize() {
          if (behavior?.providerFails) {
            throw new Error('provider failed');
          }

          return {
            provider: 'fake',
            model: 'fake-tts',
            mimeType: 'audio/mpeg',
            format: 'mp3' as const,
            data: Buffer.from('fake-audio'),
            duration: behavior?.durationSeconds ?? 1.4,
            providerRequestId: 'req-1'
          };
        }
      };
    }
  };

  return { state, store, media, registry };
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
    }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    });

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

    await expect(generateSceneNarration(project.id, 'scene-1', { regenerate: true }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    })).rejects.toThrow(SceneNarrationGenerationError);

    const scene = deps.state.project.scenes[0];
    expect(scene.narration?.audioAssetId).toBe('asset-old-audio');
    expect(scene.narration?.status).toBe('failed');
    expect(deps.state.project.assets.length).toBe(1);
  });

  it('fails with controlled validation error when narration is longer than scene', async () => {
    const project = createProject();
    const deps = createInMemoryDependencies(project, { durationSeconds: 3.1 });

    await expect(generateSceneNarration(project.id, 'scene-1', { regenerate: true }, {
      store: deps.store,
      media: deps.media,
      registry: deps.registry as never
    })).rejects.toMatchObject({ code: 'narration.invalid' });

    const scene = deps.state.project.scenes[0];
    expect(scene.narration?.audioAssetId).toBe('asset-old-audio');
    expect(scene.narration?.status).toBe('failed');
    expect(deps.state.project.assets.length).toBe(1);
  });
});
