import { resolveProviderDefaults, resolveRunPolicyServerConfig } from '@/lib/production/run-policy';

import { FakeMusicProvider } from './fake-provider';
import { MusicProviderError, type MusicProvider } from './provider';

export type MusicProviderId = 'fake' | 'elevenlabs';

export interface MusicRegistry {
  getProvider(id: string): MusicProvider;
}

class DefaultMusicRegistry implements MusicRegistry {
  getProvider(id: string): MusicProvider {
    if (id === 'fake' || id === 'local') {
      return new FakeMusicProvider();
    }

    // The real ElevenLabs music adapter is intentionally deferred. The policy
    // and provider seam exist so it can be added later without touching the
    // service, but no paid API call is constructed in this phase.
    if (id === 'elevenlabs') {
      throw new MusicProviderError('ElevenLabs music generation is not available yet.', 501, 'UNSUPPORTED');
    }

    throw new MusicProviderError(`Unknown music provider: ${id}`, 400, 'INVALID_REQUEST');
  }
}

export function createMusicRegistry(): MusicRegistry {
  return new DefaultMusicRegistry();
}

export function getMusicConfigurationStatus(): { elevenlabsConfigured: boolean; defaultProvider: string } {
  const { defaultMode } = resolveRunPolicyServerConfig();
  return {
    elevenlabsConfigured: Boolean(process.env.ELEVENLABS_API_KEY),
    defaultProvider: resolveProviderDefaults(defaultMode).music
  };
}
