import { describe, expect, it } from 'vitest';

import { deriveProductionPlanReport } from '@/lib/production/production-plan-report';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { Project } from '@/lib/types/render';

function createProject(): Project {
  const now = new Date().toISOString();
  return normalizeProject({
    id: 'project-plan-report',
    title: 'Production Plan Report',
    description: 'desc',
    durationTarget: 40,
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
        narration: { text: '' },
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
        type: 'blank',
        narration: { text: 'Narration for scene 2', status: 'planned', voiceId: 'voice-2', model: 'model-2', format: 'mp3' },
        visual: { kind: 'blank' },
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

describe('deriveProductionPlanReport', () => {
  it('returns compact plan data with grouped actions and derived flags', () => {
    const project = createProject();
    const report = deriveProductionPlanReport(project);

    expect(report.projectId).toBe(project.id);
    expect(Array.isArray(report.plan.actions)).toBe(true);
    expect(report.plan.summary.ready).toBeGreaterThanOrEqual(1);
    expect(report.groupedByScene.length).toBe(2);
    expect(typeof report.derivedFlags.hasBlockingActions).toBe('boolean');
    expect(typeof report.derivedFlags.hasWaitingDependencies).toBe('boolean');
    expect(typeof report.derivedFlags.readyActionCount).toBe('number');
  });

  it('captures no_narration and no_audio narration scenarios in action states', () => {
    const project = createProject();

    const scene1Narration = deriveProductionPlanReport(project).plan.actions.find((entry) => entry.id === 'scene:scene-1:narration_generate');
    expect(scene1Narration?.status).toBe('blocked');

    project.scenes[0].narration = {
      text: 'Narration scene 1',
      status: 'planned',
      voiceId: 'voice-1',
      model: 'model-1',
      format: 'mp3'
    };

    const scene1NoAudio = deriveProductionPlanReport(project).plan.actions.find((entry) => entry.id === 'scene:scene-1:narration_generate');
    expect(scene1NoAudio?.status).toBe('ready');
    expect(scene1NoAudio?.payload?.mode).toBe('generate');
  });

  it('adds final compose dependencies for multiple stale scene renders', () => {
    const project = createProject();

    project.scenes[0].visual = { kind: 'blank' };
    project.scenes[0].narration = {
      text: 'Narration for scene 1',
      status: 'planned',
      voiceId: 'voice-1',
      model: 'model-1',
      format: 'mp3'
    };

    attachCurrentRender(project, 'scene-1');
    attachCurrentRender(project, 'scene-2');

    project.scenes[0].duration = 6;
    project.scenes[1].duration = 6;

    const report = deriveProductionPlanReport(project);
    const compose = report.plan.actions.find((entry) => entry.id === 'project:final_compose');

    expect(compose).toBeDefined();
    expect(compose?.status).toBe('waiting_dependency');
    expect(compose?.dependencyActionIds).toEqual(
      expect.arrayContaining(['scene:scene-1:scene_render', 'scene:scene-2:scene_render'])
    );
    expect(report.derivedFlags.hasWaitingDependencies).toBe(true);
  });

  it('is deterministic for action ids, statuses and dependencies when project state is unchanged', () => {
    const project = createProject();

    const first = deriveProductionPlanReport(project);
    const second = deriveProductionPlanReport(project);

    const pick = (report: ReturnType<typeof deriveProductionPlanReport>) =>
      report.plan.actions.map((entry) => ({
        id: entry.id,
        status: entry.status,
        deps: entry.dependencyActionIds
      }));

    expect(pick(first)).toEqual(pick(second));
    expect(first.plan.summary).toEqual(second.plan.summary);
  });
});
