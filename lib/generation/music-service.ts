import { createMusicRegistry, type MusicRegistry } from '@/lib/ai/music/registry';
import { DEFAULT_ELEVENLABS_MUSIC_MODEL } from '@/lib/ai/music/elevenlabs-provider';
import { MusicProviderError } from '@/lib/ai/music/provider';
import { clampMusicLengthMs } from '@/lib/render/music-mix';
import { resolveManualGenerationProvider, RunPolicyError } from '@/lib/production/run-policy';
import type { RunMode } from '@/lib/production/run-types';
import { mediaStore } from '@/lib/storage/media-store';
import { projectStore, type ProjectStore } from '@/lib/storage/project-store';
import type { Project, ProjectMusicGenerationAttempt, ProjectMusicSpec } from '@/lib/types/render';
import { createId } from '@/lib/utils/ids';

const activeMusicLocks = new Set<string>();

function nowIso(): string {
  return new Date().toISOString();
}

function resolveDefaultModel(): string {
  return process.env.ELEVENLABS_MUSIC_MODEL || DEFAULT_ELEVENLABS_MUSIC_MODEL;
}

export class ProjectMusicGenerationError extends Error {
  readonly status: number;
  readonly code:
    | 'music.project.notFound'
    | 'music.invalid'
    | 'music.alreadyRunning'
    | 'music.alreadyGenerated'
    | 'music.provider.notConfigured'
    | 'music.provider.unsupported'
    | 'music.provider.auth'
    | 'music.provider.rateLimited'
    | 'music.provider.rejected'
    | 'music.provider.failed'
    | 'music.asset.notFound'
    | 'music.asset.invalidType';

  constructor(
    message: string,
    status: number,
    code:
      | 'music.project.notFound'
      | 'music.invalid'
      | 'music.alreadyRunning'
      | 'music.alreadyGenerated'
      | 'music.provider.notConfigured'
      | 'music.provider.unsupported'
      | 'music.provider.auth'
      | 'music.provider.rateLimited'
      | 'music.provider.rejected'
      | 'music.provider.failed'
      | 'music.asset.notFound'
      | 'music.asset.invalidType'
  ) {
    super(message);
    this.name = 'ProjectMusicGenerationError';
    this.status = status;
    this.code = code;
  }
}

export interface ProjectMusicGenerationResult {
  status: 'generated';
  assetId: string;
  generationAttemptId: string;
  provider: string;
  model?: string;
  duration?: number;
  musicLengthMs: number;
  instrumental: boolean;
}

export interface ProjectMusicSelectionResult {
  assetId?: string;
  status: 'generated' | 'cleared';
}

interface MusicServiceDependencies {
  store: Pick<ProjectStore, 'getProject' | 'updateProject'>;
  media: Pick<typeof mediaStore, 'saveGeneratedMusic' | 'deleteAssetFile'>;
  registry: MusicRegistry;
}

const defaultDependencies: MusicServiceDependencies = {
  store: projectStore,
  media: mediaStore,
  registry: createMusicRegistry()
};

function mapProviderError(error: MusicProviderError): ProjectMusicGenerationError {
  switch (error.code) {
    case 'NOT_CONFIGURED':
      return new ProjectMusicGenerationError(error.message, 409, 'music.provider.notConfigured');
    case 'INVALID_REQUEST':
    case 'UNSUPPORTED':
      return new ProjectMusicGenerationError(error.message, 422, 'music.provider.unsupported');
    case 'PROVIDER_AUTH':
      return new ProjectMusicGenerationError(error.message, 502, 'music.provider.auth');
    case 'PROVIDER_RATE_LIMIT':
      return new ProjectMusicGenerationError(error.message, 429, 'music.provider.rateLimited');
    case 'PROVIDER_REJECTED':
      return new ProjectMusicGenerationError(error.message, 422, 'music.provider.rejected');
    default:
      return new ProjectMusicGenerationError(error.message, 502, 'music.provider.failed');
  }
}

function mapRunPolicyError(error: RunPolicyError): ProjectMusicGenerationError {
  if (error.code === 'PROVIDER_NOT_CONFIGURED') {
    return new ProjectMusicGenerationError(error.message, error.status, 'music.provider.notConfigured');
  }
  if (error.code === 'INVALID_POLICY') {
    return new ProjectMusicGenerationError(error.message, error.status, 'music.invalid');
  }
  return new ProjectMusicGenerationError(error.message, error.status, 'music.provider.unsupported');
}

function resolveMusicProvider(requestedProvider: string | undefined, mode: RunMode | undefined): string {
  try {
    return resolveManualGenerationProvider('music', requestedProvider, { mode }).provider;
  } catch (error) {
    if (error instanceof RunPolicyError) {
      throw mapRunPolicyError(error);
    }
    throw error;
  }
}

