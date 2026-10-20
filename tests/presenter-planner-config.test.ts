import { describe, expect, it } from 'vitest';

import {
  evaluatePresenterBudget,
  evaluatePresenterChargeBudget,
  isPresenterClipCurrent,
  normalizeProjectPresenter,
  derivePresenterSignature
} from '@/lib/presenter/config';
import { deriveProductionPlan } from '@/lib/production/production-planner';
import { createStudioComposition } from '@/lib/render/scene-composition';
import type { Asset } from '@/lib/types/asset';
import type { PresenterClipAttempt, PresenterClipSpec } from '@/lib/types/presenter';
import type { Project } from '@/lib/types/render';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { validateProject } from '@/lib/validation/project-validation';

const CREATED = '2026-01-01T00:00:00.000Z';

function audioAsset(): Asset {
  return {
    id: 'audio-1',
    type: 'audio',
    status: 'available',
    provenance: 'generated',
    filename: 'narration.wav',
    localPath: 'assets/narration.wav',
    mimeType: 'audio/wav',
    duration: 2,
    metadata: { voiceId: 'voice-1' },
    generation: { model: 'model-1', prompt: 'Hello world', referenceIds: [] },
    createdAt: CREATED,
    updatedAt: CREATED
  };
}

function presenterAsset(): Asset {
  return {
    id: 'presenter-1',
    type: 'video',
    status: 'available',
    provenance: 'generated',
    filename: 'presenter.mp4',
    localPath: 'assets/presenter.mp4',
    mimeType: 'video/mp4',
    duration: 2,
    metadata: {},
    createdAt: CREATED,
    updatedAt: CREATED
  };
}

const CURRENT_NARRATION_SIGNATURE = 'text:Hello world|voice:voice-1|model:model-1|format:wav|asset:audio-1';

function baseProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-presenter',
    title: 'Presenter test',
    description: '',
    durationTarget: 10,
    aspectRatio: '16:9',
    fps: 30,
    narration: { text: '', segments: [] },
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 2,
        type: 'text',
        visual: { kind: 'text', text: 'Hello world' },
        narration: {
          text: 'Hello world',
          voiceId: 'voice-1',
          model: 'model-1',
          format: 'wav',
          audioAssetId: 'audio-1',
          status: 'generated',
          duration: 2,
          attempts: [
            {
              id: 'narration-1',
              status: 'generated',
              provider: 'fake',
              model: 'model-1',
              voiceId: 'voice-1',
              format: 'wav',
              audioAssetId: 'audio-1',
              createdAt: CREATED
            }
          ]
        },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: '',
        renders: []
      }
    ],
    assets: [audioAsset()],
    references: [],
    compositions: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides
  };
}

function presenterProject(overrides: Partial<Project> = {}): Project {
  return baseProject({
    presenter: {
      enabled: true,
      provider: 'mock',
      outputFormat: 'mp4',
      sceneSettings: [{ sceneId: 'scene-1', layout: 'pip' }],
      maxGeneratedSeconds: 20,
      maxPaidRequests: 1
    },
    ...overrides
  });
}

function attempt(overrides: Partial<PresenterClipAttempt> = {}): PresenterClipAttempt {
  return {
    id: 'presenter-attempt-1',
    status: 'generating',
    provider: 'heygen',
    providerJobId: 'job-1',
    outputFormat: 'mp4',
    audioAssetId: 'audio-1',
    narrationSignature: '',
    duration: 2,
    createdAt: CREATED,
    ...overrides
  };
}

function clip(overrides: Partial<PresenterClipSpec> = {}): PresenterClipSpec {
  return {
    sceneId: 'scene-1',
    status: 'planned',
    lastAttemptId: 'presenter-attempt-1',
    provider: 'mock',
    outputFormat: 'mp4',
    audioAssetId: 'audio-1',
    narrationSignature: '',
    duration: 2,
    ...overrides
  };
}

function currentClip(overrides: Partial<PresenterClipSpec> = {}): PresenterClipSpec {
  return clip({
    status: 'generated',
    assetId: 'presenter-1',
    audioAssetId: 'audio-1',
    narrationSignature: CURRENT_NARRATION_SIGNATURE,
    outputFormat: 'mp4',
    ...overrides
  });
}

function projectWithCurrentClip(overrides: Partial<Project> = {}): Project {
  return presenterProject({
    assets: [audioAsset(), presenterAsset()],
    presenterClips: [currentClip()],
    ...overrides
  });
}

