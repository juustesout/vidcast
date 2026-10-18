import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeVideoGenerationProvider } from '@/lib/ai/video-generation/fake-provider';
import { FalVideoGenerationProvider } from '@/lib/ai/video-generation/fal-provider';
import {
  resolveVideoGeneration,
  resolveVideoGenerationProviderForAttempt
} from '@/lib/ai/video-generation/resolver';
import { RunPolicyError } from '@/lib/production/run-policy';
import type { VideoGenerationRegistry } from '@/lib/ai/video-generation/registry';
import type { VideoGenerationProvider, VideoReferenceInput } from '@/lib/ai/video-generation/provider';

function frame(role: 'start_frame' | 'end_frame'): VideoReferenceInput {
  return { id: role, mimeType: 'image/png', data: Buffer.from('frame'), role };
}

function registry(provider: VideoGenerationProvider = new FakeVideoGenerationProvider()): {
  registry: VideoGenerationRegistry;
  getProvider: ReturnType<typeof vi.fn>;
} {
  const getProvider = vi.fn(() => provider);
  return { registry: { getProvider }, getProvider };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('central video generation resolver', () => {
  it('rejects a real provider in mock mode before resolving an adapter', () => {
    const deps = registry();

    expect(() =>
      resolveVideoGeneration(
        { requestedProvider: 'fal', mode: 'mock', prompt: 'a scene' },
        { registry: deps.registry }
      )
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_NOT_ALLOWED', status: 403 }));
    expect(deps.getProvider).not.toHaveBeenCalled();
  });

  it('rejects a missing real credential before resolving an adapter', () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('FAL_KEY', '');
    const deps = registry();

    expect(() =>
      resolveVideoGeneration(
        { requestedProvider: 'fal', mode: 'real', prompt: 'a scene' },
        { registry: deps.registry }
      )
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED', status: 409 }));
    expect(deps.getProvider).not.toHaveBeenCalled();

    vi.stubEnv('OPENAI_API_KEY', '');
    expect(() =>
      resolveVideoGeneration(
        { requestedProvider: 'openai', mode: 'real', prompt: 'a scene' },
        { registry: deps.registry }
      )
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }));
    expect(deps.getProvider).not.toHaveBeenCalled();
  });

  it('rejects an unknown provider before resolving an adapter', () => {
    const deps = registry();

    expect(() =>
      resolveVideoGeneration(
        { requestedProvider: 'not-a-provider', mode: 'mock', prompt: 'a scene' },
        { registry: deps.registry }
      )
    ).toThrowError(expect.objectContaining({ code: 'INVALID_POLICY', status: 400 }));
    expect(deps.getProvider).not.toHaveBeenCalled();
  });

  it('resolves the mock provider and builds a validated text-to-video request', () => {
    const deps = registry();

    const resolved = resolveVideoGeneration(
      {
        requestedProvider: 'local',
        mode: 'mock',
        prompt: 'a scene',
        aspectRatio: '16:9',
        durationSeconds: 3,
        metadata: { projectId: 'p', idempotencyKey: 'attempt-1' }
      },
      { registry: deps.registry }
    );

    expect(resolved.mode).toBe('mock');
    expect(resolved.providerKey).toBe('local');
    expect(resolved.provider.providerId).toBe('fake');
    expect(resolved.contract.mode).toBe('text_to_video');
    expect(resolved.request).toMatchObject({
      prompt: 'a scene',
      aspectRatio: '16:9',
      durationSeconds: 3,
      metadata: { projectId: 'p', idempotencyKey: 'attempt-1' }
    });
  });

  it('resolves a real FAL provider with model-aware capabilities', () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('FAL_KEY', 'fal-test-key');
    const fal = new FalVideoGenerationProvider({
      apiKey: 'fal-test-key',
      endpoint: 'minimax/h3-max-turbo/text-to-video',
      fetchImpl: async () => {
        throw new Error('resolver must not call the provider');
      }
    });
    const deps = registry(fal);

    const resolved = resolveVideoGeneration(
      {
        requestedProvider: 'fal',
        mode: 'real',
        model: 'minimax/h3-max-turbo/image-to-video',
        prompt: 'animate a still',
        references: [frame('start_frame')],
        aspectRatio: '16:9'
      },
      { registry: deps.registry }
    );

    expect(resolved.providerKey).toBe('fal');
    expect(resolved.contract.model).toBe('minimax/h3-max-turbo/image-to-video');
    expect(resolved.contract.mode).toBe('image_to_video');
    expect(resolved.contract.capabilities.supportsImageToVideo).toBe(true);
  });

  it('rejects an incompatible FAL model/mode pair without calling the provider', () => {
    vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
    vi.stubEnv('FAL_KEY', 'fal-test-key');
    let fetchCalls = 0;
    const fal = new FalVideoGenerationProvider({
      apiKey: 'fal-test-key',
      endpoint: 'minimax/h3-max-turbo/text-to-video',
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('must not be called');
      }
    });
    const deps = registry(fal);

    expect(() =>
      resolveVideoGeneration(
        {
          requestedProvider: 'fal',
          mode: 'real',
          model: 'minimax/h3-max-turbo/text-to-video',
          prompt: 'animate a still',
          references: [frame('start_frame')]
        },
        { registry: deps.registry }
      )
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED' }));
    expect(fetchCalls).toBe(0);
  });

  it('never falls back to a server default for an active attempt without a provider identity', () => {
    const deps = registry();

    expect(() =>
      resolveVideoGenerationProviderForAttempt('other', { mode: 'mock' }, { registry: deps.registry })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_POLICY', status: 409 }));
    expect(() =>
      resolveVideoGenerationProviderForAttempt(undefined, { mode: 'mock' }, { registry: deps.registry })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_POLICY', status: 409 }));
    expect(deps.getProvider).not.toHaveBeenCalled();
  });
});
