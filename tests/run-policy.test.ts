import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertRunPolicyPreflight, resolveManualGenerationProvider, resolveRunPolicy, RunPolicyError } from '@/lib/production/run-policy';
import type { Project } from '@/lib/types/render';

function createProjectWithRunningVideoJob(provider: 'openai' | 'local' | 'fal' = 'openai', model?: string): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-policy',
    title: 'Policy',
    description: '',
    durationTarget: 15,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    assets: [],
    references: [],
    compositions: [],
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 4,
        type: 'video',
        narration: { text: '' },
        visual: {
          kind: 'generated_video',
          generation: {
            id: 'attempt-1',
            kind: 'video',
            status: 'generating',
            provider,
            prompt: 'clip',
            referenceIds: [],
            aspectRatio: '16:9',
            providerJobId: 'job-1',
            createdAt: now,
            ...(model ? { model } : {})
          }
        },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ]
  };
}

function createNarrationOnlyProject(): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-narration',
    title: 'Narration Only',
    description: '',
    durationTarget: 15,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    assets: [],
    references: [],
    compositions: [],
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 5,
        type: 'blank',
        narration: { text: 'Single spoken line' },
        visual: { kind: 'blank' },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ]
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('run policy', () => {
  it('denies real mode when server does not allow real providers', () => {
    expect(() =>
      resolveRunPolicy(
        { mode: 'real' },
        { allowRealProviders: false, defaultMode: 'mock' }
      )
    ).toThrow(/disabled/i);
  });

  it('keeps real provider overrides in the snapshot and defers enforcement to preflight', () => {
    const policy = resolveRunPolicy(
      {
        mode: 'mock',
        providers: { image: 'openai' }
      },
      { allowRealProviders: true, defaultMode: 'mock' }
    );

    expect(policy.providers.image).toBe('openai');
  });

  it('defaults force to false and records an explicit force request', () => {
    const server = { allowRealProviders: true, defaultMode: 'mock' as const };

    expect(resolveRunPolicy({ mode: 'mock' }, server).force).toBe(false);
    expect(resolveRunPolicy({ mode: 'mock', force: true }, server).force).toBe(true);
  });

  it('blocks mock mode when an active poll would hit a real provider job', () => {
    const project = createProjectWithRunningVideoJob('openai');
    const policy = resolveRunPolicy(
      { mode: 'mock' },
      { allowRealProviders: true, defaultMode: 'mock' }
    );

    expect(() => assertRunPolicyPreflight(project, policy)).toThrow(/does not match locked run provider policy/i);
  });

  it('requires OpenAI key for real visual generation runs', () => {
    const project = createProjectWithRunningVideoJob('openai');
    const policy = resolveRunPolicy(
      { mode: 'real' },
      { allowRealProviders: true, defaultMode: 'real' }
    );

    vi.stubEnv('OPENAI_API_KEY', '');
    expect(() => assertRunPolicyPreflight(project, policy)).toThrow(/OPENAI_API_KEY/);
  });

  it('only enforces providers for modalities the run actually needs', () => {
    const project = createNarrationOnlyProject();
    vi.stubEnv('ELEVENLABS_API_KEY', 'xi-test');
    vi.stubEnv('OPENAI_API_KEY', '');

    const policy = resolveRunPolicy(
      { mode: 'real', providers: { image: 'fake', video: 'local', narration: 'elevenlabs' } },
      { allowRealProviders: true, defaultMode: 'real' }
    );

    // image/video are unused by this project, so their non-real providers are fine.
    expect(() => assertRunPolicyPreflight(project, policy)).not.toThrow();
  });

  it('rejects a non-real provider for a modality the run needs in real mode', () => {
    const project = createNarrationOnlyProject();
    const policy = resolveRunPolicy(
      { mode: 'real', providers: { narration: 'fake' } },
      { allowRealProviders: true, defaultMode: 'real' }
    );

    expect(() => assertRunPolicyPreflight(project, policy)).toThrow(/narration/i);
  });

  it('rejects a real provider for a modality the run needs in mock mode', () => {
    const project = createNarrationOnlyProject();
    const policy = resolveRunPolicy(
      { mode: 'mock', providers: { narration: 'elevenlabs' } },
      { allowRealProviders: true, defaultMode: 'mock' }
    );

    expect(() => assertRunPolicyPreflight(project, policy)).toThrow(/narration/i);
  });
});

