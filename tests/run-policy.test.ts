import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertRunPolicyPreflight, resolveRunPolicy } from '@/lib/production/run-policy';
import type { Project } from '@/lib/types/render';

function createProjectWithRunningVideoJob(provider: 'openai' | 'local' = 'openai'): Project {
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
            createdAt: now
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

  it('rejects real provider overrides in mock mode', () => {
    expect(() =>
      resolveRunPolicy(
        {
          mode: 'mock',
          providers: { image: 'openai' }
        },
        { allowRealProviders: true, defaultMode: 'mock' }
      )
    ).toThrow(/mock mode/i);
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
});
