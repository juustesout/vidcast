import type { Project } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';
import {
  isRealVideoProviderKey,
  normalizeVideoProviderKey,
  videoProviderCredentialEnvVar
} from '@/lib/ai/video-generation/catalog';
import {
  isRealPresenterProviderKey,
  presenterProviderCredentialEnvVar
} from '@/lib/ai/presenter/catalog';
import { evaluatePresenterBudget, normalizePresenterProviderKey, type PresenterBudgetReport } from '@/lib/presenter/config';
import type { ProductionActionType, ProductionPlannedAction } from './production-planner';
import { deriveProductionPlan } from './production-planner';
import type {
  ImageRunProvider,
  MusicRunProvider,
  NarrationRunProvider,
  PresenterRunProvider,
  RunMode,
  RunMusicPlan,
  RunMusicRequest,
  RunPolicySnapshot,
  RunProviderSelection,
  VideoRunProvider
} from './run-types';

export interface RunPolicyRequest {
  mode?: RunMode;
  providers?: Partial<RunProviderSelection>;
  // Force a one-time regeneration of outputs the planner would otherwise treat
  // as current (for example mock assets carried into a real run).
  force?: boolean;
  // Explicit opt-in for pre-compose background music. Absent keeps runs
  // unchanged and guarantees no music provider is ever called.
  music?: RunMusicRequest;
}

export interface RunPolicyServerConfig {
  allowRealProviders: boolean;
  defaultMode: RunMode;
}

export interface RunPolicyPreflightResult {
  requiredActionTypes: ProductionActionType[];
  // Presenter spend projection for real runs. Never contains credentials.
  presenterBudget?: PresenterBudgetReport;
}

