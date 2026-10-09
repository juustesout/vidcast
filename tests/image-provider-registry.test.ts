import { describe, expect, it } from 'vitest';

import { createImageGenerationRegistry, getImageGenerationConfigurationStatus } from '@/lib/ai/image-generation/registry';
import { ImageGenerationProviderError } from '@/lib/ai/image-generation/provider';

describe('Image provider registry', () => {
  it('resolves openai provider', () => {
    const registry = createImageGenerationRegistry();
    const provider = registry.getProvider('openai');
    expect(provider.providerId).toBe('openai');
    expect(typeof provider.generateImage).toBe('function');
  });

  it('fails cleanly for unknown provider', () => {
    const registry = createImageGenerationRegistry();
    expect(() => registry.getProvider('unknown')).toThrow(ImageGenerationProviderError);
  });

  it('reports provider configuration status', () => {
    const status = getImageGenerationConfigurationStatus();
    expect(typeof status.openaiConfigured).toBe('boolean');
    expect(status.defaultProvider).toBe('fake');
  });
});
