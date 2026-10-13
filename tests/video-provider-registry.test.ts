import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVideoGenerationRegistry, getVideoGenerationConfigurationStatus } from '@/lib/ai/video-generation/registry';
import { VideoGenerationProviderError } from '@/lib/ai/video-generation/provider';

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it('resolves the fal provider', () => {
    const registry = createVideoGenerationRegistry();
    const provider = registry.getProvider('fal');
    expect(provider.providerId).toBe('fal');
    expect(typeof provider.submit).toBe('function');
    expect(typeof provider.getStatus).toBe('function');
  });

  it('reflects the configured fal endpoint in the resolved provider capabilities', () => {
    const registry = createVideoGenerationRegistry();

    vi.stubEnv('FAL_VIDEO_ENDPOINT', 'minimax/h3-max-turbo/image-to-video');
    expect(registry.getProvider('fal').getCapabilities().supportsImageToVideo).toBe(true);

    vi.stubEnv('FAL_VIDEO_ENDPOINT', 'minimax/h3-max-turbo/text-to-video');
    expect(registry.getProvider('fal').getCapabilities().supportsImageToVideo).toBe(false);
  });

  it('fails cleanly for unknown provider', () => {
    const registry = createVideoGenerationRegistry();
    expect(() => registry.getProvider('unknown-provider')).toThrow(VideoGenerationProviderError);
  });

  it('reports provider configuration status', () => {
    const status = getVideoGenerationConfigurationStatus();
    expect(typeof status.openaiConfigured).toBe('boolean');
    expect(typeof status.falConfigured).toBe('boolean');
    expect(status.defaultProvider).toBe('local');
  });
});
