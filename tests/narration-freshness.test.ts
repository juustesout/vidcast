import { describe, expect, it } from 'vitest';

import { deriveNarrationFreshness } from '@/lib/generation/narration-freshness';
import type { Project } from '@/lib/types/render';

function createProject(): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-narration-freshness',
    title: 'Narration Freshness',
    description: 'desc',
    durationTarget: 8,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1280,
      height: 720,
      background: { type: 'color', value: '#020617' },
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
        duration: 2,
        type: 'blank',
        narration: { text: '' },
        visual: { kind: 'blank' },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: '',
        renders: []
      }
    ]
  };
}

describe('deriveNarrationFreshness', () => {
  it('returns no_narration when scene narration text is empty', () => {
    const project = createProject();
    const state = deriveNarrationFreshness(project, project.scenes[0]);
    expect(state.state).toBe('no_narration');
  });

  it('returns no_audio when narration text exists but no audio asset is linked', () => {
    const project = createProject();
    project.scenes[0].narration = { text: 'Hello world', status: 'planned' };

    const state = deriveNarrationFreshness(project, project.scenes[0]);
    expect(state.state).toBe('no_audio');
  });

  it('returns current when generated audio matches narration inputs', () => {
    const project = createProject();
    project.scenes[0].narration = {
      text: 'Hello world',
      status: 'generated',
      voiceId: 'voice-a',
      model: 'model-a',
      format: 'mp3',
      audioAssetId: 'audio-1',
      attempts: [{
        id: 'attempt-1',
        status: 'generated',
        provider: 'elevenlabs',
        model: 'model-a',
        voiceId: 'voice-a',
        format: 'mp3',
        createdAt: new Date().toISOString()
      }]
    };

    project.assets.push({
      id: 'audio-1',
      type: 'audio',
      status: 'available',
      provenance: 'generated',
      filename: 'audio-1.mp3',
      localPath: 'assets/audio-1.mp3',
      mimeType: 'audio/mpeg',
      duration: 1,
      filesize: 100,
      metadata: { voiceId: 'voice-a' },
      generation: {
        generationId: 'attempt-1',
        provider: 'elevenlabs',
        model: 'model-a',
        prompt: 'Hello world',
        referenceIds: []
      },
      createdAt: new Date().toISOString()
    });

    const state = deriveNarrationFreshness(project, project.scenes[0]);
    expect(state.state).toBe('current');
  });

  it('returns stale when narration text changes after generation', () => {
    const project = createProject();
    project.scenes[0].narration = {
      text: 'Updated text',
      status: 'generated',
      voiceId: 'voice-a',
      model: 'model-a',
      format: 'mp3',
      audioAssetId: 'audio-1',
      attempts: [{
        id: 'attempt-1',
        status: 'generated',
        provider: 'elevenlabs',
        model: 'model-a',
        voiceId: 'voice-a',
        format: 'mp3',
        createdAt: new Date().toISOString()
      }]
    };

    project.assets.push({
      id: 'audio-1',
      type: 'audio',
      status: 'available',
      provenance: 'generated',
      filename: 'audio-1.mp3',
      localPath: 'assets/audio-1.mp3',
      mimeType: 'audio/mpeg',
      duration: 1,
      filesize: 100,
      metadata: { voiceId: 'voice-a' },
      generation: {
        generationId: 'attempt-1',
        provider: 'elevenlabs',
        model: 'model-a',
        prompt: 'Original text',
        referenceIds: []
      },
      createdAt: new Date().toISOString()
    });

    const state = deriveNarrationFreshness(project, project.scenes[0]);
    expect(state.state).toBe('stale');
  });

  it('returns stale when voice or model changes after generation', () => {
    const project = createProject();
    project.scenes[0].narration = {
      text: 'Hello world',
      status: 'generated',
      voiceId: 'voice-b',
      model: 'model-b',
      format: 'mp3',
      audioAssetId: 'audio-1',
      attempts: [{
        id: 'attempt-1',
        status: 'generated',
        provider: 'elevenlabs',
        model: 'model-a',
        voiceId: 'voice-a',
        format: 'mp3',
        createdAt: new Date().toISOString()
      }]
    };

    project.assets.push({
      id: 'audio-1',
      type: 'audio',
      status: 'available',
      provenance: 'generated',
      filename: 'audio-1.mp3',
      localPath: 'assets/audio-1.mp3',
      mimeType: 'audio/mpeg',
      duration: 1,
      filesize: 100,
      metadata: { voiceId: 'voice-a' },
      generation: {
        generationId: 'attempt-1',
        provider: 'elevenlabs',
        model: 'model-a',
        prompt: 'Hello world',
        referenceIds: []
      },
      createdAt: new Date().toISOString()
    });

    const state = deriveNarrationFreshness(project, project.scenes[0]);
    expect(state.state).toBe('stale');
  });

  it('returns generating and failed based on canonical narration status', () => {
    const project = createProject();
    project.scenes[0].narration = { text: 'Hello', status: 'generating' };
    expect(deriveNarrationFreshness(project, project.scenes[0]).state).toBe('generating');

    project.scenes[0].narration = { text: 'Hello', status: 'failed', error: 'provider error' };
    expect(deriveNarrationFreshness(project, project.scenes[0]).state).toBe('failed');
  });

  it('returns current again after regeneration updates the linked audio metadata', () => {
    const project = createProject();
    project.scenes[0].narration = {
      text: 'Regenerated text',
      status: 'generated',
      voiceId: 'voice-c',
      model: 'model-c',
      format: 'wav',
      audioAssetId: 'audio-2',
      attempts: [{
        id: 'attempt-2',
        status: 'generated',
        provider: 'elevenlabs',
        model: 'model-c',
        voiceId: 'voice-c',
        format: 'wav',
        createdAt: new Date().toISOString()
      }]
    };

    project.assets.push({
      id: 'audio-2',
      type: 'audio',
      status: 'available',
      provenance: 'generated',
      filename: 'audio-2.wav',
      localPath: 'assets/audio-2.wav',
      mimeType: 'audio/wav',
      duration: 1,
      filesize: 100,
      metadata: { voiceId: 'voice-c' },
      generation: {
        generationId: 'attempt-2',
        provider: 'elevenlabs',
        model: 'model-c',
        prompt: 'Regenerated text',
        referenceIds: []
      },
      createdAt: new Date().toISOString()
    });

    const state = deriveNarrationFreshness(project, project.scenes[0]);
    expect(state.state).toBe('current');
  });
});
