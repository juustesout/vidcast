import { describe, expect, it } from 'vitest';

import { deriveProductionPlan } from '@/lib/production/production-planner';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { Project } from '@/lib/types/render';

function createProject(): Project {
  const now = new Date().toISOString();
  return normalizeProject({
    id: 'project-production-plan',
    title: 'Production Plan',
    description: 'desc',
    durationTarget: 45,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 5,
        type: 'image',
        narration: { text: 'Scene one narration', status: 'planned', voiceId: 'v1', model: 'm1', format: 'mp3' },
        visual: {
          kind: 'generated_image',
          generation: {
            id: 'gen-1',
            kind: 'image',
            status: 'planned',
            provider: 'openai',
            prompt: 'Prompt 1',
            referenceIds: [],
            aspectRatio: '16:9',
            createdAt: now
          }
        },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      },
      {
        id: 'scene-2',
        order: 2,
        duration: 5,
        type: 'video',
        narration: { text: 'Scene two narration', status: 'planned', voiceId: 'v1', model: 'm1', format: 'mp3' },
        visual: {
          kind: 'generated_video',
          generation: {
            id: 'gen-2',
            kind: 'video',
            status: 'generating',
            provider: 'openai',
            prompt: 'Prompt 2',
            referenceIds: [],
            aspectRatio: '16:9',
            providerJobId: 'job-2',
            createdAt: now
          }
        },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ],
    assets: [],
    references: [],
    compositions: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    }
  });
}

describe('deriveProductionPlan', () => {
  it('marks current outputs as current and skips resubmission of running video', () => {
    const project = createProject();
    const plan = deriveProductionPlan(project);

    const runningSubmit = plan.actions.find((entry) => entry.id === 'scene:scene-2:video_submit');
    const pollAction = plan.actions.find((entry) => entry.id === 'scene:scene-2:video_poll');

    expect(runningSubmit?.status).toBe('running');
    expect(runningSubmit?.execute).toBe(false);
    expect(pollAction?.status).toBe('ready');
    expect(pollAction?.execute).toBe(true);
  });

  it('blocks scene render when required generated visual output is not yet available', () => {
    const project = createProject();
    const plan = deriveProductionPlan(project);

    const renderAction = plan.actions.find((entry) => entry.id === 'scene:scene-1:scene_render');
    expect(renderAction?.status).toBe('blocked');
  });

  it('schedules stale scene render and blocks composition until dependencies are current', () => {
    const project = createProject();

    project.scenes[0].visual = { kind: 'blank' };
    const plan = resolveRenderPlan(project);
    const scenePlan = plan.scenes.find((entry) => entry.sceneId === 'scene-1')!;
    project.scenes[0].renders = [{
      renderId: 'render-1',
      outputPath: 'renders/scene-1.mp4',
      createdAt: new Date().toISOString(),
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      duration: project.scenes[0].duration,
      filesize: 100,
      mimeType: 'video/mp4',
      renderer: 'ffmpeg',
      status: 'completed',
      renderFingerprint: createSceneRenderFingerprint(plan, scenePlan)
    }];

    project.scenes[0].overlay = { type: 'callout', text: 'Changed', position: 'bottom' };

    const derived = deriveProductionPlan(project);
    const renderAction = derived.actions.find((entry) => entry.id === 'scene:scene-1:scene_render');
    const composeAction = derived.actions.find((entry) => entry.id === 'project:final_compose');

    expect(renderAction?.status).toBe('ready');
    expect(composeAction?.status).toBe('blocked');
  });

  it('marks current narration as current and stale narration as ready to regenerate', () => {
    const project = createProject();

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
      metadata: { voiceId: 'v1' },
      generation: {
        generationId: 'attempt-1',
        provider: 'elevenlabs',
        model: 'm1',
        prompt: 'Scene one narration',
        referenceIds: []
      },
      createdAt: new Date().toISOString()
    });

    project.scenes[0].narration = {
      text: 'Scene one narration',
      status: 'generated',
      voiceId: 'v1',
      model: 'm1',
      format: 'mp3',
      audioAssetId: 'audio-1',
      attempts: [{
        id: 'attempt-1',
        status: 'generated',
        provider: 'elevenlabs',
        voiceId: 'v1',
        model: 'm1',
        format: 'mp3',
        createdAt: new Date().toISOString()
      }]
    };

    project.scenes[1].narration = {
      text: 'Scene two narration updated',
      status: 'generated',
      voiceId: 'v1',
      model: 'm1',
      format: 'mp3',
      audioAssetId: 'audio-1',
      attempts: [{
        id: 'attempt-2',
        status: 'generated',
        provider: 'elevenlabs',
        voiceId: 'v1',
        model: 'm1',
        format: 'mp3',
        createdAt: new Date().toISOString()
      }]
    };

    const derived = deriveProductionPlan(project);
    expect(derived.actions.find((entry) => entry.id === 'scene:scene-1:narration_generate')?.status).toBe('current');
    expect(derived.actions.find((entry) => entry.id === 'scene:scene-2:narration_generate')?.status).toBe('ready');
    expect(derived.actions.find((entry) => entry.id === 'scene:scene-2:narration_generate')?.payload?.mode).toBe('regenerate');
  });
});
