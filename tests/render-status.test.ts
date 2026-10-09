import { describe, expect, it } from 'vitest';

import { deriveCompositionArtifactStatus, deriveCompositionReadiness, deriveSceneRenderStatus } from '@/lib/render/render-status';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import { deriveMusicSignature } from '@/lib/render/music-mix';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';

function createProject(): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-status-1',
    title: 'Status Test',
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
        narration: { text: 'hello' },
        visual: { kind: 'blank' },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: '',
        renders: []
      },
      {
        id: 'scene-2',
        order: 2,
        duration: 2,
        type: 'blank',
        narration: { text: 'world' },
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

function attachCurrentRender(project: Project, sceneId: string): Project {
  const plan = resolveRenderPlan(project);
  const scenePlan = plan.scenes.find((entry) => entry.sceneId === sceneId)!;
  const scene = project.scenes.find((entry) => entry.id === sceneId)!;
  scene.renders = [
    {
      renderId: `render-${sceneId}`,
      outputPath: `renders/${sceneId}.mp4`,
      createdAt: new Date().toISOString(),
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      duration: scene.duration,
      filesize: 100,
      mimeType: 'video/mp4',
      renderer: 'ffmpeg',
      status: 'completed',
      renderFingerprint: createSceneRenderFingerprint(plan, scenePlan)
    }
  ];
  return project;
}

function createMusicAsset(id: string): Asset {
  return {
    id,
    type: 'music',
    status: 'available',
    provenance: 'generated',
    filename: `${id}.wav`,
    localPath: `assets/${id}.wav`,
    mimeType: 'audio/wav',
    duration: 60,
    filesize: 100,
    metadata: {},
    generation: {
      generationId: `attempt-${id}`,
      provider: 'fake',
      model: 'music_v1',
      prompt: 'calm',
      referenceIds: []
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function attachComposition(
  project: Project,
  music?: { assetId: string; musicVolume: number; fadeInSeconds: number; fadeOutSeconds: number; musicSignature: string }
): Project {
  project.compositions = [{
    compositionId: 'composition-1',
    projectId: project.id,
    outputPath: 'renders/compositions/final-composition-1.mp4',
    createdAt: new Date().toISOString(),
    sceneIds: ['scene-1', 'scene-2'],
    inputFingerprint: {
      version: 'p10.1',
      audioMix: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      music,
      scenes: [
        { sceneId: 'scene-1', renderId: 'render-scene-1', narrationSignature: 'text:hello|voice:|model:|format:|asset:' },
        { sceneId: 'scene-2', renderId: 'render-scene-2', narrationSignature: 'text:world|voice:|model:|format:|asset:' }
      ]
    },
    duration: 4,
    width: 1280,
    height: 720,
    fps: 30,
    renderer: 'ffmpeg',
    version: 'p10.1-test',
    filesize: 100,
    mimeType: 'video/mp4',
    transition: { type: 'none' }
  }];
  return project;
}

function musicFingerprint(project: Project) {
  const asset = project.assets.find((entry) => entry.id === project.music?.assetId);
  if (!asset) {
    throw new Error('test setup: music asset missing');
  }
  return {
    assetId: asset.id,
    musicVolume: 0.35,
    fadeInSeconds: 1,
    fadeOutSeconds: 2,
    musicSignature: deriveMusicSignature(project)
  };
}

describe('render status helpers', () => {
  it('marks scene as not rendered when no artifact exists', () => {
    const project = createProject();
    const renderPlan = resolveRenderPlan(project);
    const status = deriveSceneRenderStatus(project, project.scenes[0], renderPlan);
    expect(status.status).toBe('not_rendered');
  });

  it('marks scene as rendered when latest completed render matches current fingerprint', () => {
    const project = attachCurrentRender(createProject(), 'scene-1');
    const renderPlan = resolveRenderPlan(project);
    const status = deriveSceneRenderStatus(project, project.scenes[0], renderPlan);
    expect(status.status).toBe('rendered');
  });

  it('marks scene as stale after visual scene changes', () => {
    const project = attachCurrentRender(createProject(), 'scene-1');
    project.scenes[0].overlay = { type: 'callout', text: 'Changed', position: 'bottom' };
    const renderPlan = resolveRenderPlan(project);
    const status = deriveSceneRenderStatus(project, project.scenes[0], renderPlan);
    expect(status.status).toBe('stale');
  });

  it('marks scene as render_failed when latest artifact failed', () => {
    const project = createProject();
    project.scenes[0].renders = [{
      renderId: 'render-failed',
      outputPath: 'renders/scene-1-failed.mp4',
      createdAt: new Date().toISOString(),
      width: 1280,
      height: 720,
      fps: 30,
      duration: 2,
      filesize: 0,
      mimeType: 'video/mp4',
      renderer: 'ffmpeg',
      status: 'failed',
      message: 'boom'
    }];
    const renderPlan = resolveRenderPlan(project);
    const status = deriveSceneRenderStatus(project, project.scenes[0], renderPlan);
    expect(status.status).toBe('render_failed');
  });

  it('derives composition readiness and stale final composition after scene changes', () => {
    const project = attachCurrentRender(attachCurrentRender(createProject(), 'scene-1'), 'scene-2');
    project.compositions = [{
      compositionId: 'composition-1',
      projectId: project.id,
      outputPath: 'renders/compositions/final-composition-1.mp4',
      createdAt: new Date().toISOString(),
      sceneIds: ['scene-1', 'scene-2'],
      duration: 4,
      width: 1280,
      height: 720,
      fps: 30,
      renderer: 'ffmpeg',
      version: 'p8-test',
      filesize: 100,
      mimeType: 'video/mp4',
      transition: { type: 'none' }
    }];

    let renderPlan = resolveRenderPlan(project);
    let readiness = deriveCompositionReadiness(project, renderPlan);
    expect(readiness.canCompose).toBe(true);
    expect(readiness.needsSceneRenderIds).toHaveLength(0);
    expect(deriveCompositionArtifactStatus(project, renderPlan).status).toBe('current');

    project.scenes[1].overlay = { type: 'callout', text: 'Updated', position: 'bottom' };
    renderPlan = resolveRenderPlan(project);
    readiness = deriveCompositionReadiness(project, renderPlan);
    expect(readiness.staleSceneIds).toEqual(['scene-2']);
    expect(deriveCompositionArtifactStatus(project, renderPlan).status).toBe('stale');
  });

  it('treats non-renderable scenes as blocking for composition', () => {
    const project = createProject();
    project.scenes[0].visual = { kind: 'asset' };
    const renderPlan = resolveRenderPlan(project);
    const readiness = deriveCompositionReadiness(project, renderPlan);
    expect(readiness.canCompose).toBe(false);
    expect(readiness.blockingSceneIds).toContain('scene-1');
  });

  it('treats invalid linked narration audio as composition blocking while keeping scene render state independent', () => {
    const project = attachCurrentRender(createProject(), 'scene-1');
    project.scenes[0].narration = {
      text: 'hello',
      status: 'generated',
      audioAssetId: 'missing-audio'
    };

    const renderPlan = resolveRenderPlan(project);
    const readiness = deriveCompositionReadiness(project, renderPlan);
    const sceneStatus = deriveSceneRenderStatus(project, project.scenes[0], renderPlan);

    expect(readiness.canCompose).toBe(false);
    expect(readiness.invalidNarrationAudioSceneIds).toContain('scene-1');
    expect(sceneStatus.status).toBe('rendered');
  });

  it('marks composition stale when narration inputs changed after composition creation', () => {
    const project = attachCurrentRender(attachCurrentRender(createProject(), 'scene-1'), 'scene-2');

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
        prompt: 'hello',
        referenceIds: []
      },
      createdAt: new Date().toISOString()
    });

    project.scenes[0].narration = {
      text: 'hello',
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

    project.compositions = [{
      compositionId: 'composition-1',
      projectId: project.id,
      outputPath: 'renders/compositions/final-composition-1.mp4',
      createdAt: new Date().toISOString(),
      sceneIds: ['scene-1', 'scene-2'],
      inputFingerprint: {
        version: 'p10.1',
        scenes: [
          {
            sceneId: 'scene-1',
            renderId: 'render-scene-1',
            narrationSignature: 'text:hello|voice:voice-a|model:model-a|format:mp3|asset:audio-1'
          },
          {
            sceneId: 'scene-2',
            renderId: 'render-scene-2',
            narrationSignature: 'text:world|voice:|model:|format:|asset:'
          }
        ]
      },
      duration: 4,
      width: 1280,
      height: 720,
      fps: 30,
      renderer: 'ffmpeg',
      version: 'p10.1-test',
      filesize: 100,
      mimeType: 'video/mp4',
      transition: { type: 'none' }
    }];

    let renderPlan = resolveRenderPlan(project);
    expect(deriveCompositionArtifactStatus(project, renderPlan).status).toBe('current');

    project.scenes[0].narration!.text = 'updated';
    renderPlan = resolveRenderPlan(project);
    const compositionStatus = deriveCompositionArtifactStatus(project, renderPlan);

    expect(compositionStatus.status).toBe('stale');
    expect(compositionStatus.reasons.some((reason) => reason.includes('narration'))).toBe(true);
  });

  it('marks composition stale when audio mix settings change after composition creation', () => {
    const project = attachCurrentRender(attachCurrentRender(createProject(), 'scene-1'), 'scene-2');

    project.compositions = [{
      compositionId: 'composition-1',
      projectId: project.id,
      outputPath: 'renders/compositions/final-composition-1.mp4',
      createdAt: new Date().toISOString(),
      sceneIds: ['scene-1', 'scene-2'],
      inputFingerprint: {
        version: 'p10.1',
        audioMix: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
        scenes: [
          {
            sceneId: 'scene-1',
            renderId: 'render-scene-1',
            narrationSignature: 'text:hello|voice:|model:|format:|asset:'
          },
          {
            sceneId: 'scene-2',
            renderId: 'render-scene-2',
            narrationSignature: 'text:world|voice:|model:|format:|asset:'
          }
        ]
      },
      duration: 4,
      width: 1280,
      height: 720,
      fps: 30,
      renderer: 'ffmpeg',
      version: 'p10.1-test',
      filesize: 100,
      mimeType: 'video/mp4',
      transition: { type: 'none' }
    }];

    let renderPlan = resolveRenderPlan(project);
    expect(deriveCompositionArtifactStatus(project, renderPlan).status).toBe('current');

    project.renderSettings.audio = { narrationVolume: 0.4, musicVolume: 0.35, effectsVolume: 0.2 };
    renderPlan = resolveRenderPlan(project);
    const compositionStatus = deriveCompositionArtifactStatus(project, renderPlan);

    expect(compositionStatus.status).toBe('stale');
    expect(compositionStatus.reasons.some((reason) => reason.includes('Audio mix'))).toBe(true);
  });

  it('treats legacy compositions without audioMix as default and marks them stale on mix change', () => {
    const project = attachCurrentRender(attachCurrentRender(createProject(), 'scene-1'), 'scene-2');

    project.compositions = [{
      compositionId: 'composition-legacy',
      projectId: project.id,
      outputPath: 'renders/compositions/final-legacy.mp4',
      createdAt: new Date().toISOString(),
      sceneIds: ['scene-1', 'scene-2'],
      inputFingerprint: {
        version: 'p10.1',
        scenes: [
          {
            sceneId: 'scene-1',
            renderId: 'render-scene-1',
            narrationSignature: 'text:hello|voice:|model:|format:|asset:'
          },
          {
            sceneId: 'scene-2',
            renderId: 'render-scene-2',
            narrationSignature: 'text:world|voice:|model:|format:|asset:'
          }
        ]
      },
      duration: 4,
      width: 1280,
      height: 720,
      fps: 30,
      renderer: 'ffmpeg',
      version: 'p10.1-test',
      filesize: 100,
      mimeType: 'video/mp4',
      transition: { type: 'none' }
    }];

    let renderPlan = resolveRenderPlan(project);
    expect(deriveCompositionArtifactStatus(project, renderPlan).status).toBe('current');

    project.renderSettings.audio = { narrationVolume: 0.5, musicVolume: 0.35, effectsVolume: 0.2 };
    renderPlan = resolveRenderPlan(project);
    const status = deriveCompositionArtifactStatus(project, renderPlan);

    expect(status.status).toBe('stale');
    expect(status.reasons.some((reason) => reason.includes('Audio mix'))).toBe(true);
  });

  it('marks composition stale when background music is added after composition creation', () => {
    const project = attachCurrentRender(attachCurrentRender(createProject(), 'scene-1'), 'scene-2');
    attachComposition(project);

    let renderPlan = resolveRenderPlan(project);
    expect(deriveCompositionArtifactStatus(project, renderPlan).status).toBe('current');

    const asset = createMusicAsset('music-1');
    project.assets.push(asset);
    project.music = { assetId: asset.id, status: 'generated' };
    renderPlan = resolveRenderPlan(project);
    const status = deriveCompositionArtifactStatus(project, renderPlan);

    expect(status.status).toBe('stale');
    expect(status.reasons.some((reason) => reason.includes('Background music'))).toBe(true);
  });

  it('keeps composition current when the recorded music fingerprint matches', () => {
    const project = attachCurrentRender(attachCurrentRender(createProject(), 'scene-1'), 'scene-2');
    const asset = createMusicAsset('music-1');
    project.assets.push(asset);
    project.music = { assetId: asset.id, status: 'generated' };
    attachComposition(project, musicFingerprint(project));

    const renderPlan = resolveRenderPlan(project);
    expect(deriveCompositionArtifactStatus(project, renderPlan).status).toBe('current');
  });

  it('marks composition stale when the music volume changes after composition creation', () => {
    const project = attachCurrentRender(attachCurrentRender(createProject(), 'scene-1'), 'scene-2');
    const asset = createMusicAsset('music-1');
    project.assets.push(asset);
    project.music = { assetId: asset.id, status: 'generated' };
    attachComposition(project, musicFingerprint(project));

    let renderPlan = resolveRenderPlan(project);
    expect(deriveCompositionArtifactStatus(project, renderPlan).status).toBe('current');

    project.renderSettings.audio = { narrationVolume: 1, musicVolume: 0.6, effectsVolume: 0.2 };
    renderPlan = resolveRenderPlan(project);
    const status = deriveCompositionArtifactStatus(project, renderPlan);

    expect(status.status).toBe('stale');
    expect(status.reasons.some((reason) => reason.includes('Background music'))).toBe(true);
  });

  it('marks composition stale when the selected track is replaced', () => {
    const project = attachCurrentRender(attachCurrentRender(createProject(), 'scene-1'), 'scene-2');
    const first = createMusicAsset('music-1');
    project.assets.push(first);
    project.music = { assetId: first.id, status: 'generated' };
    attachComposition(project, musicFingerprint(project));

    const second = createMusicAsset('music-2');
    project.assets.push(second);
    project.music = { assetId: second.id, status: 'generated' };
    const renderPlan = resolveRenderPlan(project);
    const status = deriveCompositionArtifactStatus(project, renderPlan);

    expect(status.status).toBe('stale');
    expect(status.reasons.some((reason) => reason.includes('Background music'))).toBe(true);
  });

  it('marks composition stale when background music is removed', () => {
    const project = attachCurrentRender(attachCurrentRender(createProject(), 'scene-1'), 'scene-2');
    const asset = createMusicAsset('music-1');
    project.assets.push(asset);
    project.music = { assetId: asset.id, status: 'generated' };
    attachComposition(project, musicFingerprint(project));

    project.music = undefined;
    const renderPlan = resolveRenderPlan(project);
    const status = deriveCompositionArtifactStatus(project, renderPlan);

    expect(status.status).toBe('stale');
    expect(status.reasons.some((reason) => reason.includes('Background music'))).toBe(true);
  });
});
