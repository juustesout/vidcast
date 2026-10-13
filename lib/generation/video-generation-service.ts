import path from 'node:path';

import { createVideoGenerationRegistry } from '@/lib/ai/video-generation/registry';
import { VideoGenerationProviderError, type VideoReferenceInput } from '@/lib/ai/video-generation/provider';
import { assertGenerationTransition } from '@/lib/generation/generation-state';
import { resolveManualGenerationProvider, RunPolicyError } from '@/lib/production/run-policy';
import type { RunMode } from '@/lib/production/run-types';
import { mediaStore } from '@/lib/storage/media-store';
import { projectStore, type ProjectStore } from '@/lib/storage/project-store';
import type { GenerationAttempt, GenerationProvider, GenerationRecord, GenerationStatus } from '@/lib/types/generation';
import type { Project } from '@/lib/types/render';
import type { ReferenceImage } from '@/lib/types/reference';
import type { Scene } from '@/lib/types/scene';
import { createId } from '@/lib/utils/ids';

const activeSceneSubmitLocks = new Set<string>();
const activeAttemptPollLocks = new Set<string>();

function sceneLockKey(projectId: string, sceneId: string): string {
  return `${projectId}:${sceneId}`;
}

function attemptLockKey(projectId: string, attemptId: string): string {
  return `${projectId}:${attemptId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeProviderNameForGeneration(providerId: string): GenerationProvider {
  if (providerId === 'openai') {
    return 'openai';
  }
  if (providerId === 'gemini') {
    return 'gemini';
  }
  if (providerId === 'fal') {
    return 'fal';
  }
  if (providerId === 'fake') {
    return 'local';
  }
  if (providerId === 'local') {
    return 'local';
  }
  return 'other';
}

export class SceneVideoGenerationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'SceneVideoGenerationError';
    this.status = status;
    this.code = code;
  }
}

export interface SceneVideoGenerationSubmissionResult {
  sceneId: string;
  generationAttemptId: string;
  status: Extract<GenerationStatus, 'queued' | 'generating'>;
  provider: string;
  model?: string;
  providerJobId: string;
  providerStatus?: string;
}

export interface SceneVideoGenerationJobResult {
  sceneId: string;
  generationAttemptId: string;
  status: GenerationStatus;
  assetId?: string;
  provider: string;
  model?: string;
  providerJobId?: string;
  providerStatus?: string;
  errorCode?: string;
  errorMessage?: string;
  lastPolledAt?: string;
}

interface VideoGenerationServiceDependencies {
  store: Pick<ProjectStore, 'getProject' | 'mutateProject'>;
  media: Pick<typeof mediaStore, 'exists' | 'readRelativeFile' | 'saveGeneratedVideo'>;
  registry: ReturnType<typeof createVideoGenerationRegistry>;
}

const defaultDependencies: VideoGenerationServiceDependencies = {
  store: projectStore,
  media: mediaStore,
  registry: createVideoGenerationRegistry()
};

function getScene(project: Project, sceneId: string): Scene {
  const scene = project.scenes.find((entry) => entry.id === sceneId);
  if (!scene) {
    throw new SceneVideoGenerationError(`Scene ${sceneId} not found.`, 404, 'generation.scene.notFound');
  }
  return scene;
}

function ensureGeneratedVideoScene(scene: Scene): asserts scene is Scene & { visual: Extract<NonNullable<Scene['visual']>, { kind: 'generated_video' }> } {
  if (!scene.visual || scene.visual.kind !== 'generated_video') {
    throw new SceneVideoGenerationError('Scene is not an AI video generation scene.', 400, 'generation.scene.invalidVisualKind');
  }
}

function updateScene(project: Project, sceneId: string, updater: (scene: Scene) => Scene): Project {
  return {
    ...project,
    scenes: project.scenes.map((scene) => (scene.id === sceneId ? updater(scene) : scene))
  };
}

function sanitizeProviderError(error: unknown): { message: string; errorCode: GenerationRecord['errorCode'] } {
  if (error instanceof VideoGenerationProviderError) {
    return {
      message: error.message,
      errorCode: error.code
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      errorCode: 'PROVIDER_FAILED'
    };
  }

  return {
    message: 'Video generation failed.',
    errorCode: 'PROVIDER_FAILED'
  };
}

function mapRunPolicyError(error: RunPolicyError): SceneVideoGenerationError {
  const codeByPolicyCode: Record<RunPolicyError['code'], string> = {
    POLICY_DENIED: 'generation.policy.denied',
    INVALID_POLICY: 'generation.policy.invalid',
    PROVIDER_NOT_ALLOWED: 'generation.provider.notAllowed',
    PROVIDER_NOT_CONFIGURED: 'generation.provider.notConfigured'
  };

  return new SceneVideoGenerationError(error.message, error.status, codeByPolicyCode[error.code]);
}

function resolveVideoProvider(requestedProvider: string | undefined, mode: RunMode | undefined): string {
  try {
    return resolveManualGenerationProvider('video', requestedProvider, { mode }).provider;
  } catch (error) {
    if (error instanceof RunPolicyError) {
      throw mapRunPolicyError(error);
    }
    throw error;
  }
}

function getReferenceById(project: Project, referenceId: string): ReferenceImage {
  const reference = project.references.find((entry) => entry.id === referenceId);
  if (!reference) {
    throw new SceneVideoGenerationError(`Reference ${referenceId} not found.`, 404, 'generation.reference.notFound');
  }
  if (!reference.filePath) {
    throw new SceneVideoGenerationError(`Reference ${referenceId} is missing a file path.`, 400, 'generation.reference.missingPath');
  }
  return reference;
}

interface FrameReferenceDesignation {
  startFrameReferenceId?: string;
  endFrameReferenceId?: string;
}

// Validates that explicitly designated keyframe references are usable before any
// provider call: both frames must be distinct and must be part of the scene's
// effective reference set. A missing/unknown frame is a request error, not a
// silently ignored input.
function assertFrameReferences(referenceIds: string[], frames: FrameReferenceDesignation): void {
  const { startFrameReferenceId, endFrameReferenceId } = frames;

  if (startFrameReferenceId && endFrameReferenceId && startFrameReferenceId === endFrameReferenceId) {
    throw new SceneVideoGenerationError(
      'The start frame and end frame must reference different images.',
      400,
      'generation.reference.frameConflict'
    );
  }

  const entries: Array<[label: string, id: string | undefined]> = [
    ['start', startFrameReferenceId],
    ['end', endFrameReferenceId]
  ];

  for (const [label, id] of entries) {
    if (id && !referenceIds.includes(id)) {
      throw new SceneVideoGenerationError(
        `The ${label} frame reference ${id} is not part of the scene references.`,
        400,
        `generation.reference.${label}FrameInvalid`
      );
    }
  }
}

async function resolveReferenceInputs(
  project: Project,
  referenceIds: string[],
  media: VideoGenerationServiceDependencies['media'],
  frames: FrameReferenceDesignation = {}
): Promise<VideoReferenceInput[]> {
  const references: VideoReferenceInput[] = [];

  for (const referenceId of referenceIds) {
    const reference = getReferenceById(project, referenceId);
    const exists = await media.exists(project.id, reference.filePath!);
    if (!exists) {
      throw new SceneVideoGenerationError(`Reference ${reference.name} is missing on disk.`, 404, 'generation.reference.fileMissing');
    }

    const bytes = await media.readRelativeFile(project.id, reference.filePath!);
    const mimeType = typeof reference.metadata?.mimeType === 'string' ? reference.metadata.mimeType : 'image/png';

    // Plain references stay `reference`; only explicitly designated keyframes are
    // marked, so text-to-video and existing reference behaviour is unchanged.
    const role: VideoReferenceInput['role'] =
      reference.id === frames.startFrameReferenceId
        ? 'start_frame'
        : reference.id === frames.endFrameReferenceId
          ? 'end_frame'
          : 'reference';

    references.push({
      id: reference.id,
      mimeType,
      data: bytes,
      filename: path.basename(reference.filePath!),
      role
    });
  }

  return references;
}

function findAttempt(project: Project, attemptId: string): { scene: Scene; isCurrent: boolean; attempt: GenerationAttempt } {
  for (const scene of project.scenes) {
    if (!scene.visual || (scene.visual.kind !== 'generated_video' && scene.visual.kind !== 'generated_image')) {
      continue;
    }

    if (scene.visual.generation.id === attemptId) {
      return {
        scene,
        isCurrent: true,
        attempt: scene.visual.generation
      };
    }

    const matched = (scene.visual.attempts ?? []).find((entry) => entry.id === attemptId);
    if (matched) {
      return {
        scene,
        isCurrent: false,
        attempt: matched
      };
    }
  }

  throw new SceneVideoGenerationError(`Generation attempt ${attemptId} not found.`, 404, 'generation.attempt.notFound');
}

function activeStatus(status: GenerationStatus): boolean {
  return status === 'queued' || status === 'generating';
}

export async function submitSceneVideoGeneration(
  projectId: string,
  sceneId: string,
  options: { regenerate?: boolean; provider?: string; mode?: RunMode } = {},
  dependencies: VideoGenerationServiceDependencies = defaultDependencies
): Promise<SceneVideoGenerationSubmissionResult> {
  const key = sceneLockKey(projectId, sceneId);
  if (activeSceneSubmitLocks.has(key)) {
    throw new SceneVideoGenerationError('Video generation submit is already running for this scene.', 409, 'generation.scene.alreadyRunning');
  }

  activeSceneSubmitLocks.add(key);

  try {
    const project = await dependencies.store.getProject(projectId);
    if (!project) {
      throw new SceneVideoGenerationError(`Project ${projectId} not found.`, 404, 'generation.project.notFound');
    }

    const scene = getScene(project, sceneId);
    ensureGeneratedVideoScene(scene);

    const current = scene.visual.generation;
    const regenerate = Boolean(options.regenerate);

    if (!regenerate && current.status === 'generated' && (scene.visual.assetId || current.assetId)) {
      throw new SceneVideoGenerationError('Scene already has a generated video. Use regenerate=true to generate a new one.', 409, 'generation.scene.alreadyGenerated');
    }

    if (activeStatus(current.status) && current.providerJobId) {
      throw new SceneVideoGenerationError('Scene video generation already has an active provider job.', 409, 'generation.scene.busy');
    }

    if (!current.prompt.trim()) {
      throw new SceneVideoGenerationError('Generation prompt is required.', 400, 'generation.scene.missingPrompt');
    }

    assertGenerationTransition(current.status, 'queued', regenerate);

    const providerKey = resolveVideoProvider(options.provider, options.mode);
    const provider = dependencies.registry.getProvider(providerKey);
    const referenceIds = current.referenceIds && current.referenceIds.length > 0 ? current.referenceIds : scene.referenceIds;
    assertFrameReferences(referenceIds, current);
    const references = await resolveReferenceInputs(project, referenceIds, dependencies.media, current);
    const previousAssetId = scene.visual.assetId || current.assetId;
    const attemptId = createId('generation_attempt');

    const queuedAttempt: GenerationAttempt = {
      ...current,
      id: attemptId,
      kind: 'video',
      status: 'queued',
      provider: normalizeProviderNameForGeneration(provider.providerId),
      referenceIds,
      duration: current.duration ?? scene.duration,
      assetId: previousAssetId,
      providerJobId: undefined,
      providerStatus: 'queued',
      submittedAt: nowIso(),
      lastPolledAt: undefined,
      completedAt: undefined,
      error: undefined,
      errorCode: undefined,
      errorMessage: undefined,
      createdAt: nowIso()
    };

    await dependencies.store.mutateProject(projectId, (fresh) =>
      updateScene(fresh, sceneId, (entry) => {
        ensureGeneratedVideoScene(entry);
        return {
          ...entry,
          visual: {
            ...entry.visual,
            generation: queuedAttempt,
            attempts: [...(entry.visual.attempts ?? []), entry.visual.generation]
          }
        };
      })
    );

    let submission;
    try {
      submission = await provider.submit({
        model: current.model,
        prompt: current.prompt,
        references,
        aspectRatio: current.aspectRatio || project.aspectRatio,
        durationSeconds: Math.max(1, Math.round(current.duration ?? scene.duration)),
        metadata: {
          projectId,
          sceneId,
          attemptId
        }
      });
    } catch (error) {
      const providerFailure = sanitizeProviderError(error);
      const failedAttempt: GenerationAttempt = {
        ...queuedAttempt,
        status: 'failed',
        completedAt: nowIso(),
        error: providerFailure.message,
        errorCode: providerFailure.errorCode,
        errorMessage: providerFailure.message,
        providerStatus: 'submit_failed',
        assetId: previousAssetId
      };

      const withFailed = (fresh: Project) => updateScene(fresh, sceneId, (entry) => {
        ensureGeneratedVideoScene(entry);
        return {
          ...entry,
          visual: {
            ...entry.visual,
            generation: failedAttempt,
            assetId: previousAssetId
          }
        };
      });
      await dependencies.store.mutateProject(projectId, withFailed);

      if (error instanceof VideoGenerationProviderError) {
        throw new SceneVideoGenerationError(error.message, error.status, error.code);
      }
      throw new SceneVideoGenerationError('Provider call failed while submitting video generation.', 502, 'generation.provider.failed');
    }

    const updatedAttempt: GenerationAttempt = {
      ...queuedAttempt,
      status: submission.status,
      providerJobId: submission.providerJobId,
      providerStatus: submission.providerStatus || submission.status,
      submittedAt: nowIso(),
      lastPolledAt: nowIso()
    };

    const withSubmission = (fresh: Project) => updateScene(fresh, sceneId, (entry) => {
      ensureGeneratedVideoScene(entry);
      return {
        ...entry,
        visual: {
          ...entry.visual,
          generation: updatedAttempt
        }
      };
    });

    await dependencies.store.mutateProject(projectId, withSubmission);

    return {
      sceneId,
      generationAttemptId: attemptId,
      status: submission.status,
      provider: provider.providerId,
      model: current.model,
      providerJobId: updatedAttempt.providerJobId!,
      providerStatus: updatedAttempt.providerStatus
    };
  } finally {
    activeSceneSubmitLocks.delete(key);
  }
}

export async function refreshVideoGenerationAttempt(
  projectId: string,
  attemptId: string,
  dependencies: VideoGenerationServiceDependencies = defaultDependencies,
  options: { mode?: RunMode } = {}
): Promise<SceneVideoGenerationJobResult> {
  const key = attemptLockKey(projectId, attemptId);
  if (activeAttemptPollLocks.has(key)) {
    throw new SceneVideoGenerationError('Generation job poll is already running for this attempt.', 409, 'generation.attempt.pollBusy');
  }

  activeAttemptPollLocks.add(key);

  try {
    const project = await dependencies.store.getProject(projectId);
    if (!project) {
      throw new SceneVideoGenerationError(`Project ${projectId} not found.`, 404, 'generation.project.notFound');
    }

    const located = findAttempt(project, attemptId);
    const scene = located.scene;

    if (!scene.visual || scene.visual.kind !== 'generated_video') {
      throw new SceneVideoGenerationError('Attempt is not associated with a generated video scene.', 400, 'generation.scene.invalidVisualKind');
    }

    let attempt = located.attempt;
    if (!located.isCurrent) {
      return {
        sceneId: scene.id,
        generationAttemptId: attempt.id,
        status: attempt.status,
        assetId: attempt.assetId,
        provider: attempt.provider || 'other',
        model: attempt.model,
        providerJobId: attempt.providerJobId,
        providerStatus: attempt.providerStatus,
        errorCode: attempt.errorCode,
        errorMessage: attempt.errorMessage || attempt.error,
        lastPolledAt: attempt.lastPolledAt
      };
    }

    if (!activeStatus(attempt.status)) {
      return {
        sceneId: scene.id,
        generationAttemptId: attempt.id,
        status: attempt.status,
        assetId: scene.visual.assetId || attempt.assetId,
        provider: attempt.provider || 'other',
        model: attempt.model,
        providerJobId: attempt.providerJobId,
        providerStatus: attempt.providerStatus,
        errorCode: attempt.errorCode,
        errorMessage: attempt.errorMessage || attempt.error,
        lastPolledAt: attempt.lastPolledAt
      };
    }

    if (!attempt.providerJobId) {
      throw new SceneVideoGenerationError('Active generation attempt is missing provider job id.', 500, 'generation.attempt.missingJobId');
    }

    const providerKey = resolveVideoProvider(attempt.provider && attempt.provider !== 'other' ? attempt.provider : undefined, options.mode);
    const provider = dependencies.registry.getProvider(providerKey);

    let providerStatus;
    try {
      providerStatus = await provider.getStatus(attempt.providerJobId);
    } catch (error) {
      const normalized = sanitizeProviderError(error);
      const failedAttempt: GenerationAttempt = {
        ...attempt,
        status: 'failed',
        providerStatus: 'status_failed',
        error: normalized.message,
        errorCode: normalized.errorCode,
        errorMessage: normalized.message,
        completedAt: nowIso(),
        lastPolledAt: nowIso()
      };

      const withFailed = (fresh: Project) => updateScene(fresh, scene.id, (entry) => {
        ensureGeneratedVideoScene(entry);
        return {
          ...entry,
          visual: {
            ...entry.visual,
            generation: failedAttempt,
            assetId: entry.visual.assetId || attempt.assetId
          }
        };
      });

      await dependencies.store.mutateProject(projectId, withFailed);

      if (error instanceof VideoGenerationProviderError) {
        throw new SceneVideoGenerationError(error.message, error.status, error.code);
      }
      throw new SceneVideoGenerationError('Provider status call failed for generation job.', 502, 'generation.provider.failed');
    }

    let nextAttempt: GenerationAttempt = {
      ...attempt,
      status: providerStatus.status,
      providerStatus: providerStatus.providerStatus,
      lastPolledAt: nowIso(),
      errorCode: providerStatus.errorCode,
      errorMessage: providerStatus.errorMessage,
      error: providerStatus.errorMessage || attempt.error,
      metadata: {
        ...(attempt.metadata ?? {}),
        ...(providerStatus.metadata ?? {})
      }
    };

    let assetIdMode: 'preserve' | 'fallback' | 'explicit' = 'preserve';
    let explicitAssetId: string | undefined;
    let appendedAsset: Awaited<ReturnType<typeof dependencies.media.saveGeneratedVideo>> | undefined;

    if (providerStatus.status === 'generated') {
      try {
        const download = await provider.download(attempt.providerJobId);
        const generatedAsset = await dependencies.media.saveGeneratedVideo({
          projectId,
          sceneOrder: scene.order,
          attemptId: attempt.id,
          mimeType: download.mimeType,
          data: download.data,
          generation: {
            generationId: attempt.id,
            provider: provider.providerId,
            model: attempt.model,
            prompt: attempt.prompt,
            referenceIds: attempt.referenceIds ?? [],
            providerRequestId: attempt.providerRequestId,
            providerJobId: attempt.providerJobId
          }
        });

        nextAttempt = {
          ...nextAttempt,
          status: 'generated',
          provider: normalizeProviderNameForGeneration(provider.providerId),
          completedAt: nowIso(),
          assetId: generatedAsset.id,
          error: undefined,
          errorCode: undefined,
          errorMessage: undefined,
          metadata: {
            ...(nextAttempt.metadata ?? {}),
            ...(download.metadata ?? {})
          }
        };

        assetIdMode = 'explicit';
        explicitAssetId = generatedAsset.id;
        appendedAsset = generatedAsset;
      } catch (error) {
        const normalized = sanitizeProviderError(error);
        nextAttempt = {
          ...nextAttempt,
          status: 'failed',
          completedAt: nowIso(),
          error: normalized.message,
          errorCode: normalized.errorCode || 'DOWNLOAD_FAILED',
          errorMessage: normalized.message
        };
        assetIdMode = 'fallback';
      }
    } else if (providerStatus.status === 'failed' || providerStatus.status === 'rejected') {
      nextAttempt = {
        ...nextAttempt,
        completedAt: nowIso(),
        assetId: scene.visual.assetId || attempt.assetId
      };
      assetIdMode = 'fallback';
    }

    const persisted = await dependencies.store.mutateProject(projectId, (fresh) => {
      const next = updateScene(fresh, scene.id, (entry) => {
        ensureGeneratedVideoScene(entry);
        const resolvedAssetId =
          assetIdMode === 'explicit'
            ? explicitAssetId
            : assetIdMode === 'fallback'
              ? entry.visual.assetId || attempt.assetId
              : entry.visual.assetId;
        return {
          ...entry,
          visual: {
            ...entry.visual,
            generation: nextAttempt,
            assetId: resolvedAssetId
          }
        };
      });
      return appendedAsset ? { ...next, assets: [...next.assets, appendedAsset] } : next;
    });

    if (!persisted) {
      throw new SceneVideoGenerationError(`Project ${projectId} was removed during generation polling.`, 404, 'generation.project.notFound');
    }

    const persistedScene = getScene(persisted, scene.id);
    ensureGeneratedVideoScene(persistedScene);
    attempt = persistedScene.visual.generation;

    return {
      sceneId: persistedScene.id,
      generationAttemptId: attempt.id,
      status: attempt.status,
      assetId: persistedScene.visual.assetId || attempt.assetId,
      provider: attempt.provider || 'other',
      model: attempt.model,
      providerJobId: attempt.providerJobId,
      providerStatus: attempt.providerStatus,
      errorCode: attempt.errorCode,
      errorMessage: attempt.errorMessage || attempt.error,
      lastPolledAt: attempt.lastPolledAt
    };
  } finally {
    activeAttemptPollLocks.delete(key);
  }
}
