import { describe, expect, it } from 'vitest';

import { deriveWorkflowStatus } from '@/lib/workflow/workflow-status';
import { normalizeProject } from '@/lib/projects/normalize-project';
import type { Project } from '@/lib/types/render';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';

function baseProject(): Project {
  const now = new Date().toISOString();
  return normalizeProject({
    id: 'workflow-project',
    title: 'Workflow Project',
    description: 'desc',
    durationTarget: 45,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    explainer: {
      brief: {
        topic: '',
        goal: '',
        audience: '',
        tone: '',
        targetDurationSeconds: 45,
        notes: ''
      },
      story: {
        title: 'Workflow Project',
        hook: '',
        script: '',
        beats: [],
        cta: '',
        notes: '',
        versions: []
      },
      sceneIntents: []
    },
    scenes: [],
    assets: [],
    references: [],
    compositions: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: {
        narrationVolume: 1,
        musicVolume: 0.35,
        effectsVolume: 0.2
      },
      subtitlesEnabled: true
    }
  });
}

function addNarratedBlankScene(project: Project, id: string, order: number) {
  project.scenes.push({
    id,
    order,
    duration: 5,
    type: 'blank',
    narration: { text: 'Narration text' },
    visual: { kind: 'blank' },
    render: {
      motion: { preset: 'none' },
      transition: { type: 'fade' }
    },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: ''
  });
}

