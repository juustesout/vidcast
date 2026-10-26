import path from 'node:path';

import { createImageGenerationRegistry } from '@/lib/ai/image-generation/registry';
import { ImageGenerationProviderError, type ImageGenerationRequest, type ReferenceInput } from '@/lib/ai/image-generation/provider';
import { resolveRealImagePilotGate } from '@/lib/ai/image-generation/real-image-pilot';
import { assertGenerationTransition } from '@/lib/generation/generation-state';
import { HumanApprovalError } from '@/lib/explainer/human-approval';
import { resolveManualGenerationProvider, RunPolicyError } from '@/lib/production/run-policy';
import { AccessControlError } from '@/lib/security/access-control';
import { assertRealExecutionAuthorized } from '@/lib/security/real-actor';
import type { RequestIdentity } from '@/lib/security/auth';
import { logProviderError, publicErrorMessage } from '@/lib/security/safe-error';
import { MandateBudgetError } from '@/lib/spend/mandate-spend';
import { PaidSubmitCapError, assertAndReservePaidSubmit, finalizePaidSubmit } from '@/lib/spend/paid-submit-cap';
import type { RunMode } from '@/lib/production/run-types';
import { mediaStore } from '@/lib/storage/media-store';
import { projectStore, type ProjectStore } from '@/lib/storage/project-store';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import type { GenerationAttempt, GenerationErrorCode, GenerationProvider, GenerationRecord } from '@/lib/types/generation';
import type { Project } from '@/lib/types/render';
import type { ReferenceImage } from '@/lib/types/reference';
import type { Scene } from '@/lib/types/scene';
import { FileExclusiveLock, type ExclusiveLock } from '@/lib/utils/exclusive-file-lock';
import { createId } from '@/lib/utils/ids';

const defaultSubmitLocks = new FileExclusiveLock({
  resolvePath: (key) => {
    const separator = key.indexOf(':');
    const projectId = separator === -1 ? key : key.slice(0, separator);
    const sceneId = separator === -1 ? 'scene' : key.slice(separator + 1);
    const safeSceneId = sceneId.replace(/[^A-Za-z0-9._-]+/g, '_');
    return path.join(getProjectRoot(projectId), 'locks', `image-submit-${safeSceneId}.lock`);
  }
});

