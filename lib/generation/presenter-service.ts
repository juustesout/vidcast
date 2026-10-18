import fs from 'node:fs/promises';
import path from 'node:path';

import { isRealPresenterProviderKey } from '@/lib/ai/presenter/catalog';
import {
  PresenterProviderError,
  type PresenterDownloadResult,
  type PresenterJobStatus,
  type PresenterProvider
} from '@/lib/ai/presenter/provider';
import { createPresenterProviderRegistry } from '@/lib/ai/presenter/registry';
import { deriveNarrationFreshness } from '@/lib/generation/narration-freshness';
import {
  evaluatePresenterChargeBudget,
  getPresenterClip,
  getPresenterSetting,
  resolvePresenterPip
} from '@/lib/presenter/config';
import { resolveManualGenerationProvider, RunPolicyError } from '@/lib/production/run-policy';
import type { RunMode } from '@/lib/production/run-types';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import { mediaStore } from '@/lib/storage/media-store';
import { projectStore, type ProjectStore } from '@/lib/storage/project-store';
import type { Asset } from '@/lib/types/asset';
import type { PresenterClipAttempt, PresenterClipSpec, PresenterOutputFormat } from '@/lib/types/presenter';
import type { Project } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';
import { createId } from '@/lib/utils/ids';

const activePresenterLocks = new Set<string>();

