import { describe, expect, it } from 'vitest';

import { hashProductionContent, isValidHumanApproval, stampHumanApproval } from '@/lib/explainer/human-approval';
import type { Project } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';

function buildProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: 'approval-hash-project',
    title: 'Approval Hash',
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
        type: 'image',
        narration: { text: 'Say it', voiceId: 'voice-a', model: 'model-a' },
        visual: {
          kind: 'stock_image',
          query: 'hydration',
          orientation: 'landscape',
          selection: {
            provider: 'unsplash',
            photoId: 'photo-1',
            query: 'hydration',
            orientation: 'landscape',
            usagePolicy: 'hotlink',
            attribution: {
              provider: 'unsplash',
              providerName: 'Unsplash',
              photoId: 'photo-1',
              photographerName: 'Ada',
              sourceUrl: 'https://unsplash.com/photos/photo-1',
              license: 'Unsplash License'
            },
            sourceUrl: 'https://unsplash.com/photos/photo-1',
            imageUrl: 'https://images.unsplash.com/photo-1',
            width: 1920,
            height: 1080,
            selectedAt: now,
            selectionKey: 'landscape::hydration',
            origin: 'manual'
          }
        },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ],
    music: {
      prompt: 'calm ambient',
      assetId: 'music-1'
    },
    ...overrides
  };
}

function withApproval(project: Project): Project {
  const next = structuredClone(project) as Project;
  next.explainer = {
    brief: {
      topic: '',
      goal: '',
      audience: '',
      tone: '',
      targetDurationSeconds: project.durationTarget,
      notes: ''
    },
    story: {
      title: project.title,
      hook: '',
      script: '',
      beats: [],
      cta: '',
      notes: '',
      versions: []
    },
    sceneIntents: [],
    humanApproval: stampHumanApproval(next, { subject: 'user_test' })
  };
  return next;
}

describe('hashProductionContent', () => {
  it('stays valid when production inputs are unchanged', () => {
    const project = withApproval(buildProject());
    expect(isValidHumanApproval(project)).toBe(true);
    expect(hashProductionContent(project)).toBe(project.explainer?.humanApproval?.contentHash);
  });

  it('becomes stale when the music prompt changes', () => {
    const project = withApproval(buildProject());
    project.music = { ...project.music, prompt: 'energetic drums' };
    expect(isValidHumanApproval(project)).toBe(false);
  });

  it('becomes stale when the TTS voice or model changes', () => {
    const voiceChanged = withApproval(buildProject());
    const scene = voiceChanged.scenes[0] as Scene;
    scene.narration = { ...scene.narration!, voiceId: 'voice-b' };
    expect(isValidHumanApproval(voiceChanged)).toBe(false);

    const modelChanged = withApproval(buildProject());
    const modelScene = modelChanged.scenes[0] as Scene;
    modelScene.narration = { ...modelScene.narration!, model: 'model-b' };
    expect(isValidHumanApproval(modelChanged)).toBe(false);
  });

  it('becomes stale when the stock selection changes', () => {
    const project = withApproval(buildProject());
    const scene = project.scenes[0];
    if (scene.visual?.kind !== 'stock_image' || !scene.visual.selection) {
      throw new Error('expected stock_image selection');
    }
    scene.visual.selection = { ...scene.visual.selection, photoId: 'photo-2', selectionKey: 'landscape::hydration-2' };
    expect(isValidHumanApproval(project)).toBe(false);
  });

  it('does not change when unrelated asset metadata changes', () => {
    const project = withApproval(buildProject());
    const original = hashProductionContent(project);
    project.title = 'Renamed';
    project.updatedAt = new Date().toISOString();
    expect(hashProductionContent(project)).toBe(original);
    expect(isValidHumanApproval(project)).toBe(true);
  });
});