export class RunPolicyError extends Error {
  readonly code:
    | 'POLICY_DENIED'
    | 'INVALID_POLICY'
    | 'PROVIDER_NOT_ALLOWED'
    | 'PROVIDER_NOT_CONFIGURED';
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code:
      | 'POLICY_DENIED'
      | 'INVALID_POLICY'
      | 'PROVIDER_NOT_ALLOWED'
      | 'PROVIDER_NOT_CONFIGURED',
    status: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'RunPolicyError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

function envMode(value: string | undefined, fallback: RunMode): RunMode {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === 'real' ? 'real' : normalized === 'mock' ? 'mock' : fallback;
}

export function resolveRunPolicyServerConfig(): RunPolicyServerConfig {
  const allowRealProviders = envBool(process.env.PRODUCTION_RUN_ALLOW_REAL_PROVIDERS, false);
  const requestedDefaultMode = envMode(process.env.PRODUCTION_RUN_DEFAULT_MODE, 'mock');
  const defaultMode = allowRealProviders ? requestedDefaultMode : 'mock';

  return {
    allowRealProviders,
    defaultMode
  };
}

export function resolveProviderDefaults(mode: RunMode): RunProviderSelection {
  if (mode === 'real') {
    return {
      image: 'openai',
      video: 'openai',
      narration: 'elevenlabs',
      music: 'elevenlabs',
      presenter: 'heygen'
    };
  }

  return {
    image: 'fake',
    video: 'local',
    narration: 'fake',
    music: 'fake',
    presenter: 'mock'
  };
}

function parseImageProvider(value: string | undefined): ImageRunProvider | undefined {
  if (!value) {
    return undefined;
  }
  if (value === 'fake' || value === 'openai') {
    return value;
  }
  return undefined;
}

function parseVideoProvider(value: string | undefined): VideoRunProvider | undefined {
  return normalizeVideoProviderKey(value);
}

function parseNarrationProvider(value: string | undefined): NarrationRunProvider | undefined {
  if (!value) {
    return undefined;
  }
  if (value === 'fake' || value === 'elevenlabs') {
    return value;
  }
  return undefined;
}

function parseMusicProvider(value: string | undefined): MusicRunProvider | undefined {
  if (!value) {
    return undefined;
  }
  if (value === 'fake' || value === 'elevenlabs') {
    return value;
  }
  return undefined;
}

function parsePresenterProvider(value: string | undefined): PresenterRunProvider | undefined {
  return normalizePresenterProviderKey(value);
}

function isRealProvider(provider: string): boolean {
  return provider === 'elevenlabs' || isRealVideoProviderKey(provider) || isRealPresenterProviderKey(provider);
}

// Validates and normalizes the explicit run music opt-in. A malformed opt-in is
// rejected up front (it is an author intent, not an optional runtime failure);
// runtime provider errors during the actual music step stay fail-soft.
function normalizeRunMusicRequest(request: RunMusicRequest | undefined): RunMusicPlan | undefined {
  if (!request) {
    return undefined;
  }

  const selectAssetId = typeof request.selectAssetId === 'string' ? request.selectAssetId.trim() : '';
  const generate = request.generate === true;
  const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';

  if (!generate && !selectAssetId) {
    throw new RunPolicyError(
      'Run music opt-in requires either generate=true with a prompt or selectAssetId.',
      'INVALID_POLICY',
      400,
      { field: 'music' }
    );
  }

  if (generate && selectAssetId) {
    throw new RunPolicyError(
      'Run music opt-in cannot both generate a track and select an asset.',
      'INVALID_POLICY',
      400,
      { field: 'music' }
    );
  }

  if (generate && !prompt) {
    throw new RunPolicyError(
      'Run music generation requires a non-empty prompt.',
      'INVALID_POLICY',
      400,
      { field: 'music.prompt' }
    );
  }

  if (
    typeof request.musicLengthMs === 'number' &&
    (!Number.isFinite(request.musicLengthMs) || request.musicLengthMs <= 0)
  ) {
    throw new RunPolicyError(
      'Run music length must be a positive number of milliseconds.',
      'INVALID_POLICY',
      400,
      { field: 'music.musicLengthMs' }
    );
  }

  return {
    generate,
    selectAssetId: selectAssetId || undefined,
    prompt: generate ? prompt : undefined,
    instrumental: typeof request.instrumental === 'boolean' ? request.instrumental : undefined,
    musicLengthMs: typeof request.musicLengthMs === 'number' ? request.musicLengthMs : undefined,
    regenerate: generate && request.regenerate === true ? true : undefined,
    model: typeof request.model === 'string' && request.model.trim() ? request.model.trim() : undefined,
    seed: typeof request.seed === 'number' && Number.isFinite(request.seed) ? request.seed : undefined,
    outputFormat:
      typeof request.outputFormat === 'string' && request.outputFormat.trim()
        ? request.outputFormat.trim()
        : undefined
  };
}

export function resolveRunPolicy(request: RunPolicyRequest | undefined, serverConfig: RunPolicyServerConfig): RunPolicySnapshot {
  const requestedMode = request?.mode ?? serverConfig.defaultMode;
  if (requestedMode === 'real' && !serverConfig.allowRealProviders) {
    throw new RunPolicyError(
      'Real provider mode is disabled on this server.',
      'POLICY_DENIED',
      403,
      { allowRealProviders: false }
    );
  }

  const defaults = resolveProviderDefaults(requestedMode);

  const imageProvider = parseImageProvider(request?.providers?.image);
  const videoProvider = parseVideoProvider(request?.providers?.video);
  const narrationProvider = parseNarrationProvider(request?.providers?.narration);
  const musicProvider = parseMusicProvider(request?.providers?.music);
  const presenterProvider = parsePresenterProvider(request?.providers?.presenter);

  if (request?.providers?.image && !imageProvider) {
    throw new RunPolicyError('Unsupported image provider in policy request.', 'INVALID_POLICY', 400, {
      provider: request.providers.image,
      field: 'providers.image'
    });
  }

  if (request?.providers?.video && !videoProvider) {
    throw new RunPolicyError('Unsupported video provider in policy request.', 'INVALID_POLICY', 400, {
      provider: request.providers.video,
      field: 'providers.video'
    });
  }

  if (request?.providers?.narration && !narrationProvider) {
    throw new RunPolicyError('Unsupported narration provider in policy request.', 'INVALID_POLICY', 400, {
      provider: request.providers.narration,
      field: 'providers.narration'
    });
  }

  if (request?.providers?.music && !musicProvider) {
    throw new RunPolicyError('Unsupported music provider in policy request.', 'INVALID_POLICY', 400, {
      provider: request.providers.music,
      field: 'providers.music'
    });
  }

  if (request?.providers?.presenter && !presenterProvider) {
    throw new RunPolicyError('Unsupported presenter provider in policy request.', 'INVALID_POLICY', 400, {
      provider: request.providers.presenter,
      field: 'providers.presenter'
    });
  }

  const providers: RunProviderSelection = {
    image: imageProvider ?? defaults.image,
    video: videoProvider ?? defaults.video,
    narration: narrationProvider ?? defaults.narration,
    music: musicProvider ?? defaults.music,
    presenter: presenterProvider ?? defaults.presenter
  };

  const music = normalizeRunMusicRequest(request?.music);

  // Provider-vs-mode enforcement for run modalities is intentionally deferred to
  // `assertRunPolicyPreflight`, which knows the project and therefore which
  // modalities the run actually needs. A provider for an unused modality (for
  // example `video` on an image-only project) must not force a dummy choice.
  // `resolveManualGenerationProvider` enforces its single modality separately.

  return {
    mode: requestedMode,
    allowRealProviders: serverConfig.allowRealProviders,
    providers,
    force: request?.force === true,
    music
  };
}

function isPotentiallyExecutable(action: ProductionPlannedAction): boolean {
  return action.status === 'ready' || action.status === 'waiting_dependency' || action.status === 'running';
}

function resolveVideoPollProviderFromScene(scene: Scene): string | null {
  if (!scene.visual || scene.visual.kind !== 'generated_video') {
    return null;
  }

  // Provider identity is opaque here. The central video resolver validates it;
  // this function only extracts the persisted attempt's locked provider so the
  // run cannot switch providers mid-job.
  const value = scene.visual.generation.provider?.trim();
  if (!value || value === 'other') {
    return null;
  }
  return value;
}

function requireEnvVar(name: string, message: string): void {
  if (!process.env[name]) {
    throw new RunPolicyError(message, 'PROVIDER_NOT_CONFIGURED', 409, { envVar: name });
  }
}

export function assertRunPolicyPreflight(project: Project, policy: RunPolicySnapshot): RunPolicyPreflightResult {
  // Force-aware: a forced run will regenerate current outputs, so those
  // modalities must be validated up front instead of appearing unnecessary.
  const plan = deriveProductionPlan(project, { force: policy.force === true, mode: policy.mode });
  const actionable = plan.actions.filter(isPotentiallyExecutable);
  const requiredActionTypes = Array.from(new Set(actionable.map((action) => action.type)));

  const needsImageGeneration = requiredActionTypes.includes('image_generate');
  const needsVideoGeneration = requiredActionTypes.includes('video_submit') || requiredActionTypes.includes('video_poll');
  const needsNarrationGeneration = requiredActionTypes.includes('narration_generate');
  const needsPresenterGeneration = requiredActionTypes.includes('presenter_submit') || requiredActionTypes.includes('presenter_poll');

  // Real/mock enforcement applies only to modalities the run actually executes.
  // Music is never a hard-required run modality: it is an optional, fail-soft
  // pre-compose step (see the run music opt-in), so `providers.music` is not
  // enforced here. When opted in, the step resolves the provider through
  // `resolveManualGenerationProvider`, which preserves the mock/real and
  // credential guarantees before any request is built.
  if (policy.mode === 'real') {
    if (needsImageGeneration && !isRealProvider(policy.providers.image)) {
      throw new RunPolicyError('Real mode requires a real image provider for image generation.', 'PROVIDER_NOT_ALLOWED', 403, {
        modality: 'image',
        provider: policy.providers.image
      });
    }

    if (needsVideoGeneration && !isRealProvider(policy.providers.video)) {
      throw new RunPolicyError('Real mode requires a real video provider for video generation.', 'PROVIDER_NOT_ALLOWED', 403, {
        modality: 'video',
        provider: policy.providers.video
      });
    }

    if (needsPresenterGeneration && !isRealProvider(policy.providers.presenter ?? '')) {
      throw new RunPolicyError('Real mode requires the HeyGen presenter provider.', 'PROVIDER_NOT_ALLOWED', 403, {
        modality: 'presenter',
        provider: policy.providers.presenter
      });
    }

    if (needsNarrationGeneration && !isRealProvider(policy.providers.narration)) {
      throw new RunPolicyError('Real mode requires a real narration provider for narration generation.', 'PROVIDER_NOT_ALLOWED', 403, {
        modality: 'narration',
        provider: policy.providers.narration
      });
    }

    if (needsImageGeneration && policy.providers.image === 'openai') {
      requireEnvVar('OPENAI_API_KEY', 'Real visual generation requires OPENAI_API_KEY.');
    }

    if (needsVideoGeneration) {
      const envVar = videoProviderCredentialEnvVar(policy.providers.video);
      if (envVar) {
        requireEnvVar(envVar, `Real ${policy.providers.video} video generation requires ${envVar}.`);
      }
    }

    if (needsNarrationGeneration && policy.providers.narration === 'elevenlabs') {
      requireEnvVar('ELEVENLABS_API_KEY', 'Real narration generation requires ELEVENLABS_API_KEY.');
    }

    if (needsPresenterGeneration) {
      const envVar = presenterProviderCredentialEnvVar(policy.providers.presenter);
      if (envVar) {
        requireEnvVar(envVar, `Real presenter generation requires ${envVar}.`);
      }
    }
  }

  if (policy.mode === 'mock') {
    if (needsImageGeneration && policy.providers.image !== 'fake') {
      throw new RunPolicyError('Mock mode only allows the fake image provider for image generation.', 'PROVIDER_NOT_ALLOWED', 403, {
        modality: 'image',
        provider: policy.providers.image
      });
    }

    if (needsVideoGeneration && policy.providers.video !== 'local') {
      throw new RunPolicyError('Mock mode only allows the local video provider for video generation.', 'PROVIDER_NOT_ALLOWED', 403, {
        modality: 'video',
        provider: policy.providers.video
      });
    }

    if (needsNarrationGeneration && policy.providers.narration !== 'fake') {
      throw new RunPolicyError('Mock mode only allows the fake narration provider for narration generation.', 'PROVIDER_NOT_ALLOWED', 403, {
        modality: 'narration',
        provider: policy.providers.narration
      });
    }

    if (needsPresenterGeneration && policy.providers.presenter !== 'mock') {
      throw new RunPolicyError('Mock mode only allows the mock presenter provider.', 'PROVIDER_NOT_ALLOWED', 403, {
        modality: 'presenter',
        provider: policy.providers.presenter
      });
    }
  }

  for (const action of actionable) {
    if (action.type !== 'video_poll' || !action.sceneId) {
      continue;
    }

    const scene = project.scenes.find((entry) => entry.id === action.sceneId);
    if (!scene) {
      throw new RunPolicyError('Video poll action references an unknown scene.', 'INVALID_POLICY', 400, {
        sceneId: action.sceneId,
        actionId: action.id
      });
    }

    const attemptProvider = resolveVideoPollProviderFromScene(scene);
    if (!attemptProvider) {
      throw new RunPolicyError(
        'Video poll provider could not be resolved from the active attempt. Start a new submit with an explicit provider first.',
        'INVALID_POLICY',
        400,
        { sceneId: action.sceneId, actionId: action.id }
      );
    }

    if (attemptProvider !== policy.providers.video) {
      throw new RunPolicyError(
        'Active video poll provider does not match locked run provider policy.',
        'PROVIDER_NOT_ALLOWED',
        409,
        {
          sceneId: action.sceneId,
          expectedProvider: policy.providers.video,
          actualProvider: attemptProvider
        }
      );
    }

    if (policy.mode === 'mock' && attemptProvider === 'openai') {
      throw new RunPolicyError(
        'Mock mode cannot poll an active real-provider video job.',
        'PROVIDER_NOT_ALLOWED',
        409,
        { sceneId: action.sceneId, provider: attemptProvider }
      );
    }
  }

  return {
    requiredActionTypes,
    presenterBudget: needsPresenterGeneration && policy.mode === 'real'
      ? evaluatePresenterBudget(project)
      : undefined
  };
}

export type GenerationModality = 'image' | 'video' | 'narration' | 'music' | 'presenter';

export interface GenerationProviderResolution {
  mode: RunMode;
  provider: string;
}

function normalizeRequestedProvider(
  kind: GenerationModality,
  requested: string | undefined
): ImageRunProvider | VideoRunProvider | NarrationRunProvider | MusicRunProvider | PresenterRunProvider | undefined {
  if (!requested) {
    return undefined;
  }

  const value = requested.trim().toLowerCase();
  if (!value) {
    return undefined;
  }

  if (kind === 'presenter') {
    const presenterProvider = normalizePresenterProviderKey(value);
    if (presenterProvider) {
      return presenterProvider;
    }
  } else if (kind === 'image') {
    if (value === 'openai') {
      return 'openai';
    }
    if (value === 'fake' || value === 'local') {
      return 'fake';
    }
  } else if (kind === 'video') {
    const videoProvider = normalizeVideoProviderKey(value);
    if (videoProvider) {
      return videoProvider;
    }
  } else if (kind === 'music') {
    if (value === 'elevenlabs') {
      return 'elevenlabs';
    }
    if (value === 'fake' || value === 'local') {
      return 'fake';
    }
  } else {
    if (value === 'elevenlabs') {
      return 'elevenlabs';
    }
    if (value === 'fake' || value === 'local') {
      return 'fake';
    }
  }

  throw new RunPolicyError(`Unsupported ${kind} generation provider.`, 'INVALID_POLICY', 400, {
    provider: requested,
    field: `providers.${kind}`
  });
}

function assertRealProviderCredentials(kind: GenerationModality, provider: string): void {
  if ((kind === 'narration' || kind === 'music') && provider === 'elevenlabs') {
    requireEnvVar('ELEVENLABS_API_KEY', `Real ${kind} generation requires ELEVENLABS_API_KEY.`);
  }

  if (kind === 'image' && provider === 'openai') {
    requireEnvVar('OPENAI_API_KEY', 'Real visual generation requires OPENAI_API_KEY.');
  }

  if (kind === 'video') {
    const envVar = videoProviderCredentialEnvVar(provider);
    if (envVar) {
      requireEnvVar(envVar, `Real video generation requires ${envVar}.`);
    }
  }

  if (kind === 'presenter') {
    const envVar = presenterProviderCredentialEnvVar(provider);
    if (envVar) {
      requireEnvVar(envVar, `Real presenter generation requires ${envVar}.`);
    }
  }
}

/**
 * Resolves the executable provider for a single manual/interactive generation call.
 *
 * The server configuration is always the authority for mock vs. real mode. A caller
 * may only request a provider, never a mode. In mock mode real providers are rejected
 * before any paid request is constructed; in real mode the matching credentials must
 * be present. There is no silent fallback between fake and real providers.
 *
 * `imagePilot` / `narrationPilot` are narrow, server-controlled escape hatches used
 * only by the opt-in real pilots (see `lib/ai/image-generation/real-image-pilot.ts`
 * and `lib/ai/text-to-speech/real-narration-pilot.ts`). When one is true and the
 * global real-provider flag is off, a manual call for *that single modality* may
 * resolve to its real provider (`openai` for image, `elevenlabs` for narration).
 * Neither ever affects another modality, neither applies when the caller explicitly
 * asks for `fake`, and both still run through the credential assertions below. They
 * are no-ops when the global flag is already enabled or when an explicit `mode` is
 * supplied.
 */
export function resolveManualGenerationProvider(
  kind: GenerationModality,
  requestedProvider: string | undefined,
  options: { serverConfig?: RunPolicyServerConfig; mode?: RunMode; imagePilot?: boolean; narrationPilot?: boolean } = {}
): GenerationProviderResolution {
  const serverConfig = options.serverConfig ?? resolveRunPolicyServerConfig();
  const normalized = normalizeRequestedProvider(kind, requestedProvider);

  const pilotProvider: Partial<RunProviderSelection> | undefined =
    kind === 'image' && options.imagePilot === true
      ? { image: 'openai' }
      : kind === 'narration' && options.narrationPilot === true
        ? { narration: 'elevenlabs' }
        : undefined;

  const pilotRequestsRealProvider =
    pilotProvider !== undefined &&
    options.mode === undefined &&
    !serverConfig.allowRealProviders &&
    normalized !== 'fake';

  const effectiveServerConfig = pilotRequestsRealProvider ? { ...serverConfig, allowRealProviders: true } : serverConfig;
  const mode = options.mode ?? (pilotRequestsRealProvider ? 'real' : effectiveServerConfig.defaultMode);

  let providers: Partial<RunProviderSelection> | undefined;
  if (normalized) {
    if (kind === 'image') {
      providers = { image: normalized as ImageRunProvider };
    } else if (kind === 'presenter') {
      providers = { presenter: normalized as PresenterRunProvider };
    } else if (kind === 'video') {
      providers = { video: normalized as VideoRunProvider };
    } else if (kind === 'music') {
      providers = { music: normalized as MusicRunProvider };
    } else {
      providers = { narration: normalized as NarrationRunProvider };
    }
  } else if (pilotRequestsRealProvider) {
    providers = pilotProvider;
  }

  const policy = resolveRunPolicy({ mode, providers }, effectiveServerConfig);
  const provider = policy.providers[kind];
  if (!provider) {
    throw new RunPolicyError(`No ${kind} provider is configured.`, 'PROVIDER_NOT_ALLOWED', 403, {
      kind
    });
  }

  // Single-modality enforcement. Run-level enforcement lives in
  // `assertRunPolicyPreflight`, which has the project/plan context needed to know
  // which modalities a run actually executes.
  if (policy.mode === 'mock' && isRealProvider(provider)) {
    throw new RunPolicyError('Mock mode only allows fake/local providers.', 'PROVIDER_NOT_ALLOWED', 403, {
      kind,
      provider
    });
  }

  if (policy.mode === 'real' && !isRealProvider(provider)) {
    throw new RunPolicyError('Real mode requires an explicitly configured real provider.', 'PROVIDER_NOT_ALLOWED', 403, {
      kind,
      provider
    });
  }

  if (policy.mode === 'real') {
    assertRealProviderCredentials(kind, provider);
  }

  return {
    mode: policy.mode,
    provider
  };
}