function lockKey(projectId: string, sceneId: string): string {
  return `${projectId}:${sceneId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class PresenterGenerationError extends Error {
  readonly status: number;
  readonly code:
    | 'presenter.project.notFound'
    | 'presenter.scene.notFound'
    | 'presenter.disabled'
    | 'presenter.scene.notConfigured'
    | 'presenter.invalid'
    | 'presenter.narration.notCurrent'
    | 'presenter.provider.notConfigured'
    | 'presenter.provider.unsupported'
    | 'presenter.provider.failed'
    | 'presenter.scene.alreadyRunning'
    | 'presenter.scene.alreadyGenerated'
    | 'presenter.scene.submissionUnknown'
    | 'presenter.budget.exceeded';
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code:
      | 'presenter.project.notFound'
      | 'presenter.scene.notFound'
      | 'presenter.disabled'
      | 'presenter.scene.notConfigured'
      | 'presenter.invalid'
      | 'presenter.narration.notCurrent'
      | 'presenter.provider.notConfigured'
      | 'presenter.provider.unsupported'
      | 'presenter.provider.failed'
      | 'presenter.scene.alreadyRunning'
      | 'presenter.scene.alreadyGenerated'
      | 'presenter.scene.submissionUnknown'
      | 'presenter.budget.exceeded',
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PresenterGenerationError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface PresenterGenerationResult {
  sceneId: string;
  status: 'accepted' | 'generating' | 'generated';
  provider: string;
  providerJobId?: string;
  providerStatus?: string;
  assetId?: string;
  generationAttemptId?: string;
  duration?: number;
}

interface PresenterServiceDependencies {
  store: Pick<ProjectStore, 'getProject' | 'mutateProject'>;
  media: Pick<typeof mediaStore, 'saveGeneratedPresenter'>;
  registry: ReturnType<typeof createPresenterProviderRegistry>;
}

const defaultDependencies: PresenterServiceDependencies = {
  store: projectStore,
  media: mediaStore,
  registry: createPresenterProviderRegistry()
};

function getScene(project: Project, sceneId: string): Scene {
  const scene = project.scenes.find((entry) => entry.id === sceneId);
  if (!scene) {
    throw new PresenterGenerationError(`Scene ${sceneId} not found.`, 404, 'presenter.scene.notFound');
  }
  return scene;
}

function updateClip(project: Project, sceneId: string, updater: (clip: PresenterClipSpec) => PresenterClipSpec): Project {
  const clips = project.presenterClips ?? [];
  const exists = clips.some((clip) => clip.sceneId === sceneId);
  return {
    ...project,
    presenterClips: exists
      ? clips.map((clip) => (clip.sceneId === sceneId ? updater(clip) : clip))
      : [...clips, updater({
          sceneId,
          status: 'planned',
          provider: 'mock',
          outputFormat: 'mp4',
          audioAssetId: '',
          narrationSignature: '',
          duration: 0
        })]
  };
}

function mapProviderError(error: PresenterProviderError): PresenterGenerationError {
  if (error.code === 'NOT_CONFIGURED') {
    return new PresenterGenerationError(error.message, 409, 'presenter.provider.notConfigured');
  }
  if (error.code === 'UNSUPPORTED' || error.code === 'INVALID_REQUEST') {
    return new PresenterGenerationError(error.message, 422, 'presenter.provider.unsupported');
  }
  return new PresenterGenerationError(error.message, 502, 'presenter.provider.failed');
}

function mapRunPolicyError(error: RunPolicyError): PresenterGenerationError {
  if (error.code === 'PROVIDER_NOT_CONFIGURED') {
    return new PresenterGenerationError(error.message, error.status, 'presenter.provider.notConfigured');
  }
  if (error.code === 'INVALID_POLICY') {
    return new PresenterGenerationError(error.message, error.status, 'presenter.invalid');
  }
  return new PresenterGenerationError(error.message, error.status, 'presenter.provider.unsupported');
}

function resolvePresenterProvider(project: Project, requestedProvider: string | undefined, mode: RunMode | undefined) {
  // A project-level explicit provider is an authoring intent. The server run
  // policy is still the authority for mock vs. real.
  const configured = project.presenter?.provider;
  const requested = requestedProvider ?? (configured === 'heygen' ? 'heygen' : undefined);
  try {
    return resolveManualGenerationProvider('presenter', requested, { mode });
  } catch (error) {
    if (error instanceof RunPolicyError) {
      throw mapRunPolicyError(error);
    }
    throw error;
  }
}

function resolveAudioAsset(project: Project, scene: Scene): Asset {
  const assetId = scene.narration?.audioAssetId;
  if (!assetId) {
    throw new PresenterGenerationError('Presenter generation requires generated narration audio for the scene.', 409, 'presenter.narration.notCurrent');
  }
  const asset = project.assets.find((entry) => entry.id === assetId);
  const usable = asset && asset.status === 'available' && asset.localPath &&
    (asset.type === 'audio' || asset.type === 'music' || asset.type === 'voice');
  if (!usable || !asset?.localPath) {
    throw new PresenterGenerationError('Presenter narration audio asset is missing or invalid.', 409, 'presenter.narration.notCurrent');
  }
  return asset;
}

async function readAssetBytes(projectId: string, asset: Asset): Promise<Buffer> {
  if (!asset.localPath) {
    throw new PresenterGenerationError('Presenter narration audio has no local file.', 409, 'presenter.narration.notCurrent');
  }
  const projectRoot = path.resolve(getProjectRoot(projectId));
  const absolute = path.resolve(projectRoot, asset.localPath.replace(/\\/g, '/').replace(/^\/+/, ''));
  if (!absolute.startsWith(projectRoot)) {
    throw new PresenterGenerationError('Presenter narration audio path is unsafe.', 422, 'presenter.invalid');
  }
  try {
    return await fs.readFile(absolute);
  } catch {
    throw new PresenterGenerationError('Presenter narration audio file is missing on disk.', 409, 'presenter.narration.notCurrent');
  }
}

function resolveSceneDuration(project: Project, scene: Scene): number {
  const plan = resolveRenderPlan(project);
  return plan.scenes.find((entry) => entry.sceneId === scene.id)?.duration ?? scene.duration;
}

function resolveOutputFormat(project: Project): PresenterOutputFormat {
  return project.presenter?.outputFormat === 'webm' ? 'webm' : 'mp4';
}

function resolveAvatarId(project: Project, provider: PresenterProvider, override?: string): string {
  if (override?.trim()) {
    return override.trim();
  }
  const configured = project.presenter?.avatarId?.trim();
  if (configured) {
    return configured;
  }
  if (provider.providerId === 'heygen') {
    const envAvatar = process.env.HEYGEN_AVATAR_ID?.trim();
    if (envAvatar) {
      return envAvatar;
    }
    throw new PresenterGenerationError('Presenter generation requires an avatar id.', 400, 'presenter.invalid');
  }
  return 'mock-avatar';
}

function upsertAttempt(attempts: PresenterClipAttempt[] | undefined, attempt: PresenterClipAttempt): PresenterClipAttempt[] {
  const list = attempts ?? [];
  const exists = list.some((entry) => entry.id === attempt.id);
  return exists
    ? list.map((entry) => (entry.id === attempt.id ? attempt : entry))
    : [...list, attempt];
}

export async function submitPresenterClip(
  projectId: string,
  sceneId: string,
  options: { provider?: string; mode?: RunMode; regenerate?: boolean; avatarId?: string } = {},
  dependencies: PresenterServiceDependencies = defaultDependencies
): Promise<PresenterGenerationResult> {
  const key = lockKey(projectId, sceneId);
  if (activePresenterLocks.has(key)) {
    throw new PresenterGenerationError('Presenter generation is already running for this scene.', 409, 'presenter.scene.alreadyRunning');
  }
  activePresenterLocks.add(key);

  try {
    const project = await dependencies.store.getProject(projectId);
    if (!project) {
      throw new PresenterGenerationError(`Project ${projectId} not found.`, 404, 'presenter.project.notFound');
    }

    const scene = getScene(project, sceneId);
    const setting = getPresenterSetting(project, sceneId);
    if (!project.presenter?.enabled || !setting) {
      throw new PresenterGenerationError('Presenter is not enabled for this scene.', 409, 'presenter.scene.notConfigured');
    }

    const freshness = deriveNarrationFreshness(project, scene);
    if (freshness.state !== 'current') {
      throw new PresenterGenerationError(freshness.reason || 'Presenter requires current narration audio.', 409, 'presenter.narration.notCurrent');
    }

    const existingClip = getPresenterClip(project, sceneId);
    if (!options.regenerate && existingClip?.status === 'generated' && existingClip.assetId) {
      throw new PresenterGenerationError('Presenter clip already exists for this scene. Use regenerate=true to create a new clip.', 409, 'presenter.scene.alreadyGenerated');
    }
    if (existingClip?.status === 'submitting' || existingClip?.status === 'generating') {
      throw new PresenterGenerationError('Presenter clip generation is already in progress for this scene.', 409, 'presenter.scene.alreadyRunning');
    }

    const { provider: providerId } = resolvePresenterProvider(project, options.provider, options.mode);
    let provider: PresenterProvider;
    try {
      provider = dependencies.registry.getProvider(providerId);
    } catch {
      throw new PresenterGenerationError(`Unknown presenter provider: ${providerId}`, 422, 'presenter.provider.unsupported');
    }

    const audioAsset = resolveAudioAsset(project, scene);
    const duration = resolveSceneDuration(project, scene);
    const outputFormat = resolveOutputFormat(project);

    if (isRealPresenterProviderKey(provider.providerId)) {
      const charge = evaluatePresenterChargeBudget(project, { seconds: duration, requests: 1 });
      if (!charge.allowed) {
        throw new PresenterGenerationError(
          `Presenter budget exceeded. ${charge.reasons.join(' ')}`,
          403,
          'presenter.budget.exceeded',
          { ...charge }
        );
      }
    }

    const avatarId = resolveAvatarId(project, provider, options.avatarId);
    const attemptId = createId('presenter_attempt');
    const attempt: PresenterClipAttempt = {
      id: attemptId,
      status: 'submitting',
      provider: provider.providerId,
      avatarId,
      outputFormat,
      audioAssetId: audioAsset.id,
      narrationSignature: freshness.narrationSignature,
      duration,
      createdAt: nowIso()
    };

    await dependencies.store.mutateProject(projectId, (fresh) => updateClip(fresh, sceneId, () => ({
      sceneId,
      status: 'submitting',
      provider: provider.providerId,
      avatarId,
      outputFormat,
      audioAssetId: audioAsset.id,
      narrationSignature: freshness.narrationSignature,
      duration,
      lastAttemptId: attemptId,
      error: undefined,
      attempts: upsertAttempt(fresh.presenterClips?.find((clip) => clip.sceneId === sceneId)?.attempts, attempt)
    })));

    const audioBytes = await readAssetBytes(projectId, audioAsset);

    let submitted;
    try {
      submitted = await provider.submit({
        avatarId,
        audio: {
          data: audioBytes,
          mimeType: audioAsset.mimeType || 'audio/mpeg',
          duration,
          filename: path.basename(audioAsset.localPath ?? 'narration.mp3')
        },
        outputFormat,
        aspectRatio: project.aspectRatio,
        width: project.renderSettings.width,
        height: project.renderSettings.height,
        title: `Presenter ${project.title} scene ${scene.order}`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Presenter provider call failed.';
      const failedAttempt: PresenterClipAttempt = {
        ...attempt,
        status: 'failed',
        completedAt: nowIso(),
        error: message
      };
      await dependencies.store.mutateProject(projectId, (fresh) => updateClip(fresh, sceneId, (clip) => ({
        ...clip,
        status: 'failed',
        error: message,
        attempts: upsertAttempt(clip.attempts, failedAttempt)
      })));

      if (error instanceof PresenterProviderError) {
        throw mapProviderError(error);
      }
      throw new PresenterGenerationError('Presenter provider call failed.', 502, 'presenter.provider.failed');
    }

    const generatingAttempt: PresenterClipAttempt = {
      ...attempt,
      status: 'generating',
      providerJobId: submitted.providerJobId,
      providerStatus: submitted.providerStatus
    };

    await dependencies.store.mutateProject(projectId, (fresh) => updateClip(fresh, sceneId, (clip) => ({
      ...clip,
      status: 'generating',
      assetId: options.regenerate ? undefined : clip.assetId,
      error: undefined,
      attempts: upsertAttempt(clip.attempts, generatingAttempt)
    })));

    return {
      sceneId,
      status: 'accepted',
      provider: provider.providerId,
      providerJobId: submitted.providerJobId,
      providerStatus: submitted.providerStatus,
      generationAttemptId: attemptId,
      duration
    };
  } finally {
    activePresenterLocks.delete(key);
  }
}

export async function pollPresenterClip(
  projectId: string,
  sceneId: string,
  options: { mode?: RunMode } = {},
  dependencies: PresenterServiceDependencies = defaultDependencies
): Promise<PresenterGenerationResult> {
  const key = lockKey(projectId, sceneId);
  if (activePresenterLocks.has(key)) {
    throw new PresenterGenerationError('Presenter generation is already running for this scene.', 409, 'presenter.scene.alreadyRunning');
  }
  activePresenterLocks.add(key);

  try {
    const project = await dependencies.store.getProject(projectId);
    if (!project) {
      throw new PresenterGenerationError(`Project ${projectId} not found.`, 404, 'presenter.project.notFound');
    }

    const scene = getScene(project, sceneId);
    const clip = getPresenterClip(project, sceneId);
    if (!clip) {
      throw new PresenterGenerationError('No presenter clip exists for this scene.', 409, 'presenter.invalid');
    }
    if (clip.status === 'generated' && clip.assetId) {
      return {
        sceneId,
        status: 'generated',
        provider: clip.provider,
        assetId: clip.assetId,
        duration: clip.duration
      };
    }
    if (clip.status === 'submitting') {
      throw new PresenterGenerationError(
        'Presenter submission was interrupted before a provider job id was stored. Verify the provider dashboard before retrying; automatic retry is disabled.',
        409,
        'presenter.scene.submissionUnknown'
      );
    }

    const attempt = clip.attempts?.find((entry) => entry.id === clip.lastAttemptId);
    if (!attempt?.providerJobId) {
      throw new PresenterGenerationError('Presenter clip has no provider job id to poll.', 409, 'presenter.invalid');
    }
    if (options.mode === 'mock' && isRealPresenterProviderKey(attempt.provider)) {
      throw new PresenterGenerationError('Mock mode cannot poll a real presenter job.', 403, 'presenter.provider.unsupported');
    }

    let provider: PresenterProvider;
    try {
      provider = dependencies.registry.getProvider(attempt.provider);
    } catch {
      throw new PresenterGenerationError(`Unknown presenter provider: ${attempt.provider}`, 422, 'presenter.provider.unsupported');
    }

    let providerStatus: PresenterJobStatus;
    try {
      providerStatus = await provider.getStatus(attempt.providerJobId);
    } catch (error) {
      if (error instanceof PresenterProviderError) {
        throw mapProviderError(error);
      }
      throw new PresenterGenerationError('Presenter provider status call failed.', 502, 'presenter.provider.failed');
    }

    if (providerStatus.status === 'failed') {
      const message = providerStatus.error || 'Presenter generation failed.';
      const failedAttempt: PresenterClipAttempt = {
        ...attempt,
        status: 'failed',
        providerStatus: providerStatus.providerStatus,
        completedAt: nowIso(),
        error: message
      };
      await dependencies.store.mutateProject(projectId, (fresh) => updateClip(fresh, sceneId, (current) => ({
        ...current,
        status: 'failed',
        error: message,
        attempts: upsertAttempt(current.attempts, failedAttempt)
      })));
      throw new PresenterGenerationError(message, 502, 'presenter.provider.failed');
    }

    if (providerStatus.status !== 'generated') {
      const pendingAttempt: PresenterClipAttempt = {
        ...attempt,
        providerStatus: providerStatus.providerStatus
      };
      await dependencies.store.mutateProject(projectId, (fresh) => updateClip(fresh, sceneId, (current) => ({
        ...current,
        status: 'generating',
        attempts: upsertAttempt(current.attempts, pendingAttempt)
      })));
      return {
        sceneId,
        status: 'generating',
        provider: provider.providerId,
        providerJobId: attempt.providerJobId,
        providerStatus: providerStatus.providerStatus
      };
    }

    let downloaded: PresenterDownloadResult;
    try {
      downloaded = await provider.download(providerStatus);
    } catch (error) {
      if (error instanceof PresenterProviderError) {
        throw mapProviderError(error);
      }
      throw new PresenterGenerationError('Presenter provider download failed.', 502, 'presenter.provider.failed');
    }

    const asset = await dependencies.media.saveGeneratedPresenter({
      projectId,
      sceneOrder: scene.order,
      attemptId: attempt.id,
      mimeType: downloaded.mimeType,
      data: downloaded.data,
      layout: getPresenterSetting(project, sceneId)?.layout,
      generation: {
        generationId: attempt.id,
        provider: provider.providerId,
        prompt: scene.narration?.text ?? '',
        referenceIds: [],
        providerJobId: attempt.providerJobId
      }
    });

    const completedAttempt: PresenterClipAttempt = {
      ...attempt,
      status: 'generated',
      providerStatus: providerStatus.providerStatus,
      videoAssetId: asset.id,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      duration: downloaded.durationSeconds ?? asset.duration ?? attempt.duration,
      completedAt: nowIso()
    };

    await dependencies.store.mutateProject(projectId, (fresh) => {
      const withClip = updateClip(fresh, sceneId, (current) => ({
        ...current,
        status: 'generated',
        assetId: asset.id,
        duration: completedAttempt.duration,
        error: undefined,
        attempts: upsertAttempt(current.attempts, completedAttempt)
      }));
      return { ...withClip, assets: [...withClip.assets, asset] };
    });

    return {
      sceneId,
      status: 'generated',
      provider: provider.providerId,
      providerJobId: attempt.providerJobId,
      providerStatus: providerStatus.providerStatus,
      assetId: asset.id,
      generationAttemptId: attempt.id,
      duration: completedAttempt.duration
    };
  } finally {
    activePresenterLocks.delete(key);
  }
}

export function resolvePresenterPlacementPip(project: Project, sceneId: string) {
  const setting = getPresenterSetting(project, sceneId);
  return setting ? resolvePresenterPip(setting) : undefined;
}
