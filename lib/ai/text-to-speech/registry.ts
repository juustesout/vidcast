import { resolveProviderDefaults, resolveRunPolicyServerConfig } from '@/lib/production/run-policy';

import { ElevenLabsTextToSpeechProvider } from './elevenlabs-provider';
import { FakeTextToSpeechProvider } from './fake-provider';
import { TextToSpeechProviderError, type TextToSpeechProvider } from './provider';

export type TextToSpeechProviderId = 'elevenlabs' | 'fake';

export interface TextToSpeechRegistry {
  getProvider(id: string): TextToSpeechProvider;
}

class DefaultTextToSpeechRegistry implements TextToSpeechRegistry {
  getProvider(id: string): TextToSpeechProvider {
    if (id === 'elevenlabs') {
      return new ElevenLabsTextToSpeechProvider();
    }

    if (id === 'fake' || id === 'local') {
      return new FakeTextToSpeechProvider();
    }

    throw new TextToSpeechProviderError(`Unknown text-to-speech provider: ${id}`, 400, 'INVALID_REQUEST');
  }
}

export function createTextToSpeechRegistry(): TextToSpeechRegistry {
  return new DefaultTextToSpeechRegistry();
}

export function getTextToSpeechConfigurationStatus(): { elevenlabsConfigured: boolean; defaultProvider: string } {
  const { defaultMode } = resolveRunPolicyServerConfig();
  return {
    elevenlabsConfigured: Boolean(process.env.ELEVENLABS_API_KEY),
    defaultProvider: resolveProviderDefaults(defaultMode).narration
  };
}
