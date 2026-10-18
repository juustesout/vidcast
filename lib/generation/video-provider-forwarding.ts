import type { GenerationAttempt } from '@/lib/types/generation';

import {
  REAL_VIDEO_PROVIDER_KEYS,
  isRealVideoProviderKey,
  type RealVideoProviderKey
} from '@/lib/ai/video-generation/catalog';

// The video provider choices that map to a real (paid) provider. `local` is the
// mock sentinel and `other` is unknown; neither may be forwarded as an explicit
// request because the server — not the client — is the authority for mock/real
// mode and provider policy.
export const REAL_VIDEO_PROVIDERS = REAL_VIDEO_PROVIDER_KEYS;

export type RealVideoProvider = RealVideoProviderKey;

export function isRealVideoProvider(value: string | undefined): value is RealVideoProvider {
  return isRealVideoProviderKey(value);
}

export interface VideoProviderForwarding {
  provider?: RealVideoProvider;
  model?: string;
}

// Decides what a manual submission or the client batch runner forwards for a
// scene's video generation. Only an explicitly stored real provider (and the
// model that belongs to it) is forwarded:
//  - real `openai`/`fal` -> forwarded and validated by the server-side resolver;
//  - mock `local`, `other`, or a missing provider -> left unset so the server
//    applies its mode-aware default (`mock -> local`, `real -> a real provider`).
//    This never silently downgrades a real provider and never forces the mock
//    sentinel into a real-mode run.
export function resolveVideoProviderForwarding(
  generation: Pick<GenerationAttempt, 'provider' | 'model'> | undefined
): VideoProviderForwarding {
  const provider = generation?.provider;
  if (!isRealVideoProvider(provider)) {
    return {};
  }

  const storedModel = generation?.model;
  const model = typeof storedModel === 'string' && storedModel.trim() ? storedModel.trim() : undefined;
  return { provider, model };
}