describe('presenter config', () => {
  it('normalizes and clamps presenter settings', () => {
    const normalized = normalizeProjectPresenter({
      enabled: true,
      provider: 'fake',
      outputFormat: 'webm',
      sceneSettings: [
        { sceneId: ' scene-1 ', layout: 'pip', pip: { position: 'top_left', widthRatio: 2, marginRatio: 9 }, startOffsetSeconds: 1 },
        { sceneId: 'scene-1', layout: 'fullscreen' },
        { sceneId: 'scene-2', layout: 'nope' }
      ],
      maxGeneratedSeconds: 10_000,
      maxPaidRequests: 100
    });

    expect(normalized).toMatchObject({
      enabled: true,
      provider: 'mock',
      outputFormat: 'webm',
      maxPaidRequests: 5
    });
    expect(normalized?.sceneSettings).toHaveLength(1);
    expect(normalized?.sceneSettings[0]).toMatchObject({
      sceneId: 'scene-1',
      layout: 'pip',
      startOffsetSeconds: 1
    });
    expect(normalized?.sceneSettings[0].pip?.widthRatio).toBeCloseTo(0.55);
    expect(normalized?.sceneSettings[0].pip?.marginRatio).toBeCloseTo(0.08);
  });

  it('preserves legacy projects without presenter settings', () => {
    expect(normalizeProjectPresenter(undefined)).toBeUndefined();
    expect(normalizeProject(baseProject()).presenter).toBeUndefined();
  });

  it('changes the composition signature when presenter settings change', () => {
    const off = baseProject();
    const on = presenterProject();
    expect(derivePresenterSignature(off)).toBe('presenter:off');
    expect(derivePresenterSignature(on)).not.toBe('presenter:off');
  });

  it('projects and enforces paid presenter budgets', () => {
    const project = presenterProject({
      presenter: {
        enabled: true,
        provider: 'heygen',
        avatarId: 'avatar-1',
        sceneSettings: [{ sceneId: 'scene-1', layout: 'fullscreen' }],
        maxGeneratedSeconds: 5,
        maxPaidRequests: 1
      },
      presenterClips: [clip({ provider: 'heygen', status: 'failed', attempts: [attempt({ status: 'failed' })] })]
    });

    const projected = evaluatePresenterBudget(project);
    expect(projected.exceeded).toBe(true);
    expect(projected.paidRequests).toBe(1);

    const charge = evaluatePresenterChargeBudget(project, { seconds: 2 });
    expect(charge.allowed).toBe(false);
  });

  it('treats a generated MP4 clip as current only for an MP4 request', () => {
    const project = projectWithCurrentClip();
    expect(isPresenterClipCurrent(project, project.scenes[0], currentClip())).toBe(true);
  });

  it('does not treat an existing MP4 clip as current for a WebM request', () => {
    const project = projectWithCurrentClip({
      presenter: {
        enabled: true,
        provider: 'mock',
        outputFormat: 'webm',
        sceneSettings: [{ sceneId: 'scene-1', layout: 'pip' }]
      }
    });
    expect(isPresenterClipCurrent(project, project.scenes[0], currentClip({ outputFormat: 'mp4' }))).toBe(false);
  });

  it('does not treat an existing WebM clip as current for an MP4 request', () => {
    const project = projectWithCurrentClip();
    expect(isPresenterClipCurrent(project, project.scenes[0], currentClip({ outputFormat: 'webm' }))).toBe(false);
  });

  it('does not treat a missing or unknown clip format as current', () => {
    const project = projectWithCurrentClip();
    expect(isPresenterClipCurrent(project, project.scenes[0], currentClip({ outputFormat: undefined as unknown as PresenterClipSpec['outputFormat'] }))).toBe(false);
    expect(isPresenterClipCurrent(project, project.scenes[0], currentClip({ outputFormat: 'mov' as PresenterClipSpec['outputFormat'] }))).toBe(false);
  });
});

