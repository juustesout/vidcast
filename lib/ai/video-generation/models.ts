import type { GenerationProvider } from '@/lib/types/generation';

// Validated FAL video model endpoints offered as authoring suggestions. These
// mirror the adapter defaults in fal-provider.ts and are not new provider ids.
// They are hints only: a stored endpoint is still validated by the FAL adapter
// and the central capability contract before any request is made.
export const FAL_VIDEO_MODEL_ENDPOINTS: string[] = [
  'minimax/h3-max-turbo/text-to-video',
  'minimax/h3-max-turbo/image-to-video'
];

export interface VideoModelAuthoringHints {
  placeholder: string;
  suggestions?: string[];
}

// Central model guidance for the scene inspector. Keeps provider-specific model
// knowledge out of UI components while preserving the existing FAL suggestions.
export function resolveVideoModelAuthoringHints(provider: GenerationProvider | undefined): VideoModelAuthoringHints {
  if (provider === 'fal') {
    return {
      placeholder: 'minimax/h3-max-turbo/image-to-video',
      suggestions: FAL_VIDEO_MODEL_ENDPOINTS
    };
  }

  return { placeholder: 'Provider default' };
}
