import type { VideoGenerationRequest, VideoGenerationProvider, VideoReferenceInput } from '@/lib/ai/video-generation/provider';
import { createVideoGenerationRegistry, type VideoGenerationRegistry } from '@/lib/ai/video-generation/registry';
import {
  resolveVideoGenerationCapabilityContract,
  type VideoGenerationCapabilityContract
} from '@/lib/ai/video-generation/capabilities';
import {
  RunPolicyError,
  resolveManualGenerationProvider,
  type RunPolicyServerConfig
} from '@/lib/production/run-policy';
import type { RunMode } from '@/lib/production/run-types';
import type { AspectRatio } from '@/lib/types/render';

export interface VideoGenerationResolverDependencies {
  registry?: VideoGenerationRegistry;
  serverConfig?: RunPolicyServerConfig;
}

export interface VideoGenerationProviderResolution {
  mode: RunMode;
  // The policy-level provider key (`openai` | `fal` | `local`). The adapter may
  // report `fake` for the local key; policy and billing decisions use this key.
  providerKey: string;
  provider: VideoGenerationProvider;
}

export interface ResolveVideoGenerationProviderOptions {
  mode?: RunMode;
  serverConfig?: RunPolicyServerConfig;
}

export interface VideoGenerationRequestInput extends ResolveVideoGenerationProviderOptions {
  requestedProvider?: string;
  model?: string;
  prompt: string;
  references?: VideoReferenceInput[];
  aspectRatio?: AspectRatio;
  durationSeconds?: number;
  metadata?: Record<string, string>;
}

export interface ResolvedVideoGeneration extends VideoGenerationProviderResolution {
  contract: VideoGenerationCapabilityContract;
  request: VideoGenerationRequest;
}

function requestedProviderForAttempt(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === 'other') {
    return undefined;
  }
  return normalized;
}

/**
 * The single server-side provider resolver. Mode, credential, unknown-provider
 * and capability policy all pass through here; routes/UI/production code only
 * forward the requested provider/model.
 */
export function resolveVideoGenerationProvider(
  requestedProvider: string | undefined,
  options: ResolveVideoGenerationProviderOptions = {},
  dependencies: VideoGenerationResolverDependencies = {}
): VideoGenerationProviderResolution {
  const resolution = resolveManualGenerationProvider('video', requestedProvider, {
    mode: options.mode,
    serverConfig: options.serverConfig ?? dependencies.serverConfig
  });
  const registry = dependencies.registry ?? createVideoGenerationRegistry();
  const provider = registry.getProvider(resolution.provider);

  return {
    mode: resolution.mode,
    providerKey: resolution.provider,
    provider
  };
}

export function resolveVideoGenerationProviderForAttempt(
  attemptProvider: string | undefined,
  options: ResolveVideoGenerationProviderOptions = {},
  dependencies: VideoGenerationResolverDependencies = {}
): VideoGenerationProviderResolution {
  const requested = requestedProviderForAttempt(attemptProvider);
  if (!requested) {
    // An active attempt without a provider identity cannot be polled/cancelled
    // safely: falling back to a server default could address a different (and
    // possibly paid) provider than the one running the job.
    throw new RunPolicyError(
      'The active video generation attempt has no provider identity; refusing to switch providers.',
      'INVALID_POLICY',
      409,
      { provider: attemptProvider }
    );
  }

  return resolveVideoGenerationProvider(requested, options, dependencies);
}

/**
 * Resolves provider + model into a fully validated request. Capability
 * validation runs before the caller persists an attempt or calls the provider, so
 * unsupported modes/model pairs, reference-role mismatches and unsupported
 * aspects/durations never reach an external service.
 */
export function resolveVideoGeneration(
  input: VideoGenerationRequestInput,
  dependencies: VideoGenerationResolverDependencies = {}
): ResolvedVideoGeneration {
  const resolution = resolveVideoGenerationProvider(input.requestedProvider, input, dependencies);
  const contract = resolveVideoGenerationCapabilityContract(resolution.provider, {
    model: input.model,
    references: input.references,
    aspectRatio: input.aspectRatio,
    durationSeconds: input.durationSeconds
  });

  return {
    ...resolution,
    contract,
    request: {
      model: contract.model,
      prompt: input.prompt,
      references: input.references,
      aspectRatio: input.aspectRatio,
      durationSeconds: input.durationSeconds,
      metadata: input.metadata
    }
  };
}
