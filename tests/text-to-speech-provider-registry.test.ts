import { describe, expect, it } from 'vitest';

import { createTextToSpeechRegistry, getTextToSpeechConfigurationStatus } from '@/lib/ai/text-to-speech/registry';
import { TextToSpeechProviderError } from '@/lib/ai/text-to-speech/provider';

describe('Text-to-speech provider registry', () => {
  it('resolves elevenlabs provider', () => {
    const registry = createTextToSpeechRegistry();
    const provider = registry.getProvider('elevenlabs');
    expect(provider.providerId).toBe('elevenlabs');
    expect(typeof provider.synthesize).toBe('function');
  });

  it('fails cleanly for unknown provider', () => {
    const registry = createTextToSpeechRegistry();
    expect(() => registry.getProvider('unknown')).toThrow(TextToSpeechProviderError);
  });

  it('reports configuration status with policy default provider', () => {
    const status = getTextToSpeechConfigurationStatus();
    expect(typeof status.elevenlabsConfigured).toBe('boolean');
    expect(status.defaultProvider).toBe('fake');
  });
});
