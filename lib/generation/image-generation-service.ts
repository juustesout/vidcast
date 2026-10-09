import path from 'node:path';

import { createImageGenerationRegistry } from '@/lib/ai/image-generation/registry';
import { ImageGenerationProviderError, type ImageGenerationRequest, type ReferenceInput } from '@/lib/ai/image-generation/provider';
import { assertGenerationTransition } from '@/lib/generation/generation-state';
import { resolveManualGenerationProvider, RunPolicyError } from '@/lib/production/run-policy';
import type { RunMode } from '@/lib/production/run-types';
import { mediaStore } from '@/lib/storage/media-store';
import { projectStore, type ProjectStore } from '@/lib/storage/project-store';
import type { GenerationAttempt, GenerationProvider, GenerationRecord } from '@/lib/types/generation';
import type { Project } from '@/lib/types/render';
import type { ReferenceImage } from '@/lib/types/reference';
import type { Scene } from '@/lib/types/scene';
import { createId } from '@/lib/utils/ids';

const activeGenerationLocks = new Set<string>();

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
  store: Pick<ProjectStore, 'getProject' | 'updateProject'>;
  media: Pick<typeof mediaStore, 'saveGeneratedImage' | 'exists' | 'readRelativeFile'>;
  registry: ReturnType<typeof createImageGenerationRegistry>;
}

const defaultDependencies: ImageGenerationServiceDependencies = {
  store: projectStore,
  media: mediaStore,
  registry: createImageGenerationRegistry()
};

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
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Image generation failed.';
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

function resolveImageProvider(options: { provider?: string; mode?: RunMode }): string {
  try {
    return resolveManualGenerationProvider('image', options.provider, { mode: options.mode }).provider;
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
  options: { regenerate?: boolean; provider?: string; mode?: RunMode } = {},
  dependencies: ImageGenerationServiceDependencies = defaultDependencies
): Promise<SceneImageGenerationExecutionResult> {
  const key = lockKey(projectId, sceneId);
  if (activeGenerationLocks.has(key)) {
    throw new SceneImageGenerationError('Generation is already running for this scene.', 409, 'generation.scene.alreadyRunning');
  }

  activeGenerationLocks.add(key);

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

    const providerId = resolveImageProvider(options);
    const provider = dependencies.registry.getProvider(providerId);
    const referenceIds = current.referenceIds && current.referenceIds.length > 0 ? current.referenceIds : scene.referenceIds;
    const referenceImages = await resolveReferenceInputs(project, referenceIds, dependencies.media);

    const attemptId = createId('generation_attempt');
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

    const withQueued = updateScene(project, sceneId, (entry) => {
      ensureGeneratedImageScene(entry);
      return {
        ...entry,
        visual: {
          ...entry.visual,
          generation: queuedAttempt,
          attempts: [...(entry.visual.attempts ?? []), entry.visual.generation]
        }
      };
    });

    await dependencies.store.updateProject(withQueued);

    const generatingAttempt: GenerationAttempt = {
      ...queuedAttempt,
      status: 'generating'
    };

    const withGenerating = updateScene(withQueued, sceneId, (entry) => {
      ensureGeneratedImageScene(entry);
      return {
        ...entry,
        visual: {
          ...entry.visual,
          generation: generatingAttempt
        }
      };
    });

    await dependencies.store.updateProject(withGenerating);

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
      const failedAttempt: GenerationAttempt = {
        ...generatingAttempt,
        status: 'failed',
        completedAt: nowIso(),
        error: sanitizeProviderError(error),
        assetId: previousAssetId
      };

      const withFailed = updateScene(withGenerating, sceneId, (entry) => {
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

      await dependencies.store.updateProject(withFailed);

      if (error instanceof ImageGenerationProviderError) {
        throw new SceneImageGenerationError(error.message, error.status, error.code);
      }

      throw new SceneImageGenerationError('Provider call failed during image generation.', 502, 'generation.provider.failed');
    }

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

    const withGenerated = updateScene(withGenerating, sceneId, (entry) => {
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

    withGenerated.assets.push(generatedAsset);
    await dependencies.store.updateProject(withGenerated);

    return {
      sceneId,
      status: 'generated',
      assetId: generatedAsset.id,
      generationAttemptId: attemptId,
      provider: generated.provider,
      model: generated.model
    };
  } finally {
    activeGenerationLocks.delete(key);
  }
}