describe('deriveWorkflowStatus', () => {
  it('empty project reports early blockers', () => {
    const workflow = deriveWorkflowStatus(baseProject());

    expect(workflow.steps.find((step) => step.id === 'brief')?.status).toBe('needs_attention');
    expect(workflow.steps.find((step) => step.id === 'story')?.status).toBe('blocked');
    expect(workflow.steps.find((step) => step.id === 'scenes')?.status).toBe('blocked');
    expect(workflow.recommendedStepId).toBe('brief');
  });

  it('brief complete updates brief step to complete', () => {
    const project = baseProject();
    project.explainer!.brief.topic = 'Topic';
    project.explainer!.brief.goal = 'Goal';
    project.explainer!.brief.audience = 'Audience';
    project.explainer!.brief.tone = 'Tone';

    const workflow = deriveWorkflowStatus(project);
    expect(workflow.steps.find((step) => step.id === 'brief')?.status).toBe('complete');
  });

  it('story with script but no beats is ready and scene plan blocked', () => {
    const project = baseProject();
    project.explainer!.story.script = 'Script text';

    const workflow = deriveWorkflowStatus(project);
    expect(workflow.steps.find((step) => step.id === 'story')?.status).toBe('ready');
    expect(workflow.steps.find((step) => step.id === 'scene_plan')?.status).toBe('blocked');
  });

  it('beats with unapproved intents need attention in scene plan', () => {
    const project = baseProject();
    project.explainer!.story.script = 'Script text';
    project.explainer!.story.beats = [{ id: 'beat-1', order: 1, text: 'Beat 1' }];
    project.explainer!.sceneIntents = [{
      id: 'intent-1',
      order: 1,
      beatIds: ['beat-1'],
      label: 'Intent',
      narrativeRole: 'hook',
      visualIntent: '',
      narrationDraft: 'Beat 1',
      timing: { durationSeconds: 5 },
      notes: '',
      status: 'draft'
    }];

    const workflow = deriveWorkflowStatus(project);
    expect(workflow.steps.find((step) => step.id === 'scene_plan')?.status).toBe('needs_attention');
  });

  it('approved intents and partial materialization keep scenes step actionable', () => {
    const project = baseProject();
    project.explainer!.story.script = 'Script text';
    project.explainer!.story.beats = [
      { id: 'beat-1', order: 1, text: 'Beat 1' },
      { id: 'beat-2', order: 2, text: 'Beat 2' }
    ];
    project.explainer!.sceneIntents = [
      {
        id: 'intent-1',
        order: 1,
        beatIds: ['beat-1'],
        label: 'Intent 1',
        narrativeRole: 'hook',
        visualIntent: '',
        narrationDraft: 'Beat 1',
        timing: { durationSeconds: 5 },
        notes: '',
        status: 'approved',
        materializedSceneId: 'scene-1'
      },
      {
        id: 'intent-2',
        order: 2,
        beatIds: ['beat-2'],
        label: 'Intent 2',
        narrativeRole: 'explanation',
        visualIntent: '',
        narrationDraft: 'Beat 2',
        timing: { durationSeconds: 5 },
        notes: '',
        status: 'approved'
      }
    ];

    addNarratedBlankScene(project, 'scene-1', 1);

    const workflow = deriveWorkflowStatus(project);
    expect(workflow.steps.find((step) => step.id === 'scene_plan')?.status).toBe('complete');
    expect(workflow.steps.find((step) => step.id === 'scenes')?.status).toBe('complete');
  });

  it('missing narration text marks narration as needs_attention', () => {
    const project = baseProject();
    addNarratedBlankScene(project, 'scene-1', 1);
    project.scenes[0].narration = { text: '' };

    const workflow = deriveWorkflowStatus(project);
    expect(workflow.steps.find((step) => step.id === 'narration')?.status).toBe('needs_attention');
  });

  it('missing renders marks preview as needs_attention', () => {
    const project = baseProject();
    addNarratedBlankScene(project, 'scene-1', 1);

    const workflow = deriveWorkflowStatus(project);
    expect(workflow.steps.find((step) => step.id === 'preview')?.status).toBe('needs_attention');
  });

  it('stale scene render and stale composition are reflected in preview/final render', () => {
    const project = baseProject();
    addNarratedBlankScene(project, 'scene-1', 1);

    const plan = resolveRenderPlan(project);
    const scenePlan = plan.scenes[0];

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

    project.scenes[0].duration = 7;

    project.compositions = [{
      compositionId: 'composition-1',
      projectId: project.id,
      outputPath: 'compositions/final.mp4',
      createdAt: new Date().toISOString(),
      sceneIds: ['scene-1'],
      duration: 5,
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      renderer: 'ffmpeg',
      version: 'p7',
      filesize: 200,
      mimeType: 'video/mp4',
      transition: { type: 'none' }
    }];

    const workflow = deriveWorkflowStatus(project);
    expect(workflow.steps.find((step) => step.id === 'preview')?.status).toBe('needs_attention');
    expect(workflow.steps.find((step) => step.id === 'final_render')?.status).toBe('needs_attention');
  });

  it('detects beat to intent advisory and intent to scene advisory when state differs', () => {
    const project = baseProject();
    project.explainer!.story.script = 'Script';
    project.explainer!.story.beats = [{ id: 'beat-1', order: 1, text: 'Beat canonical text' }];
    project.explainer!.sceneIntents = [{
      id: 'intent-1',
      order: 1,
      beatIds: ['beat-1'],
      label: 'Intent 1',
      narrativeRole: 'hook',
      visualIntent: 'Visual intent',
      narrationDraft: 'Different draft text',
      timing: { durationSeconds: 5 },
      notes: '',
      status: 'approved',
      materializedSceneId: 'scene-1'
    }];

    addNarratedBlankScene(project, 'scene-1', 1);
    project.scenes[0].narration = { text: 'Another text' };

    const workflow = deriveWorkflowStatus(project);
    expect(workflow.advisories.some((entry) => entry.kind === 'beat_to_intent')).toBe(true);
    expect(workflow.advisories.some((entry) => entry.kind === 'intent_to_scene')).toBe(true);
  });

  it('fully production-ready project marks final render complete', () => {
    const project = baseProject();
    project.explainer!.brief.topic = 'Topic';
    project.explainer!.brief.goal = 'Goal';
    project.explainer!.brief.audience = 'Audience';
    project.explainer!.brief.tone = 'Tone';
    project.explainer!.story.script = 'Script';
    project.explainer!.story.beats = [{ id: 'beat-1', order: 1, text: 'Beat 1' }];
    project.explainer!.sceneIntents = [{
      id: 'intent-1',
      order: 1,
      beatIds: ['beat-1'],
      label: 'Intent 1',
      narrativeRole: 'hook',
      visualIntent: '',
      narrationDraft: 'Narration text',
      timing: { durationSeconds: 5 },
      notes: '',
      status: 'approved',
      materializedSceneId: 'scene-1'
    }];

    addNarratedBlankScene(project, 'scene-1', 1);

    const plan = resolveRenderPlan(project);
    const scenePlan = plan.scenes[0];
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

    project.compositions = [{
      compositionId: 'composition-1',
      projectId: project.id,
      outputPath: 'compositions/final.mp4',
      createdAt: new Date().toISOString(),
      sceneIds: ['scene-1'],
      duration: 5,
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      renderer: 'ffmpeg',
      version: 'p7',
      filesize: 200,
      mimeType: 'video/mp4',
      transition: { type: 'none' }
    }];

    const workflow = deriveWorkflowStatus(project);
    expect(workflow.steps.find((step) => step.id === 'final_render')?.status).toBe('complete');
  });

  it('surfaces narration failure state in workflow narration step', () => {
    const project = baseProject();
    addNarratedBlankScene(project, 'scene-1', 1);

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
        prompt: 'Old text',
        referenceIds: []
      },
      createdAt: new Date().toISOString()
    });

    project.scenes[0].narration = {
      text: 'New text',
      status: 'failed',
      voiceId: 'voice-a',
      model: 'model-a',
      format: 'mp3',
      audioAssetId: 'audio-1',
      error: 'provider failed',
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

    const workflow = deriveWorkflowStatus(project);
    const narrationStep = workflow.steps.find((step) => step.id === 'narration');

    expect(narrationStep?.status).toBe('needs_attention');
    expect(narrationStep?.warnings.some((entry) => entry.includes('narration generation attempt'))).toBe(true);
  });

  it('surfaces narration needs-regeneration state in workflow narration step', () => {
    const project = baseProject();
    addNarratedBlankScene(project, 'scene-1', 1);

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
        prompt: 'Old text',
        referenceIds: []
      },
      createdAt: new Date().toISOString()
    });

    project.scenes[0].narration = {
      text: 'New text',
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

    const workflow = deriveWorkflowStatus(project);
    const narrationStep = workflow.steps.find((step) => step.id === 'narration');

    expect(narrationStep?.status).toBe('needs_attention');
    expect(narrationStep?.warnings.some((entry) => entry.includes('need narration regeneration'))).toBe(true);
  });

  it('surfaces generation running/failed in visuals step', () => {
    const project = baseProject();
    addNarratedBlankScene(project, 'scene-1', 1);
    project.scenes[0].type = 'image';
    project.scenes[0].visual = {
      kind: 'generated_image',
      generation: {
        id: 'gen-1',
        kind: 'image',
        status: 'failed',
        provider: 'openai',
        prompt: 'Prompt',
        referenceIds: [],
        aspectRatio: '16:9',
        createdAt: new Date().toISOString(),
        error: 'boom'
      }
    };

    const workflow = deriveWorkflowStatus(project);
    const visualsStep = workflow.steps.find((step) => step.id === 'visuals');

    expect(visualsStep?.status).toBe('needs_attention');
    expect(visualsStep?.warnings.some((entry) => entry.includes('failed'))).toBe(true);
  });

  it('surfaces transient running and failed composition state in final render step', () => {
    const project = baseProject();
    addNarratedBlankScene(project, 'scene-1', 1);

    const plan = resolveRenderPlan(project);
    const scenePlan = plan.scenes[0];
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

    const running = deriveWorkflowStatus(project, { composing: true });
    const failed = deriveWorkflowStatus(project, { compositionFailed: true });

    expect(running.steps.find((step) => step.id === 'final_render')?.warnings.some((entry) => entry.includes('running'))).toBe(true);
    expect(failed.steps.find((step) => step.id === 'final_render')?.warnings.some((entry) => entry.includes('failed'))).toBe(true);
    expect(failed.steps.find((step) => step.id === 'final_render')?.nextAction.label).toContain('Retry');
  });
});
