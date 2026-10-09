import { describe, expect, it } from 'vitest';

import { createVideoGenerationRegistry, getVideoGenerationConfigurationStatus } from '@/lib/ai/video-generation/registry';
import { VideoGenerationProviderError } from '@/lib/ai/video-generation/provider';

describe('Video provider registry', () => {
  it('resolves openai provider', () => {
    const registry = createVideoGenerationRegistry();
    const provider = registry.getProvider('openai');
    expect(provider.providerId).toBe('openai');
    expect(typeof provider.submit).toBe('function');
    expect(typeof provider.getStatus).toBe('function');
  });

  it('resolves local provider through fake adapter', () => {
    const registry = createVideoGenerationRegistry();
    const provider = registry.getProvider('local');
    expect(provider.providerId).toBe('fake');
  });

  it('fails cleanly for unknown provider', () => {
    const registry = createVideoGenerationRegistry();
    expect(() => registry.getProvider('unknown-provider')).toThrow(VideoGenerationProviderError);
  });

  it('reports provider configuration status', () => {
    const status = getVideoGenerationConfigurationStatus();
    expect(typeof status.openaiConfigured).toBe('boolean');
    expect(status.defaultProvider).toBe('local');
  });
});