describe('presenter planner', () => {
  it('plans a presenter submit after current narration', () => {
    const plan = deriveProductionPlan(presenterProject(), { mode: 'mock' });
    const submit = plan.actions.find((action) => action.type === 'presenter_submit');
    const poll = plan.actions.find((action) => action.type === 'presenter_poll');

    expect(submit?.status).toBe('ready');
    expect(submit?.execute).toBe(true);
    expect(submit?.dependencyActionIds).toContain('scene:scene-1:narration_generate');
    expect(poll).toBeUndefined();
  });

  it('polls a running presenter job', () => {
    const project = presenterProject({
      presenterClips: [clip({ status: 'generating', attempts: [attempt()] })]
    });
    const plan = deriveProductionPlan(project, { mode: 'mock' });
    expect(plan.actions.find((action) => action.type === 'presenter_submit')?.status).toBe('current');
    expect(plan.actions.find((action) => action.type === 'presenter_poll')?.status).toBe('ready');
  });

  it('blocks an interrupted submission instead of retrying', () => {
    const project = presenterProject({
      presenterClips: [clip({ status: 'submitting' })]
    });
    const plan = deriveProductionPlan(project, { mode: 'mock' });
    const submit = plan.actions.find((action) => action.type === 'presenter_submit');
    expect(submit?.status).toBe('blocked');
    expect(submit?.reason).toContain('interrupted');
  });

  it('blocks paid retries in real mode', () => {
    const project = presenterProject({
      presenter: {
        enabled: true,
        provider: 'heygen',
        avatarId: 'avatar-1',
        sceneSettings: [{ sceneId: 'scene-1', layout: 'fullscreen' }],
        maxGeneratedSeconds: 20,
        maxPaidRequests: 2
      },
      presenterClips: [clip({ status: 'failed', provider: 'heygen', attempts: [attempt({ status: 'failed' })] })]
    });
    const plan = deriveProductionPlan(project, { mode: 'real' });
    const submit = plan.actions.find((action) => action.type === 'presenter_submit');
    expect(submit?.status).toBe('blocked');
    expect(submit?.reason).toContain('Paid retries');
  });

  it('does not add presenter actions when disabled', () => {
    const plan = deriveProductionPlan(baseProject(), { mode: 'mock' });
    expect(plan.actions.some((action) => action.type.startsWith('presenter_'))).toBe(false);
  });

  it('reuses a current MP4 clip without planning a new submit', () => {
    const plan = deriveProductionPlan(projectWithCurrentClip(), { mode: 'mock' });
    const submit = plan.actions.find((action) => action.type === 'presenter_submit');
    expect(submit?.status).toBe('current');
    expect(submit?.execute).toBe(false);
    expect(submit?.reason).toBe('Presenter clip is current.');
  });

  it('plans a single WebM submit when only an MP4 clip exists', () => {
    const project = projectWithCurrentClip({
      presenter: {
        enabled: true,
        provider: 'mock',
        outputFormat: 'webm',
        sceneSettings: [{ sceneId: 'scene-1', layout: 'pip' }]
      }
    });
    const plan = deriveProductionPlan(project, { mode: 'mock' });
    const submits = plan.actions.filter((action) => action.type === 'presenter_submit');
    expect(submits).toHaveLength(1);
    expect(submits[0]?.status).toBe('ready');
    expect(submits[0]?.execute).toBe(true);
  });

  it('waits to bake a composition scene until the presenter clip is current', () => {
    const project = presenterProject();
    project.scenes[0] = {
      ...project.scenes[0],
      composition: createStudioComposition({
        backgroundLocalPath: 'assets/studio/studio_back.png',
        foregroundLocalPath: 'assets/studio/studio_desk.png',
        presenterMode: 'full_canvas',
        bigscreenEnabled: false
      })
    };
    const plan = deriveProductionPlan(project, { mode: 'mock' });
    const render = plan.actions.find((action) => action.type === 'scene_render');
    const submit = plan.actions.find((action) => action.type === 'presenter_submit');
    expect(submit?.status).toBe('ready');
    expect(render?.status).toBe('waiting_dependency');
    expect(render?.execute).toBe(false);
    expect(render?.dependencyActionIds).toContain('scene:scene-1:presenter_submit');
    expect(render?.reason).toMatch(/presenter/i);
  });

  it('blocks a real submit before provider work when paid cost preconditions are missing', () => {
    const project = presenterProject({
      presenter: {
        enabled: true,
        provider: 'heygen',
        avatarId: 'avatar-1',
        outputFormat: 'webm',
        sceneSettings: [{ sceneId: 'scene-1', layout: 'fullscreen' }],
        maxGeneratedSeconds: 20,
        maxPaidRequests: 1
      }
    });
    const plan = deriveProductionPlan(project, { mode: 'real' });
    const submit = plan.actions.find((action) => action.type === 'presenter_submit');
    expect(submit?.status).toBe('blocked');
    expect(submit?.execute).toBe(false);
    expect(submit?.reason).toMatch(/HEYGEN_PRICING_JSON|maxCostUsd|HEYGEN_AVATAR_TYPE/);
  });
});

describe('presenter validation', () => {
  it('rejects duplicate or missing presenter scenes', () => {
    const project = presenterProject({
      presenter: {
        enabled: true,
        provider: 'mock',
        sceneSettings: [
          { sceneId: 'scene-1', layout: 'pip' },
          { sceneId: 'scene-1', layout: 'fullscreen' },
          { sceneId: 'missing', layout: 'fullscreen' }
        ]
      }
    });
    const validation = validateProject(project);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['project.presenter.scene.duplicate', 'project.presenter.scene.missing'])
    );
  });

  it('warns when a real provider has no avatar id', () => {
    const project = presenterProject({
      presenter: {
        enabled: true,
        provider: 'heygen',
        sceneSettings: [{ sceneId: 'scene-1', layout: 'fullscreen' }]
      }
    });
    const validation = validateProject(project);
    expect(validation.warnings.map((issue) => issue.code)).toContain('project.presenter.avatarId.missing');
  });
});
