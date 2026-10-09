import type { Project } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';
import type { ProductionActionType, ProductionPlannedAction } from './production-planner';
import { deriveProductionPlan } from './production-planner';
import type {
  ImageRunProvider,
  NarrationRunProvider,
  RunMode,
  RunPolicySnapshot,
  RunProviderSelection,
  VideoRunProvider
} from './run-types';

export interface RunPolicyRequest {
  mode?: RunMode;
  providers?: Partial<RunProviderSelection>;
}

export interface RunPolicyServerConfig {
  allowRealProviders: boolean;
  defaultMode: RunMode;
}

export interface RunPolicyPreflightResult {
  requiredActionTypes: ProductionActionType[];
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

function resolveProviderDefaults(mode: RunMode): RunProviderSelection {
  if (mode === 'real') {
    return {
      image: 'openai',
      video: 'openai',
      narration: 'elevenlabs'
    };
  }

  return {
    image: 'fake',
    video: 'local',
    narration: 'fake'
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
  if (!value) {
    return undefined;
  }
  if (value === 'local' || value === 'openai') {
    return value;
  }
  return undefined;
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

function isRealProvider(provider: string): boolean {
  return provider === 'openai' || provider === 'elevenlabs';
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

  const providers: RunProviderSelection = {
    image: imageProvider ?? defaults.image,
    video: videoProvider ?? defaults.video,
    narration: narrationProvider ?? defaults.narration
  };

  if (requestedMode === 'mock') {
    if (providers.image !== 'fake' || providers.video !== 'local' || providers.narration !== 'fake') {
      throw new RunPolicyError(
        'Mock mode only allows fake/local providers.',
        'PROVIDER_NOT_ALLOWED',
        403,
        { mode: requestedMode, providers }
      );
    }
  }

  if (requestedMode === 'real') {
    if (!serverConfig.allowRealProviders) {
      throw new RunPolicyError('Real provider mode is disabled on this server.', 'POLICY_DENIED', 403);
    }

    if (!isRealProvider(providers.image) || !isRealProvider(providers.video) || !isRealProvider(providers.narration)) {
      throw new RunPolicyError(
        'Real mode requires explicitly configured real providers.',
        'PROVIDER_NOT_ALLOWED',
        403,
        { mode: requestedMode, providers }
      );
    }
  }

  return {
    mode: requestedMode,
    allowRealProviders: serverConfig.allowRealProviders,
    providers
  };
}

function isPotentiallyExecutable(action: ProductionPlannedAction): boolean {
  return action.status === 'ready' || action.status === 'waiting_dependency' || action.status === 'running';
}

function resolveVideoPollProviderFromScene(scene: Scene): string | null {
  if (!scene.visual || scene.visual.kind !== 'generated_video') {
    return null;
  }

  const value = scene.visual.generation.provider;
  if (!value || value === 'other') {
    return null;
  }
  if (value === 'openai' || value === 'local') {
    return value;
  }
  return value;
}

function requireEnvVar(name: string, message: string): void {
  if (!process.env[name]) {
    throw new RunPolicyError(message, 'PROVIDER_NOT_CONFIGURED', 409, { envVar: name });
  }
}

export function assertRunPolicyPreflight(project: Project, policy: RunPolicySnapshot): RunPolicyPreflightResult {
  const plan = deriveProductionPlan(project);
  const actionable = plan.actions.filter(isPotentiallyExecutable);
  const requiredActionTypes = Array.from(new Set(actionable.map((action) => action.type)));

  if (policy.mode === 'real') {
    const needsVisualGeneration = requiredActionTypes.includes('image_generate') || requiredActionTypes.includes('video_submit') || requiredActionTypes.includes('video_poll');
    const needsNarrationGeneration = requiredActionTypes.includes('narration_generate');

    if (needsVisualGeneration && (policy.providers.image === 'openai' || policy.providers.video === 'openai')) {
      requireEnvVar('OPENAI_API_KEY', 'Real visual generation requires OPENAI_API_KEY.');
    }

    if (needsNarrationGeneration && policy.providers.narration === 'elevenlabs') {
      requireEnvVar('ELEVENLABS_API_KEY', 'Real narration generation requires ELEVENLABS_API_KEY.');
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
    requiredActionTypes
  };
}
