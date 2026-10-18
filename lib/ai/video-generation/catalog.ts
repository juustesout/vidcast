import type { GenerationProvider } from '@/lib/types/generation';

// The executable video providers. `fake` is accepted as an alias for `local`
// only at the registry/policy boundary; it never reaches persisted state.
export type VideoProviderKey = 'openai' | 'fal' | 'local';

export const VIDEO_PROVIDER_KEYS: VideoProviderKey[] = ['openai', 'fal', 'local'];

// An explicitly real (paid) video provider. `local` is the mock sentinel and is
// never billed.
export const REAL_VIDEO_PROVIDER_KEYS = ['openai', 'fal'] as const;

export type RealVideoProviderKey = (typeof REAL_VIDEO_PROVIDER_KEYS)[number];

export function normalizeVideoProviderKey(value: string | undefined): VideoProviderKey | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'openai') {
    return 'openai';
  }
  if (normalized === 'fal') {
    return 'fal';
  }
  if (normalized === 'local' || normalized === 'fake') {
    return 'local';
  }
  return undefined;
}

export function isRealVideoProviderKey(value: string | undefined): value is RealVideoProviderKey {
  return value === 'openai' || value === 'fal';
}

// The credential an adapter needs before a paid request may be constructed.
// Keeping this next to the provider catalog prevents route/UI/policy copies from
// drifting apart.
export function videoProviderCredentialEnvVar(provider: string): string | undefined {
  if (provider === 'openai') {
    return 'OPENAI_API_KEY';
  }
  if (provider === 'fal') {
    return 'FAL_KEY';
  }
  return undefined;
}

// Maps an adapter provider id to the public generation-provider vocabulary. The
// fake adapter is persisted as `local` so mock provenance stays explicit.
export function toGenerationProvider(providerId: string | undefined): GenerationProvider {
  if (providerId === 'openai' || providerId === 'gemini' || providerId === 'fal' || providerId === 'local') {
    return providerId;
  }
  if (providerId === 'fake') {
    return 'local';
  }
  return 'other';
}
