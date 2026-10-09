import { resolveProviderDefaults, resolveRunPolicyServerConfig } from '@/lib/production/run-policy';

import { FakeVideoGenerationProvider } from './fake-provider';
import { OpenAiVideoGenerationProvider } from './openai-provider';
import { VideoGenerationProviderError, type VideoGenerationProvider } from './provider';

export type VideoProviderId = 'openai' | 'fake';

export interface VideoGenerationRegistry {
  getProvider(id: string): VideoGenerationProvider;
}

class DefaultVideoGenerationRegistry implements VideoGenerationRegistry {
  getProvider(id: string): VideoGenerationProvider {
    if (id === 'openai') {
      return new OpenAiVideoGenerationProvider();
    }

    if (id === 'fake' || id === 'local') {
      return new FakeVideoGenerationProvider();
    }

    throw new VideoGenerationProviderError(`Unknown video generation provider: ${id}`, 400, 'INVALID_REQUEST');
  }
}

export function createVideoGenerationRegistry(): VideoGenerationRegistry {
  return new DefaultVideoGenerationRegistry();
}

export function getVideoGenerationConfigurationStatus(): { openaiConfigured: boolean; defaultProvider: string } {
  const { defaultMode } = resolveRunPolicyServerConfig();
  return {
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    defaultProvider: resolveProviderDefaults(defaultMode).video
  };
}
