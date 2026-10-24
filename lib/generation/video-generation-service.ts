import path from 'node:path';

import { isRealVideoProviderKey, toGenerationProvider } from '@/lib/ai/video-generation/catalog';
import { createVideoGenerationRegistry } from '@/lib/ai/video-generation/registry';
import { VideoGenerationProviderError, type VideoReferenceInput } from '@/lib/ai/video-generation/provider';
import { resolveVideoGeneration, resolveVideoGenerationProviderForAttempt } from '@/lib/ai/video-generation/resolver';
import { HumanApprovalError, requireHumanApprovalForMode } from '@/lib/explainer/human-approval';
import { assertGenerationTransition } from '@/lib/generation/generation-state';
import { PaidSubmitCapError, assertAndReservePaidSubmit, finalizePaidSubmit } from '@/lib/spend/paid-submit-cap';
import { RunPolicyError } from '@/lib/production/run-policy';
import type { RunMode } from '@/lib/production/run-types';
import { mediaStore } from '@/lib/storage/media-store';
import { projectStore, type ProjectStore } from '@/lib/storage/project-store';
import type { GenerationAttempt, GenerationErrorCode, GenerationRecord, GenerationStatus } from '@/lib/types/generation';
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

function mapProviderError(error: VideoGenerationProviderError): SceneVideoGenerationError {
  return new SceneVideoGenerationError(error.message, error.status, error.code);
}

