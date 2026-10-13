import { describe, expect, it } from 'vitest';

import {
  isRealVideoProvider,
  REAL_VIDEO_PROVIDERS,
  resolveVideoProviderForwarding
} from '@/lib/generation/video-provider-forwarding';

describe('resolveVideoProviderForwarding', () => {
  it('leaves a mock/absent/non-real provider unset so the server keeps its mode-aware default', () => {
    // Real mode must not receive the mock sentinel `local` as an explicit request.
    expect(resolveVideoProviderForwarding({ provider: 'local' })).toEqual({});
    expect(resolveVideoProviderForwarding({ provider: 'other' })).toEqual({});
    expect(resolveVideoProviderForwarding({ provider: undefined })).toEqual({});
    expect(resolveVideoProviderForwarding(undefined)).toEqual({});
    // A model without a real provider is meaningless and must not leak through.
    expect(resolveVideoProviderForwarding({ provider: 'local', model: 'minimax/h3-max-turbo/image-to-video' })).toEqual({});
  });

  it('forwards an explicit real provider and its model for server-side policy validation', () => {
    expect(resolveVideoProviderForwarding({ provider: 'fal', model: 'minimax/h3-max-turbo/image-to-video' })).toEqual({
      provider: 'fal',
      model: 'minimax/h3-max-turbo/image-to-video'
    });
    expect(resolveVideoProviderForwarding({ provider: 'openai', model: 'sora' })).toEqual({
      provider: 'openai',
      model: 'sora'
    });
  });

  it('never downgrades a real provider to the mock sentinel (mock-mode rejection stays server-side)', () => {
    // The client must keep `fal` so the server-side policy rejects it in mock mode
    // instead of the client silently swapping in `local`.
    expect(resolveVideoProviderForwarding({ provider: 'fal' }).provider).toBe('fal');
    expect(resolveVideoProviderForwarding({ provider: 'openai' }).provider).toBe('openai');
  });

  it('trims a stored model and drops an empty/whitespace one', () => {
    expect(resolveVideoProviderForwarding({ provider: 'fal', model: '  minimax/h3-max-turbo/image-to-video  ' }).model).toBe(
      'minimax/h3-max-turbo/image-to-video'
    );
    expect(resolveVideoProviderForwarding({ provider: 'fal', model: '   ' })).toEqual({ provider: 'fal', model: undefined });
    expect(resolveVideoProviderForwarding({ provider: 'fal' })).toEqual({ provider: 'fal', model: undefined });
  });

  it('classifies only openai/fal as real video providers', () => {
    expect(REAL_VIDEO_PROVIDERS).toEqual(['openai', 'fal']);
    expect(isRealVideoProvider('fal')).toBe(true);
    expect(isRealVideoProvider('openai')).toBe(true);
    expect(isRealVideoProvider('local')).toBe(false);
    expect(isRealVideoProvider('gemini')).toBe(false);
    expect(isRealVideoProvider(undefined)).toBe(false);
  });
});
