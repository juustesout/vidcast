import { resolveProviderDefaults, resolveRunPolicyServerConfig } from '@/lib/production/run-policy';

import { ElevenLabsMusicProvider } from './elevenlabs-provider';
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

    if (id === 'elevenlabs') {
      // Constructing the adapter performs no network call; the paid request is
      // only built inside generate(), which the service invokes solely on an
      // explicit user generation action.
      return new ElevenLabsMusicProvider();
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
