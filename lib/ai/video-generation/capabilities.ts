import type { AspectRatio } from '@/lib/types/render';

import {
  VideoGenerationProviderError,
  type VideoGenerationCapabilities,
  type VideoGenerationProvider,
  type VideoReferenceInput
} from './provider';

// Provider-neutral generation modes derived from the request's reference roles.
// They are the single vocabulary used by capability validation, diagnostics and
// future providers/models.
export type VideoGenerationMode = 'text_to_video' | 'image_to_video' | 'reference_guided';

export interface VideoGenerationIntent {
  model?: string;
  references?: VideoReferenceInput[];
  aspectRatio?: AspectRatio;
  durationSeconds?: number;
}

export interface VideoGenerationCapabilityContract {
  providerId: string;
  model?: string;
  mode: VideoGenerationMode;
  capabilities: VideoGenerationCapabilities;
}

function isFrameReference(reference: VideoReferenceInput): boolean {
  return reference.role === 'start_frame' || reference.role === 'end_frame';
}

export function classifyVideoGenerationMode(references: VideoReferenceInput[] | undefined): VideoGenerationMode {
  const entries = references ?? [];
  if (entries.length === 0) {
    return 'text_to_video';
  }
  if (entries.some(isFrameReference)) {
    return 'image_to_video';
  }
  return 'reference_guided';
}

function unsupported(providerId: string, mode: VideoGenerationMode): VideoGenerationProviderError {
  return new VideoGenerationProviderError(
    `Provider ${providerId} does not support ${mode.replaceAll('_', ' ')} generation.`,
    422,
    'UNSUPPORTED'
  );
}

function assertModeSupported(
  providerId: string,
  mode: VideoGenerationMode,
  capabilities: VideoGenerationCapabilities
): void {
  if (mode === 'text_to_video' && !capabilities.supportsTextToVideo) {
    throw unsupported(providerId, mode);
  }
  if (mode === 'image_to_video' && !capabilities.supportsImageToVideo) {
    throw unsupported(providerId, mode);
  }
  if (mode === 'reference_guided' && !capabilities.supportsReferences) {
    throw unsupported(providerId, mode);
  }
}

function assertReferencesSupported(
  providerId: string,
  mode: VideoGenerationMode,
  references: VideoReferenceInput[],
  capabilities: VideoGenerationCapabilities
): void {
  if (capabilities.maxReferences !== undefined && references.length > capabilities.maxReferences) {
    throw new VideoGenerationProviderError(
      `Provider ${providerId} accepts at most ${capabilities.maxReferences} reference image(s).`,
      422,
      'REFERENCE_ERROR'
    );
  }

  if (mode !== 'image_to_video' || capabilities.supportsReferences) {
    return;
  }

  // A provider that only understands keyframes must reject an ordinary style
  // reference instead of silently dropping it.
  const plainReferences = references.filter((reference) => !isFrameReference(reference));
  if (plainReferences.length > 0) {
    throw new VideoGenerationProviderError(
      `Provider ${providerId} only accepts start/end frame references for image-to-video.`,
      422,
      'REFERENCE_ERROR'
    );
  }
}

function assertAspectRatioSupported(
  providerId: string,
  aspectRatio: AspectRatio | undefined,
  capabilities: VideoGenerationCapabilities
): void {
  if (!aspectRatio || !capabilities.supportedAspectRatios || capabilities.supportedAspectRatios.length === 0) {
    return;
  }
  if (!capabilities.supportedAspectRatios.includes(aspectRatio)) {
    throw new VideoGenerationProviderError(
      `Provider ${providerId} does not support aspect ratio ${aspectRatio}.`,
      422,
      'UNSUPPORTED'
    );
  }
}

function assertDurationSupported(
  providerId: string,
  durationSeconds: number | undefined,
  capabilities: VideoGenerationCapabilities
): void {
  if (durationSeconds === undefined) {
    return;
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new VideoGenerationProviderError('Video duration must be a positive number of seconds.', 400, 'INVALID_REQUEST');
  }
  if (!capabilities.supportedDurationsSeconds || capabilities.supportedDurationsSeconds.length === 0) {
    return;
  }

  const rounded = Math.round(durationSeconds);
  if (!capabilities.supportedDurationsSeconds.includes(rounded)) {
    throw new VideoGenerationProviderError(
      `Provider ${providerId} does not support a ${rounded}s video.`,
      422,
      'UNSUPPORTED'
    );
  }
}

/**
 * Resolves the single capability contract for a provider + model + request.
 *
 * Model-aware capabilities are asked from the adapter (`getCapabilitiesForModel`)
 * so a FAL text-to-video endpoint and its image-to-video variant cannot claim the
 * same modes. Validation happens before any external submit: unsupported modes,
 * incompatible model/mode combinations, reference-role mismatches, aspect ratios
 * and declared duration enums are rejected here.
 */
export function resolveVideoGenerationCapabilityContract(
  provider: VideoGenerationProvider,
  intent: VideoGenerationIntent
): VideoGenerationCapabilityContract {
  const model = typeof intent.model === 'string' && intent.model.trim() ? intent.model.trim() : undefined;
  const references = intent.references ?? [];
  const mode = classifyVideoGenerationMode(references);
  const capabilities = provider.getCapabilitiesForModel
    ? provider.getCapabilitiesForModel(model)
    : provider.getCapabilities();

  assertModeSupported(provider.providerId, mode, capabilities);
  assertReferencesSupported(provider.providerId, mode, references, capabilities);
  assertAspectRatioSupported(provider.providerId, intent.aspectRatio, capabilities);
  assertDurationSupported(provider.providerId, intent.durationSeconds, capabilities);

  return {
    providerId: provider.providerId,
    model,
    mode,
    capabilities
  };
}