function lockKey(projectId: string, sceneId: string): string {
  return `${projectId}:${sceneId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class SceneImageGenerationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'SceneImageGenerationError';
    this.status = status;
    this.code = code;
  }
}

export interface SceneImageGenerationExecutionResult {
  sceneId: string;
  status: GenerationRecord['status'];
  assetId?: string;
  generationAttemptId: string;
  provider: string;
  model?: string;
}

interface ImageGenerationServiceDependencies {
  store: Pick<ProjectStore, 'getProject' | 'mutateProject'>;
  media: Pick<typeof mediaStore, 'saveGeneratedImage' | 'exists' | 'readRelativeFile'>;
  registry: ReturnType<typeof createImageGenerationRegistry>;
  submitLocks?: ExclusiveLock;
}

const defaultDependencies: ImageGenerationServiceDependencies = {
  store: projectStore,
  media: mediaStore,
  registry: createImageGenerationRegistry(),
  submitLocks: defaultSubmitLocks
};

function submitLocksOf(dependencies: ImageGenerationServiceDependencies): ExclusiveLock {
  return dependencies.submitLocks ?? defaultSubmitLocks;
}

function getReferenceById(project: Project, referenceId: string): ReferenceImage {
  const reference = project.references.find((entry) => entry.id === referenceId);
  if (!reference) {
    throw new SceneImageGenerationError(`Reference ${referenceId} not found.`, 404, 'generation.reference.notFound');
  }
  if (!reference.filePath) {
    throw new SceneImageGenerationError(`Reference ${referenceId} is missing a file path.`, 400, 'generation.reference.missingPath');
  }
  return reference;
}

async function resolveReferenceInputs(project: Project, referenceIds: string[], media: ImageGenerationServiceDependencies['media']): Promise<ReferenceInput[]> {
  const references: ReferenceInput[] = [];

  for (const referenceId of referenceIds) {
    const reference = getReferenceById(project, referenceId);
    const exists = await media.exists(project.id, reference.filePath!);
    if (!exists) {
      throw new SceneImageGenerationError(`Reference ${reference.name} is missing on disk.`, 404, 'generation.reference.fileMissing');
    }

    const bytes = await media.readRelativeFile(project.id, reference.filePath!);
    const mimeType = typeof reference.metadata?.mimeType === 'string' ? reference.metadata.mimeType : 'image/png';

    references.push({
      id: reference.id,
      mimeType,
      data: bytes,
      filename: path.basename(reference.filePath!)
    });
  }

  return references;
}

function getScene(project: Project, sceneId: string): Scene {
  const scene = project.scenes.find((entry) => entry.id === sceneId);
  if (!scene) {
    throw new SceneImageGenerationError(`Scene ${sceneId} not found.`, 404, 'generation.scene.notFound');
  }
  return scene;
}

function ensureGeneratedImageScene(scene: Scene): asserts scene is Scene & { visual: Extract<NonNullable<Scene['visual']>, { kind: 'generated_image' }> } {
  if (!scene.visual || scene.visual.kind !== 'generated_image') {
    throw new SceneImageGenerationError('Scene is not an AI image generation scene.', 400, 'generation.scene.invalidVisualKind');
  }
}

function updateScene(project: Project, sceneId: string, updater: (scene: Scene) => Scene): Project {
  return {
    ...project,
    scenes: project.scenes.map((scene) => (scene.id === sceneId ? updater(scene) : scene))
  };
}

function sanitizeProviderError(error: unknown): string {
  if (error instanceof ImageGenerationProviderError) {
    logProviderError('image-generation', { code: error.code, status: error.status, error });
    return publicErrorMessage(error, 'Image generation failed.');
  }

  logProviderError('image-generation', { code: 'INTERNAL', error });
  return 'Image generation failed.';
}

// Projects the image provider's fine-grained internal code onto the persisted
// `GenerationErrorCode` vocabulary so a failed scene carries a machine-readable
// reason instead of only a free-text message.
function mapProviderErrorCode(error: unknown): GenerationErrorCode {
  if (!(error instanceof ImageGenerationProviderError)) {
    return 'INTERNAL';
  }

  switch (error.code) {
    case 'provider.notConfigured':
      return 'NOT_CONFIGURED';
    case 'provider.aspectRatio.unsupported':
      return 'UNSUPPORTED';
    case 'provider.request.unauthorized':
      return 'PROVIDER_AUTH';
    case 'provider.request.rateLimited':
      return 'PROVIDER_RATE_LIMIT';
    case 'provider.request.rejected':
      return 'PROVIDER_REJECTED';
    case 'provider.request.timeout':
    case 'provider.request.unreachable':
    case 'provider.request.failed':
      return 'PROVIDER_FAILED';
    case 'provider.response.invalid':
    case 'provider.response.missingImage':
    case 'provider.response.invalidImage':
      return 'MEDIA_INVALID';
    default:
      return 'INTERNAL';
  }
}

function mapRunPolicyError(error: RunPolicyError): SceneImageGenerationError {
  const codeByPolicyCode: Record<RunPolicyError['code'], string> = {
    POLICY_DENIED: 'generation.policy.denied',
    INVALID_POLICY: 'generation.policy.invalid',
    PROVIDER_NOT_ALLOWED: 'generation.provider.notAllowed',
    PROVIDER_NOT_CONFIGURED: 'generation.provider.notConfigured'
  };

  return new SceneImageGenerationError(error.message, error.status, codeByPolicyCode[error.code]);
}

function resolveImageProvider(options: { provider?: string; mode?: RunMode }) {
  const pilot = resolveRealImagePilotGate();
  try {
    return resolveManualGenerationProvider('image', options.provider, { mode: options.mode, imagePilot: pilot.allowed });
  } catch (error) {
    if (error instanceof RunPolicyError) {
      throw mapRunPolicyError(error);
    }
    throw error;
  }
}

export async function generateSceneImage(
  projectId: string,
  sceneId: string,
  options: { regenerate?: boolean; provider?: string; mode?: RunMode; identity?: RequestIdentity } = {},
  dependencies: ImageGenerationServiceDependencies = defaultDependencies
): Promise<SceneImageGenerationExecutionResult> {
  const key = lockKey(projectId, sceneId);
  const submitLocks = submitLocksOf(dependencies);
  if (!(await submitLocks.tryAcquire(key))) {
    throw new SceneImageGenerationError('Generation is already running for this scene.', 409, 'generation.scene.alreadyRunning');
  }

  try {
    const project = await dependencies.store.getProject(projectId);
    if (!project) {
      throw new SceneImageGenerationError(`Project ${projectId} not found.`, 404, 'generation.project.notFound');
    }

    const scene = getScene(project, sceneId);
    ensureGeneratedImageScene(scene);

    const current = scene.visual.generation;
    const regenerate = Boolean(options.regenerate);

    if (!regenerate && current.status === 'generated' && (scene.visual.assetId || current.assetId)) {
      throw new SceneImageGenerationError('Scene already has a generated image. Use regenerate=true to generate a new one.', 409, 'generation.scene.alreadyGenerated');
    }

    if (current.status === 'queued' || current.status === 'generating') {
      throw new SceneImageGenerationError('Scene generation is already in progress.', 409, 'generation.scene.busy');
    }

    if (!current.prompt.trim()) {
      throw new SceneImageGenerationError('Generation prompt is required.', 400, 'generation.scene.missingPrompt');
    }

    assertGenerationTransition(current.status, 'queued', regenerate);

    const resolution = resolveImageProvider(options);
    try {
      await assertRealExecutionAuthorized(project, resolution.mode, options.identity);
    } catch (error) {
      if (error instanceof HumanApprovalError) {
        throw new SceneImageGenerationError(error.message, error.status, `generation.approval.${error.code === 'HUMAN_APPROVAL_STALE' ? 'stale' : 'required'}`);
      }
      if (error instanceof AccessControlError) {
        throw new SceneImageGenerationError(error.message, error.status, 'generation.policy.denied');
      }
      throw error;
    }
    const providerId = resolution.provider;
    const provider = dependencies.registry.getProvider(providerId);
    const referenceIds = current.referenceIds && current.referenceIds.length > 0 ? current.referenceIds : scene.referenceIds;
    const referenceImages = await resolveReferenceInputs(project, referenceIds, dependencies.media);
    const attemptId = createId('generation_attempt');
    let paidSubmit;
    try {
      paidSubmit = await assertAndReservePaidSubmit({
        projectId,
        sceneId,
        modality: 'image',
        provider: provider.providerId,
        mode: resolution.mode,
        idempotencyKey: attemptId
      });
    } catch (error) {
      if (error instanceof PaidSubmitCapError || error instanceof MandateBudgetError) {
        throw new SceneImageGenerationError(error.message, error.status, error.code);
      }
      throw error;
    }
    const previousAssetId = scene.visual.assetId || current.assetId;

    const queuedAttempt: GenerationAttempt = {
      ...current,
      id: attemptId,
      status: 'queued',
      provider: provider.providerId as GenerationProvider,
      referenceIds,
      createdAt: nowIso(),
      completedAt: undefined,
      assetId: previousAssetId,
      error: undefined
    };

    await dependencies.store.mutateProject(projectId, (fresh) =>
      updateScene(fresh, sceneId, (entry) => {
        ensureGeneratedImageScene(entry);
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

    const generatingAttempt: GenerationAttempt = {
      ...queuedAttempt,
      status: 'generating'
    };

    await dependencies.store.mutateProject(projectId, (fresh) =>
      updateScene(fresh, sceneId, (entry) => {
        ensureGeneratedImageScene(entry);
        return {
          ...entry,
          visual: {
            ...entry.visual,
            generation: generatingAttempt
          }
        };
      })
    );

    const request: ImageGenerationRequest = {
      prompt: current.prompt,
      negativePrompt: current.negativePrompt,
      model: current.model,
      aspectRatio: current.aspectRatio || project.aspectRatio,
      referenceImages,
      metadata: current.metadata
    };

    let generated = undefined as Awaited<ReturnType<typeof provider.generateImage>> | undefined;
    try {
      generated = await provider.generateImage(request);
    } catch (error) {
      await finalizePaidSubmit(paidSubmit, 'failed');
      const errorMessage = sanitizeProviderError(error);
      const failedAttempt: GenerationAttempt = {
        ...generatingAttempt,
        status: 'failed',
        completedAt: nowIso(),
        error: errorMessage,
        errorMessage,
        errorCode: mapProviderErrorCode(error),
        assetId: previousAssetId
      };

      const withFailed = (fresh: Project) => updateScene(fresh, sceneId, (entry) => {
        ensureGeneratedImageScene(entry);
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

      if (error instanceof ImageGenerationProviderError) {
        throw new SceneImageGenerationError(publicErrorMessage(error, 'Image generation failed.'), error.status, error.code);
      }

      throw new SceneImageGenerationError('Provider call failed during image generation.', 502, 'generation.provider.failed');
    }

    await finalizePaidSubmit(paidSubmit, 'completed');

    const generatedAsset = await dependencies.media.saveGeneratedImage({
      projectId,
      sceneOrder: scene.order,
      attemptId,
      mimeType: generated.mimeType,
      data: generated.data,
      generation: {
        generationId: attemptId,
        provider: generated.provider,
        model: generated.model,
        prompt: current.prompt,
        referenceIds,
        providerRequestId: generated.providerRequestId
      }
    });

    const generatedAttempt: GenerationAttempt = {
      ...generatingAttempt,
      status: 'generated',
      completedAt: nowIso(),
      assetId: generatedAsset.id,
      provider: generated.provider as GenerationRecord['provider'],
      model: generated.model,
      providerRequestId: generated.providerRequestId,
      metadata: {
        ...(current.metadata ?? {}),
        ...(generated.metadata ?? {})
      },
      error: undefined
    };

    const withGenerated = (fresh: Project) => {
      const next = updateScene(fresh, sceneId, (entry) => {
        ensureGeneratedImageScene(entry);
        return {
          ...entry,
          visual: {
            ...entry.visual,
            generation: generatedAttempt,
            assetId: generatedAsset.id
          }
        };
      });
      return { ...next, assets: [...next.assets, generatedAsset] };
    };

    await dependencies.store.mutateProject(projectId, withGenerated);

    return {
      sceneId,
      status: 'generated',
      assetId: generatedAsset.id,
      generationAttemptId: attemptId,
      provider: generated.provider,
      model: generated.model
    };
  } finally {
    await submitLocks.release(key);
  }
}