describe('manual generation provider policy', () => {
  const mockServer = { allowRealProviders: false, defaultMode: 'mock' as const };
  const realServer = { allowRealProviders: true, defaultMode: 'real' as const };

  it('defaults to fake/local providers in mock mode', () => {
    expect(resolveManualGenerationProvider('image', undefined, { serverConfig: mockServer })).toEqual({
      mode: 'mock',
      provider: 'fake'
    });
    expect(resolveManualGenerationProvider('video', undefined, { serverConfig: mockServer })).toEqual({
      mode: 'mock',
      provider: 'local'
    });
    expect(resolveManualGenerationProvider('narration', undefined, { serverConfig: mockServer })).toEqual({
      mode: 'mock',
      provider: 'fake'
    });
  });

  it('rejects explicit paid providers in mock mode before any request shape is built', () => {
    expect(() => resolveManualGenerationProvider('image', 'openai', { serverConfig: mockServer })).toThrow(RunPolicyError);
    expect(() => resolveManualGenerationProvider('video', 'openai', { serverConfig: mockServer })).toThrow(/mock mode/i);
    expect(() => resolveManualGenerationProvider('narration', 'elevenlabs', { serverConfig: mockServer })).toThrow(/mock mode/i);
  });

  it('honors a locked mock mode override even when the server default is real', () => {
    expect(resolveManualGenerationProvider('image', undefined, { serverConfig: realServer, mode: 'mock' }).provider).toBe('fake');
  });

  it('rejects fake providers when the server is locked to real mode', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    expect(() => resolveManualGenerationProvider('image', 'fake', { serverConfig: realServer })).toThrow(RunPolicyError);
  });

  it('resolves real providers only when credentials exist', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(() => resolveManualGenerationProvider('image', 'openai', { serverConfig: realServer })).toThrow(/OPENAI_API_KEY/);

    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    expect(resolveManualGenerationProvider('image', 'openai', { serverConfig: realServer })).toEqual({
      mode: 'real',
      provider: 'openai'
    });
  });

  it('rejects unsupported providers instead of silently falling back', () => {
    expect(() => resolveManualGenerationProvider('image', 'gemini', { serverConfig: mockServer })).toThrow(/Unsupported/i);
  });

  it('normalizes alias providers per modality', () => {
    expect(resolveManualGenerationProvider('image', 'local', { serverConfig: mockServer }).provider).toBe('fake');
    expect(resolveManualGenerationProvider('video', 'fake', { serverConfig: mockServer }).provider).toBe('local');
    expect(resolveManualGenerationProvider('narration', 'local', { serverConfig: mockServer }).provider).toBe('fake');
  });

  it('defaults music to the fake provider in mock mode', () => {
    expect(resolveManualGenerationProvider('music', undefined, { serverConfig: mockServer })).toEqual({
      mode: 'mock',
      provider: 'fake'
    });
    expect(resolveManualGenerationProvider('music', 'local', { serverConfig: mockServer }).provider).toBe('fake');
  });

  it('rejects real music providers in mock mode before any request is built', () => {
    expect(() => resolveManualGenerationProvider('music', 'elevenlabs', { serverConfig: mockServer })).toThrow(/mock mode/i);
  });

  it('requires ELEVENLABS_API_KEY for real music generation', () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '');
    expect(() => resolveManualGenerationProvider('music', 'elevenlabs', { serverConfig: realServer })).toThrow(/ELEVENLABS_API_KEY/);

    vi.stubEnv('ELEVENLABS_API_KEY', 'xi-test');
    expect(resolveManualGenerationProvider('music', 'elevenlabs', { serverConfig: realServer })).toEqual({
      mode: 'real',
      provider: 'elevenlabs'
    });
  });

  it('includes music in the snapshot without enforcing it at resolve time', () => {
    const policy = resolveRunPolicy(
      { mode: 'mock' },
      { allowRealProviders: true, defaultMode: 'mock' }
    );
    expect(policy.providers.music).toBe('fake');

    const override = resolveRunPolicy(
      { mode: 'mock', providers: { music: 'elevenlabs' } },
      { allowRealProviders: true, defaultMode: 'mock' }
    );
    expect(override.providers.music).toBe('elevenlabs');
  });
});