function isMusicCapable(assetType: string): boolean {
  return assetType === 'music' || assetType === 'audio';
}

export async function generateProjectMusic(
  projectId: string,
  options: {
    prompt?: string;
    musicLengthMs?: number;
    instrumental?: boolean;
    model?: string;
    provider?: string;
    seed?: number;
    outputFormat?: string;
    regenerate?: boolean;
    mode?: RunMode;
  } = {},
  dependencies: MusicServiceDependencies = defaultDependencies
): Promise<ProjectMusicGenerationResult> {
  if (activeMusicLocks.has(projectId)) {
    throw new ProjectMusicGenerationError('Music generation is already running for this project.', 409, 'music.alreadyRunning');
  }

  activeMusicLocks.add(projectId);

  try {
    const project = await dependencies.store.getProject(projectId);
    if (!project) {
      throw new ProjectMusicGenerationError(`Project ${projectId} not found.`, 404, 'music.project.notFound');
    }

    const existingMusic = project.music ?? {};

    const prompt = (options.prompt ?? existingMusic.prompt ?? '').trim();
    if (!prompt) {
      throw new ProjectMusicGenerationError('A music prompt is required before generating background music.', 400, 'music.invalid');
    }

    const musicLengthMs = clampMusicLengthMs(options.musicLengthMs ?? existingMusic.musicLengthMs);
    const instrumental = options.instrumental ?? existingMusic.instrumental ?? true;
    const model = options.model ?? existingMusic.model ?? resolveDefaultModel();
    const seed = options.seed ?? existingMusic.seed;
    // Only an explicitly requested output format is forwarded to the provider.
    // `existingMusic.format` is the stored *asset* format (e.g. "wav"/"mp3") and
    // must never be reused as a provider codec code, or a later real-provider
    // regeneration would send an unsupported value (e.g. "wav").
    const outputFormat = options.outputFormat;
    const providerId = resolveMusicProvider(options.provider, options.mode);
    const regenerate = Boolean(options.regenerate);

    if (!regenerate && existingMusic.status === 'generated' && existingMusic.assetId) {
      throw new ProjectMusicGenerationError(
        'Project already has generated background music. Use regenerate=true to create a new track.',
        409,
        'music.alreadyGenerated'
      );
    }

    if (existingMusic.status === 'generating') {
      throw new ProjectMusicGenerationError('Project background music is already generating.', 409, 'music.alreadyRunning');
    }

    const registered = (() => {
      try {
        return dependencies.registry.getProvider(providerId);
      } catch (error) {
        if (error instanceof MusicProviderError) {
          throw mapProviderError(error);
        }
        throw error;
      }
    })();

    const attemptId = createId('music_attempt');
    const previousAssetId = existingMusic.assetId;
    const previousDuration = existingMusic.duration;

    const generatingAttempt: ProjectMusicGenerationAttempt = {
      id: attemptId,
      status: 'generating',
      provider: registered.providerId,
      model,
      prompt,
      instrumental,
      musicLengthMs,
      createdAt: nowIso()
    };

    const withGenerating: Project = {
      ...project,
      music: {
        ...existingMusic,
        prompt,
        provider: registered.providerId,
        model,
        instrumental,
        musicLengthMs,
        seed,
        assetId: previousAssetId,
        duration: previousDuration,
        status: 'generating',
        lastAttemptId: attemptId,
        error: undefined,
        attempts: [...(existingMusic.attempts ?? []), generatingAttempt],
        updatedAt: nowIso()
      }
    };

    await dependencies.store.updateProject(withGenerating);

    let generated;
    try {
      generated = await registered.generate({
        prompt,
        durationMs: musicLengthMs,
        model,
        instrumental,
        seed,
        outputFormat
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Music provider call failed.';
      const failed: Project = {
        ...withGenerating,
        music: {
          ...(withGenerating.music ?? {}),
          status: 'failed',
          lastAttemptId: attemptId,
          error: message,
          attempts: (withGenerating.music?.attempts ?? []).map((attempt) =>
            attempt.id === attemptId
              ? { ...attempt, status: 'failed' as const, completedAt: nowIso(), error: message }
              : attempt
          )
        }
      };
      await dependencies.store.updateProject(failed);

      if (error instanceof MusicProviderError) {
        throw mapProviderError(error);
      }
      throw new ProjectMusicGenerationError('Music provider call failed.', 502, 'music.provider.failed');
    }

    if (!generated.data || generated.data.byteLength === 0) {
      const message = 'Music provider returned an empty audio result.';
      const failed: Project = {
        ...withGenerating,
        music: {
          ...(withGenerating.music ?? {}),
          status: 'failed',
          lastAttemptId: attemptId,
          error: message,
          attempts: (withGenerating.music?.attempts ?? []).map((attempt) =>
            attempt.id === attemptId
              ? { ...attempt, status: 'failed' as const, completedAt: nowIso(), error: message }
              : attempt
          )
        }
      };
      await dependencies.store.updateProject(failed);
      throw new ProjectMusicGenerationError(message, 502, 'music.provider.failed');
    }

    const generatedAsset = await dependencies.media.saveGeneratedMusic({
      projectId,
      attemptId,
      mimeType: generated.mimeType,
      data: generated.data,
      musicLengthMs,
      seed,
      instrumental,
      outputFormat: generated.format ?? outputFormat,
      generation: {
        generationId: attemptId,
        provider: generated.provider,
        model: generated.model ?? model,
        prompt,
        providerRequestId: generated.providerRequestId
      }
    });

    const withGenerated: Project = {
      ...withGenerating,
      assets: [...withGenerating.assets, generatedAsset],
      music: {
        ...(withGenerating.music ?? {}),
        assetId: generatedAsset.id,
        provider: generated.provider,
        model: generated.model ?? model,
        prompt,
        instrumental,
        musicLengthMs,
        seed,
        format: generated.format,
        duration: generatedAsset.duration,
        status: 'generated',
        lastAttemptId: attemptId,
        error: undefined,
        attempts: (withGenerating.music?.attempts ?? []).map((attempt) =>
          attempt.id === attemptId
            ? {
                ...attempt,
                status: 'generated' as const,
                completedAt: nowIso(),
                providerRequestId: generated.providerRequestId,
                mimeType: generated.mimeType,
                duration: generatedAsset.duration,
                audioAssetId: generatedAsset.id
              }
            : attempt
        ),
        updatedAt: nowIso()
      }
    };

    try {
      await dependencies.store.updateProject(withGenerated);
    } catch {
      // The audio file is already on disk; if the project cannot be updated we
      // remove it so no half-registered asset is left behind.
      await dependencies.media.deleteAssetFile(projectId, generatedAsset).catch(() => {});
      throw new ProjectMusicGenerationError('Failed to store the generated background music.', 500, 'music.provider.failed');
    }

    return {
      status: 'generated',
      assetId: generatedAsset.id,
      generationAttemptId: attemptId,
      provider: generated.provider,
      model: generated.model ?? model,
      duration: generatedAsset.duration,
      musicLengthMs,
      instrumental
    };
  } finally {
    activeMusicLocks.delete(projectId);
  }
}

export async function selectProjectMusic(
  projectId: string,
  assetId: string,
  dependencies: Pick<MusicServiceDependencies, 'store'> = defaultDependencies
): Promise<ProjectMusicSelectionResult> {
  const project = await dependencies.store.getProject(projectId);
  if (!project) {
    throw new ProjectMusicGenerationError(`Project ${projectId} not found.`, 404, 'music.project.notFound');
  }

  const asset = project.assets.find((entry) => entry.id === assetId);
  if (!asset) {
    throw new ProjectMusicGenerationError(`Asset ${assetId} does not exist.`, 404, 'music.asset.notFound');
  }

  if (!isMusicCapable(asset.type)) {
    throw new ProjectMusicGenerationError(`Asset ${assetId} is not a music or audio asset.`, 422, 'music.asset.invalidType');
  }

  const existingMusic: ProjectMusicSpec = project.music ?? {};
  const updated: Project = {
    ...project,
    music: {
      ...existingMusic,
      assetId: asset.id,
      provider: existingMusic.provider ?? asset.generation?.provider,
      model: existingMusic.model ?? asset.generation?.model,
      duration: asset.duration,
      status: 'generated',
      error: undefined,
      updatedAt: nowIso()
    }
  };

  await dependencies.store.updateProject(updated);

  return { assetId: asset.id, status: 'generated' };
}

export async function clearProjectMusic(
  projectId: string,
  dependencies: Pick<MusicServiceDependencies, 'store'> = defaultDependencies
): Promise<ProjectMusicSelectionResult> {
  const project = await dependencies.store.getProject(projectId);
  if (!project) {
    throw new ProjectMusicGenerationError(`Project ${projectId} not found.`, 404, 'music.project.notFound');
  }

  // Clearing only drops the selection reference. The underlying asset stays in
  // project.assets so a replacement can never orphan or delete a shared file.
  const updated: Project = {
    ...project,
    music: undefined
  };

  await dependencies.store.updateProject(updated);

  return { status: 'cleared' };
}