function resolveAttemptProvider(
  attemptProvider: string | undefined,
  mode: RunMode | undefined,
  dependencies: VideoGenerationServiceDependencies
) {
  try {
    return resolveVideoGenerationProviderForAttempt(attemptProvider, { mode }, { registry: dependencies.registry });
  } catch (error) {
    if (error instanceof RunPolicyError) {
      throw mapRunPolicyError(error);
    }
    if (error instanceof VideoGenerationProviderError) {
      throw mapProviderError(error);
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

// A status poll can only fail in two ways that matter for billing:
//
//  - `terminal`: polling is impossible for a *local* reason AND there is no
//    remote job that could later be recovered through this attempt. Only these
//    codes are allowed to mark the attempt `failed`, which drops the busy-guard
//    in `submitSceneVideoGeneration` and lets the planner schedule a fresh
//    `video_submit`:
//      * INVALID_REQUEST: the persisted provider job id is malformed, so this
//        attempt can never address a remote job again (a corrupt local value
//        that this service's own encoder never produces). Failing it is the
//        only way to unblock the scene.
//
//  - `transient`: every other failure a status poll can raise leaves the
//    *remote* job state either unknown or recoverable, so the attempt must stay
//    active and keep its job id. That includes:
//      * HTTP/transport errors (5xx, 429, 401/403, and 4xx such as 404/405 for a
//        not-yet-registered request or a non-canonical queue path) — the
//        (possibly billed) job may still be running; and
//      * NOT_CONFIGURED — a missing credential never proves the remote job is
//        gone. The existing job id is fully recoverable once the credential is
//        restored, and while the attempt stays active the busy-guard blocks any
//        new submission (so a temporarily-missing credential can never leak into
//        a second paid job).
const TERMINAL_POLL_ERROR_CODES = new Set<GenerationErrorCode>(['INVALID_REQUEST']);

export function classifyStatusPollError(error: unknown): 'transient' | 'terminal' {
  if (error instanceof VideoGenerationProviderError) {
    return TERMINAL_POLL_ERROR_CODES.has(error.code) ? 'terminal' : 'transient';
  }
  // An unexpected error never proves the job died; keep it resumable.
  return 'transient';
}

const TRANSIENT_POLL_MESSAGE =
  'Provider status could not be confirmed; the job may still be running. The same job will be re-polled during recovery (no new submission is started).';

// A submit error is only definitive when the provider clearly did not accept the
// request. Transport timeouts, aborts, 5xx responses and unknown errors leave the
// remote state unknowable: the request may have been accepted (and billed) before
// the response was lost. For real providers those are treated as ambiguous and
// must never unlock a second submission.
const DEFINITIVE_SUBMIT_ERROR_CODES = new Set<GenerationErrorCode>([
  'NOT_CONFIGURED',
  'INVALID_REQUEST',
  'UNSUPPORTED',
  'REFERENCE_ERROR',
  'PROVIDER_AUTH',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_REJECTED',
  'DOWNLOAD_FAILED',
  'MEDIA_INVALID'
]);

export function classifySubmitError(error: unknown, providerKey: string): 'definitive' | 'ambiguous' {
  if (!isRealVideoProviderKey(providerKey)) {
    // Mock/local generation is never billed; preserve the existing immediate
    // failure behaviour so a broken mock scene can be retried.
    return 'definitive';
  }

  if (error instanceof VideoGenerationProviderError) {
    return DEFINITIVE_SUBMIT_ERROR_CODES.has(error.code) ? 'definitive' : 'ambiguous';
  }

  // An unwrapped/unknown failure from a paid provider cannot prove rejection.
  return 'ambiguous';
}

function submitFailureIsAmbiguous(error: unknown, providerKey: string): boolean {
  return classifySubmitError(error, providerKey) === 'ambiguous';
}

export async function submitSceneVideoGeneration(
  projectId: string,
  sceneId: string,
  options: { regenerate?: boolean; provider?: string; model?: string; mode?: RunMode } = {},
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
    // An explicit request model (e.g. the FAL image-to-video endpoint selected in
    // the UI) overrides the persisted value for this attempt; when absent the
    // stored scene model is used as before. Empty/whitespace means "not set".
    const requestedModel = typeof options.model === 'string' ? options.model.trim() : '';
    const model = requestedModel || current.model;

    if (!regenerate && current.status === 'generated' && (scene.visual.assetId || current.assetId)) {
      throw new SceneVideoGenerationError('Scene already has a generated video. Use regenerate=true to generate a new one.', 409, 'generation.scene.alreadyGenerated');
    }

    if (activeStatus(current.status)) {
      throw new SceneVideoGenerationError(
        current.metadata?.submitUnresolved === true
          ? 'A previous provider submit could not be confirmed. Resolve the active attempt before submitting again.'
          : 'Scene video generation already has an active provider job.',
        409,
        'generation.scene.busy'
      );
    }

    if (!current.prompt.trim()) {
      throw new SceneVideoGenerationError('Generation prompt is required.', 400, 'generation.scene.missingPrompt');
    }

    assertGenerationTransition(current.status, 'queued', regenerate);

    const referenceIds = current.referenceIds && current.referenceIds.length > 0 ? current.referenceIds : scene.referenceIds;
    assertFrameReferences(referenceIds, current);
    const references = await resolveReferenceInputs(project, referenceIds, dependencies.media, current);
    const previousAssetId = scene.visual.assetId || current.assetId;
    const attemptId = createId('generation_attempt');

    let resolved: ReturnType<typeof resolveVideoGeneration>;
    try {
      resolved = resolveVideoGeneration(
        {
          requestedProvider: options.provider,
          mode: options.mode,
          model,
          prompt: current.prompt,
          references,
          aspectRatio: current.aspectRatio || project.aspectRatio,
          durationSeconds: Math.max(1, Math.round(current.duration ?? scene.duration)),
          metadata: {
            projectId,
            sceneId,
            attemptId,
            // Durable client-side idempotency identity. Adapters that support
            // provider-side idempotency can forward this; all adapters record it
            // on the attempt so a restart can correlate the original submit.
            idempotencyKey: attemptId
          }
        },
        { registry: dependencies.registry }
      );
    } catch (error) {
      // Central policy/capability validation happens before the attempt is
      // persisted and before any external request is built.
      if (error instanceof RunPolicyError) {
        throw mapRunPolicyError(error);
      }
      if (error instanceof VideoGenerationProviderError) {
        throw mapProviderError(error);
      }
      throw error;
    }

    try {
      requireHumanApprovalForMode(project, resolved.mode);
    } catch (error) {
      if (error instanceof HumanApprovalError) {
        throw new SceneVideoGenerationError(error.message, error.status, `generation.approval.${error.code === 'HUMAN_APPROVAL_STALE' ? 'stale' : 'required'}`);
      }
      throw error;
    }

    let paidSubmit;
    try {
      paidSubmit = await assertAndReservePaidSubmit({
        projectId,
        sceneId,
        modality: 'video',
        provider: resolved.providerKey,
        mode: resolved.mode
      });
    } catch (error) {
      if (error instanceof PaidSubmitCapError) {
        throw new SceneVideoGenerationError(error.message, error.status, error.code);
      }
      throw error;
    }

    // Attempt-scoped diagnostics describe the attempt that is being replaced.
    // Carrying `submitUnresolved` into the next attempt would make a clean
    // resubmit look unresolvable (and suppress recovery), so drop these flags.
    const previousMetadata = { ...(current.metadata ?? {}) };
    delete previousMetadata.submitUnresolved;
    delete previousMetadata.pollUnresolved;
    delete previousMetadata.lastPollErrorCode;
    delete previousMetadata.cancelFailed;

    const queuedAttempt: GenerationAttempt = {
      ...current,
      id: attemptId,
      kind: 'video',
      status: 'queued',
      provider: toGenerationProvider(resolved.providerKey),
      model: resolved.contract.model,
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
      metadata: {
        ...previousMetadata,
        idempotencyKey: attemptId
      },
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
      submission = await resolved.provider.submit(resolved.request);
    } catch (error) {
      await finalizePaidSubmit(paidSubmit, 'failed');
      const providerFailure = sanitizeProviderError(error);

      if (submitFailureIsAmbiguous(error, resolved.providerKey)) {
        // The provider may have accepted (and billed) this submit before the
        // response was lost. Keep the attempt active *without* a job id so the
        // busy guard blocks any duplicate paid submit. Recovery treats it as
        // non-resumable and suppresses automatic retries in real mode.
        const unresolvedAttempt: GenerationAttempt = {
          ...queuedAttempt,
          status: 'queued',
          providerStatus: 'submit_unresolved',
          error: providerFailure.message,
          errorCode: providerFailure.errorCode,
          errorMessage: providerFailure.message,
          metadata: {
            ...(queuedAttempt.metadata ?? {}),
            submitUnresolved: true
          }
        };

        await dependencies.store.mutateProject(projectId, (fresh) =>
          updateScene(fresh, sceneId, (entry) => {
            ensureGeneratedVideoScene(entry);
            return {
              ...entry,
              visual: {
                ...entry.visual,
                generation: unresolvedAttempt,
                assetId: previousAssetId
              }
            };
          })
        );

        throw new SceneVideoGenerationError(
          'The provider submit outcome could not be confirmed. The attempt stays active without a job id so no duplicate paid submission is started; restart recovery reconciles it.',
          503,
          'generation.attempt.submitUnresolved'
        );
      }

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

    await finalizePaidSubmit(paidSubmit, 'completed');

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
      provider: resolved.providerKey,
      model: resolved.contract.model,
      providerJobId: updatedAttempt.providerJobId!,
      providerStatus: updatedAttempt.providerStatus
    };
  } finally {
    activeSceneSubmitLocks.delete(key);
  }
}

export interface SceneVideoGenerationCancellationResult {
  sceneId: string;
  generationAttemptId: string;
  status: 'rejected';
  provider: string;
  model?: string;
  providerJobId?: string;
  providerStatus: string;
}

// Cancels the current active remote video job for a scene through the existing
// provider lifecycle. The remote cancellation is explicit: an unsupported
// provider is rejected (never silently treated as cancelled), and a remote
// cancellation failure is surfaced without failing the attempt (the remote job
// state is unknown, so the attempt is left resumable).
//
// Concurrency: this holds BOTH the per-scene submit lock (so a submit cannot
// interleave) and the per-attempt poll lock (so a status poll cannot interleave
// with the cancel/remote-cancel/write sequence). The project is re-read under
// both locks and the terminal `rejected` write is applied only to the exact
// active attempt that was observed, so a poll that completed a job (or any
// other writer) can never have its result overwritten by a stale cancellation.
export async function cancelSceneVideoGeneration(
  projectId: string,
  sceneId: string,
  options: { mode?: RunMode } = {},
  dependencies: VideoGenerationServiceDependencies = defaultDependencies
): Promise<SceneVideoGenerationCancellationResult> {
  const sceneKey = sceneLockKey(projectId, sceneId);
  if (activeSceneSubmitLocks.has(sceneKey)) {
    throw new SceneVideoGenerationError('Video generation submit is already running for this scene.', 409, 'generation.scene.alreadyRunning');
  }

  activeSceneSubmitLocks.add(sceneKey);
  let attemptKey: string | undefined;

  try {
    const project = await dependencies.store.getProject(projectId);
    if (!project) {
      throw new SceneVideoGenerationError(`Project ${projectId} not found.`, 404, 'generation.project.notFound');
    }

    const scene = getScene(project, sceneId);
    ensureGeneratedVideoScene(scene);

    const observed = scene.visual.generation;
    if (!activeStatus(observed.status)) {
      throw new SceneVideoGenerationError('There is no active video generation to cancel.', 409, 'generation.scene.notActive');
    }
    if (!observed.providerJobId) {
      throw new SceneVideoGenerationError('Active video generation is missing a provider job id.', 409, 'generation.attempt.missingJobId');
    }

    // Serialize against an in-flight status poll for this attempt. Without this
    // the poll could observe `generated` and write it concurrently with the
    // cancellation, and the later write would clobber the other's result.
    attemptKey = attemptLockKey(projectId, observed.id);
    if (activeAttemptPollLocks.has(attemptKey)) {
      throw new SceneVideoGenerationError(
        'A status poll is currently running for this attempt; retry the cancellation once it finishes.',
        409,
        'generation.attempt.pollBusy'
      );
    }
    activeAttemptPollLocks.add(attemptKey);

    // Re-read under both locks so the freshest attempt is used. A poll that
    // finished between the first read and lock acquisition cannot be cancelled
    // or overwritten.
    const fresh = await dependencies.store.getProject(projectId);
    if (!fresh) {
      throw new SceneVideoGenerationError(`Project ${projectId} not found.`, 404, 'generation.project.notFound');
    }
    const freshScene = getScene(fresh, sceneId);
    ensureGeneratedVideoScene(freshScene);
    const current = freshScene.visual.generation;
    if (current.id !== observed.id || !activeStatus(current.status)) {
      throw new SceneVideoGenerationError('Video generation already finished; nothing to cancel.', 409, 'generation.scene.notActive');
    }
    if (!current.providerJobId) {
      throw new SceneVideoGenerationError('Active video generation is missing a provider job id.', 409, 'generation.attempt.missingJobId');
    }

    const resolved = resolveAttemptProvider(current.provider, options.mode, dependencies);
    const provider = resolved.provider;
    const capabilities = provider.getCapabilitiesForModel
      ? provider.getCapabilitiesForModel(current.model)
      : provider.getCapabilities();
    const cancel = provider.cancel;
    if (!capabilities.supportsCancellation || typeof cancel !== 'function') {
      throw new SceneVideoGenerationError(
        `Provider ${provider.providerId} does not support cancellation.`,
        409,
        'generation.provider.cancelUnsupported'
      );
    }

    try {
      await cancel.call(provider, current.providerJobId);
    } catch (error) {
      // The remote cancellation could not be confirmed. Keep the attempt active
      // (and its job id) so the job is never abandoned or re-submitted, but record
      // the failure so it is visible.
      const normalized = sanitizeProviderError(error);
      const cancelFailedAttempt: GenerationAttempt = {
        ...current,
        providerStatus: 'cancel_failed',
        error: `Cancellation request failed: ${normalized.message}`,
        errorMessage: `Cancellation request failed: ${normalized.message}`,
        lastPolledAt: nowIso(),
        metadata: {
          ...(current.metadata ?? {}),
          cancelFailed: true
        }
      };

      await dependencies.store.mutateProject(projectId, (latest) =>
        updateScene(latest, sceneId, (entry) => {
          ensureGeneratedVideoScene(entry);
          const live = entry.visual.generation;
          if (live.id !== current.id || !activeStatus(live.status)) {
            return entry;
          }
          return { ...entry, visual: { ...entry.visual, generation: cancelFailedAttempt } };
        })
      );

      if (error instanceof VideoGenerationProviderError) {
        throw new SceneVideoGenerationError(`Cancellation failed: ${error.message}`, error.status, 'generation.provider.cancelFailed');
      }
      throw new SceneVideoGenerationError('Provider cancellation call failed.', 502, 'generation.provider.cancelFailed');
    }

    const canceledAttempt: GenerationAttempt = {
      ...current,
      status: 'rejected',
      providerStatus: 'canceled',
      error: 'Canceled by user.',
      errorMessage: 'Canceled by user.',
      errorCode: undefined,
      completedAt: nowIso(),
      lastPolledAt: nowIso()
    };

    const persisted = await dependencies.store.mutateProject(projectId, (latest) =>
      updateScene(latest, sceneId, (entry) => {
        ensureGeneratedVideoScene(entry);
        const live = entry.visual.generation;
        // Apply the terminal status only to the exact active attempt observed.
        // If the job reached a terminal state by any other means, leave it as is
        // rather than overwriting a completed generation with `rejected`.
        if (live.id !== current.id || !activeStatus(live.status)) {
          return entry;
        }
        return { ...entry, visual: { ...entry.visual, generation: canceledAttempt } };
      })
    );

    if (!persisted) {
      throw new SceneVideoGenerationError(`Project ${projectId} was removed during cancellation.`, 404, 'generation.project.notFound');
    }

    const persistedScene = getScene(persisted, sceneId);
    ensureGeneratedVideoScene(persistedScene);
    if (persistedScene.visual.generation.status !== 'rejected') {
      throw new SceneVideoGenerationError(
        'Video generation completed before the cancellation could be applied.',
        409,
        'generation.scene.notActive'
      );
    }

    return {
      sceneId,
      generationAttemptId: canceledAttempt.id,
      status: 'rejected',
      provider: provider.providerId,
      model: canceledAttempt.model,
      providerJobId: current.providerJobId,
      providerStatus: 'canceled'
    };
  } finally {
    if (attemptKey) {
      activeAttemptPollLocks.delete(attemptKey);
    }
    activeSceneSubmitLocks.delete(sceneKey);
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
      if (attempt.metadata?.submitUnresolved === true) {
        throw new SceneVideoGenerationError(
          'The provider submit outcome is unconfirmed and there is no job id to poll. Resolve the active attempt before retrying.',
          503,
          'generation.attempt.submitUnresolved'
        );
      }
      throw new SceneVideoGenerationError('Active generation attempt is missing provider job id.', 500, 'generation.attempt.missingJobId');
    }

    const resolved = resolveAttemptProvider(attempt.provider, options.mode, dependencies);
    const provider = resolved.provider;

    let providerStatus;
    try {
      providerStatus = await provider.getStatus(attempt.providerJobId);
    } catch (error) {
      const normalized = sanitizeProviderError(error);

      if (classifyStatusPollError(error) === 'transient') {
        // Transient/unconfirmed: keep the attempt active with its provider job id
        // so recovery re-polls the SAME remote job. The active-status guard in
        // `submitSceneVideoGeneration` blocks a new submission while the job may
        // still be running, so no second paid submission can be started.
        const unresolvedAttempt: GenerationAttempt = {
          ...attempt,
          providerStatus: 'status_unresolved',
          error: TRANSIENT_POLL_MESSAGE,
          errorMessage: TRANSIENT_POLL_MESSAGE,
          errorCode: undefined,
          lastPolledAt: nowIso(),
          metadata: {
            ...(attempt.metadata ?? {}),
            pollUnresolved: true,
            lastPollErrorCode: normalized.errorCode
          }
        };

        const withUnresolved = (fresh: Project) => updateScene(fresh, scene.id, (entry) => {
          ensureGeneratedVideoScene(entry);
          return {
            ...entry,
            visual: {
              ...entry.visual,
              generation: unresolvedAttempt,
              assetId: entry.visual.assetId || attempt.assetId
            }
          };
        });

        await dependencies.store.mutateProject(projectId, withUnresolved);

        throw new SceneVideoGenerationError(TRANSIENT_POLL_MESSAGE, 503, 'generation.attempt.statusUnresolved');
      }

      // Terminal: the persisted job id is malformed, so this attempt can never
      // address a remote job again. It is failed to unblock the scene; the job
      // id is retained for audit. Every other poll failure (HTTP/transport, and
      // NOT_CONFIGURED) takes the transient branch above and keeps the job
      // resumable, so a temporary fault or missing credential can never leak
      // into a second paid submission.
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
          provider: toGenerationProvider(provider.providerId),
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