describe('FAL video provider policy', () => {
  const mockServer = { allowRealProviders: false, defaultMode: 'mock' as const };
  const realServer = { allowRealProviders: true, defaultMode: 'real' as const };

  it('accepts fal as a real run video provider when FAL_KEY is present', () => {
    vi.stubEnv('FAL_KEY', 'fal-test-key');
    const project = createProjectWithRunningVideoJob('fal');
    const policy = resolveRunPolicy(
      { mode: 'real', providers: { video: 'fal' } },
      realServer
    );

    expect(policy.providers.video).toBe('fal');
    expect(() => assertRunPolicyPreflight(project, policy)).not.toThrow();
  });

  it('rejects fal for a real video run without FAL_KEY', () => {
    vi.stubEnv('FAL_KEY', '');
    const project = createProjectWithRunningVideoJob('openai');
    const policy = resolveRunPolicy(
      { mode: 'real', providers: { video: 'fal' } },
      realServer
    );

    expect(() => assertRunPolicyPreflight(project, policy)).toThrow(/FAL_KEY/);
  });

  it('requires FAL_KEY for an image-to-video scene model (no per-scene model bypass)', () => {
    vi.stubEnv('FAL_KEY', '');
    const project = createProjectWithRunningVideoJob('fal', 'minimax/h3-max-turbo/image-to-video');
    const policy = resolveRunPolicy(
      { mode: 'real', providers: { video: 'fal' } },
      realServer
    );

    expect(() => assertRunPolicyPreflight(project, policy)).toThrow(/FAL_KEY/);
  });

  it('rejects fal for a video run in mock mode', () => {
    const project = createProjectWithRunningVideoJob('local');
    const policy = resolveRunPolicy(
      { mode: 'mock', providers: { video: 'fal' } },
      { allowRealProviders: true, defaultMode: 'mock' }
    );

    expect(() => assertRunPolicyPreflight(project, policy)).toThrow(/mock mode only allows the local video provider/i);
  });

  it('resolves the fal provider for manual calls only in real mode', () => {
    expect(() => resolveManualGenerationProvider('video', 'fal', { serverConfig: mockServer })).toThrow(/mock mode/i);

    vi.stubEnv('FAL_KEY', '');
    expect(() => resolveManualGenerationProvider('video', 'fal', { serverConfig: realServer })).toThrow(/FAL_KEY/);

    vi.stubEnv('FAL_KEY', 'fal-test-key');
    expect(resolveManualGenerationProvider('video', 'fal', { serverConfig: realServer })).toEqual({
      mode: 'real',
      provider: 'fal'
    });
  });

  it('matches an active fal poll job against the locked video provider', () => {
    vi.stubEnv('FAL_KEY', 'fal-test-key');
    const project = createProjectWithRunningVideoJob('fal');

    const matching = resolveRunPolicy({ mode: 'real', providers: { video: 'fal' } }, realServer);
    expect(() => assertRunPolicyPreflight(project, matching)).not.toThrow();

    const mismatched = resolveRunPolicy({ mode: 'real', providers: { video: 'openai' } }, realServer);
    expect(() => assertRunPolicyPreflight(project, mismatched)).toThrow(/does not match locked run provider policy/i);
  });

  it('refuses to poll an active fal job from mock mode', () => {
    const project = createProjectWithRunningVideoJob('fal');
    const policy = resolveRunPolicy(
      { mode: 'mock', providers: { video: 'local' } },
      { allowRealProviders: true, defaultMode: 'mock' }
    );

    expect(() => assertRunPolicyPreflight(project, policy)).toThrow(/does not match locked run provider policy/i);
  });
});

describe('run music opt-in policy', () => {
  const server = { allowRealProviders: false, defaultMode: 'mock' as const };
  it('leaves the music plan undefined when omitted', () => {
    expect(resolveRunPolicy({ mode: 'mock' }, server).music).toBeUndefined();
  });

  it('normalizes a valid generate opt-in', () => {
    const policy = resolveRunPolicy(
      { mode: 'mock', music: { generate: true, prompt: '  calm piano  ', instrumental: false, musicLengthMs: 30_000 } },
      server
    );

    expect(policy.music).toEqual({
      generate: true,
      prompt: 'calm piano',
      instrumental: false,
      musicLengthMs: 30_000,
      selectAssetId: undefined,
      regenerate: undefined,
      model: undefined,
      seed: undefined,
      outputFormat: undefined
    });
  });

  it('normalizes a valid select opt-in', () => {
    const policy = resolveRunPolicy({ mode: 'mock', music: { selectAssetId: ' asset-1 ' } }, server);
    expect(policy.music?.generate).toBe(false);
    expect(policy.music?.selectAssetId).toBe('asset-1');
  });

  it('rejects an opt-in with neither generate nor selectAssetId', () => {
    expect(() => resolveRunPolicy({ mode: 'mock', music: {} }, server)).toThrow(RunPolicyError);
  });

  it('rejects an opt-in that both generates and selects', () => {
    expect(() =>
      resolveRunPolicy({ mode: 'mock', music: { generate: true, prompt: 'x', selectAssetId: 'asset-1' } }, server)
    ).toThrow(/cannot both/i);
  });

  it('rejects generation without a prompt', () => {
    expect(() => resolveRunPolicy({ mode: 'mock', music: { generate: true } }, server)).toThrow(/prompt/i);
  });

  it('rejects a non-positive music length', () => {
    expect(() =>
      resolveRunPolicy({ mode: 'mock', music: { generate: true, prompt: 'x', musicLengthMs: 0 } }, server)
    ).toThrow(/positive/i);
  });
});
