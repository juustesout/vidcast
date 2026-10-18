import { resolveProviderDefaults, resolveRunPolicyServerConfig } from '@/lib/production/run-policy';

import { normalizeVideoProviderKey, videoProviderCredentialEnvVar } from './catalog';
import { FalVideoGenerationProvider } from './fal-provider';
import { FakeVideoGenerationProvider } from './fake-provider';
import { OpenAiVideoGenerationProvider } from './openai-provider';
import { VideoGenerationProviderError, type VideoGenerationProvider } from './provider';

export interface VideoGenerationRegistry {
  getProvider(id: string): VideoGenerationProvider;
}

class DefaultVideoGenerationRegistry implements VideoGenerationRegistry {
  getProvider(id: string): VideoGenerationProvider {
    const key = normalizeVideoProviderKey(id);
    if (!key) {
      throw new VideoGenerationProviderError(`Unknown video generation provider: ${id}`, 400, 'INVALID_REQUEST');
    }

    if (key === 'openai') {
      return new OpenAiVideoGenerationProvider();
    }

    if (key === 'fal') {
      return new FalVideoGenerationProvider();
    }

    return new FakeVideoGenerationProvider();
  }
}

export function createVideoGenerationRegistry(): VideoGenerationRegistry {
  return new DefaultVideoGenerationRegistry();
}

export function getVideoGenerationConfigurationStatus(): {
  openaiConfigured: boolean;
  falConfigured: boolean;
  defaultProvider: string;
} {
  const { defaultMode } = resolveRunPolicyServerConfig();
  return {
    openaiConfigured: Boolean(process.env[videoProviderCredentialEnvVar('openai')!]),
    falConfigured: Boolean(process.env[videoProviderCredentialEnvVar('fal')!]),
    defaultProvider: resolveProviderDefaults(defaultMode).video
  };
}
