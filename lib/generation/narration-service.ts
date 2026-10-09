import { createTextToSpeechRegistry } from '@/lib/ai/text-to-speech/registry';
import { TextToSpeechProviderError, type TextToSpeechFormat } from '@/lib/ai/text-to-speech/provider';
import { mediaStore } from '@/lib/storage/media-store';
import { projectStore, type ProjectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';
import type { NarrationGenerationAttempt, Scene } from '@/lib/types/scene';
import { createId } from '@/lib/utils/ids';

const activeNarrationLocks = new Set<string>();

function lockKey(projectId: string, sceneId: string): string {
  return `${projectId}:${sceneId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function resolveDefaultProvider(): string {
  return process.env.TTS_DEFAULT_PROVIDER || (process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : 'fake');
}

function resolveDefaultVoiceId(): string {
  return process.env.TTS_DEFAULT_VOICE_ID || 'default';
}

function resolveDefaultModel(): string {
  return process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2';
}

function resolveDefaultFormat(): TextToSpeechFormat {
  const configured = (process.env.TTS_DEFAULT_FORMAT || 'mp3').toLowerCase();
  if (configured === 'wav' || configured === 'm4a' || configured === 'mp3') {
    return configured;
  }
  return 'mp3';
}

export class SceneNarrationGenerationError extends Error {
  readonly status: number;
  readonly code:
    | 'narration.project.notFound'
    | 'narration.scene.notFound'
    | 'narration.invalid'
    | 'narration.provider.notConfigured'
    | 'narration.provider.unsupported'
    | 'narration.provider.failed'
    | 'narration.scene.alreadyRunning'
    | 'narration.scene.alreadyGenerated';

  constructor(
    message: string,
    status: number,
    code:
      | 'narration.project.notFound'
      | 'narration.scene.notFound'
      | 'narration.invalid'
      | 'narration.provider.notConfigured'
      | 'narration.provider.unsupported'
      | 'narration.provider.failed'
      | 'narration.scene.alreadyRunning'
      | 'narration.scene.alreadyGenerated'
  ) {
    super(message);
    this.name = 'SceneNarrationGenerationError';
    this.status = status;
    this.code = code;
  }
}

export interface SceneNarrationGenerationResult {
  sceneId: string;
  status: 'generated';
  assetId: string;
  generationAttemptId: string;
  provider: string;
  model?: string;
  voiceId: string;
  format: TextToSpeechFormat;
  duration?: number;
}

interface NarrationServiceDependencies {
  store: Pick<ProjectStore, 'getProject' | 'updateProject'>;
  media: Pick<typeof mediaStore, 'saveGeneratedAudio'>;
  registry: ReturnType<typeof createTextToSpeechRegistry>;
}

const defaultDependencies: NarrationServiceDependencies = {
  store: projectStore,
  media: mediaStore,
  registry: createTextToSpeechRegistry()
};

function getScene(project: Project, sceneId: string): Scene {
  const scene = project.scenes.find((entry) => entry.id === sceneId);
  if (!scene) {
    throw new SceneNarrationGenerationError(`Scene ${sceneId} not found.`, 404, 'narration.scene.notFound');
  }
  return scene;
}

function updateScene(project: Project, sceneId: string, updater: (scene: Scene) => Scene): Project {
  return {
    ...project,
    scenes: project.scenes.map((scene) => (scene.id === sceneId ? updater(scene) : scene))
  };
}

function mapProviderError(error: TextToSpeechProviderError): SceneNarrationGenerationError {
  if (error.code === 'NOT_CONFIGURED') {
    return new SceneNarrationGenerationError(error.message, 409, 'narration.provider.notConfigured');
  }
  if (error.code === 'UNSUPPORTED' || error.code === 'INVALID_REQUEST') {
    return new SceneNarrationGenerationError(error.message, 422, 'narration.provider.unsupported');
  }
  return new SceneNarrationGenerationError(error.message, 502, 'narration.provider.failed');
}

export async function generateSceneNarration(
  projectId: string,
  sceneId: string,
  options: {
    text?: string;
    voiceId?: string;
    model?: string;
    format?: TextToSpeechFormat;
    provider?: string;
    regenerate?: boolean;
    settings?: {
      stability?: number;
      similarityBoost?: number;
      style?: number;
      speakerBoost?: boolean;
    };
  } = {},
  dependencies: NarrationServiceDependencies = defaultDependencies
): Promise<SceneNarrationGenerationResult> {
  const key = lockKey(projectId, sceneId);
  if (activeNarrationLocks.has(key)) {
    throw new SceneNarrationGenerationError('Narration generation is already running for this scene.', 409, 'narration.scene.alreadyRunning');
  }

  activeNarrationLocks.add(key);

  try {
    const project = await dependencies.store.getProject(projectId);
    if (!project) {
      throw new SceneNarrationGenerationError(`Project ${projectId} not found.`, 404, 'narration.project.notFound');
    }

    const scene = getScene(project, sceneId);
    const existingNarration = scene.narration ?? { text: '' };

    const text = (options.text ?? existingNarration.text ?? '').trim();
    if (!text) {
      throw new SceneNarrationGenerationError('Narration text is required before generating audio.', 400, 'narration.invalid');
    }

    const voiceId = (options.voiceId ?? existingNarration.voiceId ?? resolveDefaultVoiceId()).trim();
    if (!voiceId) {
      throw new SceneNarrationGenerationError('Voice id is required for narration generation.', 400, 'narration.invalid');
    }

    const format = options.format ?? existingNarration.format ?? resolveDefaultFormat();
    const model = options.model ?? existingNarration.model ?? resolveDefaultModel();
    const providerId = options.provider ?? resolveDefaultProvider();
    const regenerate = Boolean(options.regenerate);

    if (!regenerate && existingNarration.status === 'generated' && existingNarration.audioAssetId) {
      throw new SceneNarrationGenerationError('Scene narration already has generated audio. Use regenerate=true to create a new narration asset.', 409, 'narration.scene.alreadyGenerated');
    }

    if (existingNarration.status === 'generating') {
      throw new SceneNarrationGenerationError('Scene narration is already generating.', 409, 'narration.scene.alreadyRunning');
    }

    let provider;
    try {
      provider = dependencies.registry.getProvider(providerId);
    } catch {
      throw new SceneNarrationGenerationError(`Unknown narration provider: ${providerId}`, 422, 'narration.provider.unsupported');
    }

    const attemptId = createId('generation_attempt');
    const previousAudioAssetId = existingNarration.audioAssetId;
    const previousDuration = existingNarration.duration;

    const generatingAttempt: NarrationGenerationAttempt = {
      id: attemptId,
      status: 'generating',
      provider: provider.providerId,
      model,
      voiceId,
      format,
      createdAt: nowIso()
    };

    const withGenerating = updateScene(project, sceneId, (entry) => ({
      ...entry,
      narration: {
        ...(entry.narration ?? { text: '' }),
        text,
        voiceId,
        model,
        format,
        audioAssetId: previousAudioAssetId,
        duration: previousDuration,
        status: 'generating',
        lastAttemptId: attemptId,
        error: undefined,
        attempts: [...(entry.narration?.attempts ?? []), generatingAttempt]
      }
    }));

    await dependencies.store.updateProject(withGenerating);

    let synthesized;
    try {
      synthesized = await provider.synthesize({
        text,
        voiceId,
        model,
        format,
        settings: options.settings
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Narration provider call failed.';
      const failed = updateScene(withGenerating, sceneId, (entry) => ({
        ...entry,
        narration: {
          ...(entry.narration ?? { text }),
          text,
          voiceId,
          model,
          format,
          audioAssetId: previousAudioAssetId,
          duration: previousDuration,
          status: 'failed',
          lastAttemptId: attemptId,
          error: message,
          attempts: (entry.narration?.attempts ?? []).map((attempt) => attempt.id === attemptId ? {
            ...attempt,
            status: 'failed',
            completedAt: nowIso(),
            error: message
          } : attempt)
        }
      }));
      await dependencies.store.updateProject(failed);

      if (error instanceof TextToSpeechProviderError) {
        throw mapProviderError(error);
      }
      throw new SceneNarrationGenerationError('Narration provider call failed.', 502, 'narration.provider.failed');
    }

    if (typeof synthesized.duration === 'number' && synthesized.duration > scene.duration + 0.01) {
      const message = `Narration duration (${synthesized.duration.toFixed(2)}s) exceeds scene duration (${scene.duration.toFixed(2)}s).`;
      const failed = updateScene(withGenerating, sceneId, (entry) => ({
        ...entry,
        narration: {
          ...(entry.narration ?? { text }),
          text,
          voiceId,
          model,
          format,
          audioAssetId: previousAudioAssetId,
          duration: previousDuration,
          status: 'failed',
          lastAttemptId: attemptId,
          error: message,
          attempts: (entry.narration?.attempts ?? []).map((attempt) => attempt.id === attemptId ? {
            ...attempt,
            status: 'failed',
            completedAt: nowIso(),
            error: message,
            providerRequestId: synthesized.providerRequestId,
            duration: synthesized.duration,
            mimeType: synthesized.mimeType
          } : attempt)
        }
      }));
      await dependencies.store.updateProject(failed);
      throw new SceneNarrationGenerationError(message, 422, 'narration.invalid');
    }

    const generatedAsset = await dependencies.media.saveGeneratedAudio({
      projectId,
      sceneOrder: scene.order,
      attemptId,
      mimeType: synthesized.mimeType,
      data: synthesized.data,
      generation: {
        generationId: attemptId,
        provider: synthesized.provider,
        model: synthesized.model,
        prompt: text,
        voiceId,
        providerRequestId: synthesized.providerRequestId
      }
    });

    const withGenerated = updateScene(withGenerating, sceneId, (entry) => ({
      ...entry,
      narration: {
        ...(entry.narration ?? { text: '' }),
        text,
        voiceId,
        model,
        format,
        audioAssetId: generatedAsset.id,
        duration: generatedAsset.duration,
        status: 'generated',
        lastAttemptId: attemptId,
        error: undefined,
        attempts: (entry.narration?.attempts ?? []).map((attempt) => attempt.id === attemptId ? {
          ...attempt,
          status: 'generated',
          completedAt: nowIso(),
          providerRequestId: synthesized.providerRequestId,
          duration: generatedAsset.duration,
          mimeType: generatedAsset.mimeType,
          audioAssetId: generatedAsset.id
        } : attempt)
      }
    }));

    withGenerated.assets.push(generatedAsset);
    await dependencies.store.updateProject(withGenerated);

    return {
      sceneId,
      status: 'generated',
      assetId: generatedAsset.id,
      generationAttemptId: attemptId,
      provider: synthesized.provider,
      model: synthesized.model,
      voiceId,
      format,
      duration: generatedAsset.duration
    };
  } finally {
    activeNarrationLocks.delete(key);
  }
}
