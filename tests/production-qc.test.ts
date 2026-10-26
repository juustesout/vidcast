import { describe, expect, it } from 'vitest';

import { FFprobeError, type FFprobeResult } from '@/lib/render/ffprobe';
import { deriveNarrationFreshness } from '@/lib/generation/narration-freshness';
import { evaluateProductionQc, type ProductionQcInput } from '@/lib/production/production-qc';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { normalizeProject } from '@/lib/projects/normalize-project';
import type { CompositionArtifact, Project } from '@/lib/types/render';
import type { Scene, SceneRenderArtifact } from '@/lib/types/scene';
import type { HeadlessRunAcceptedConfig, HeadlessRunSnapshot } from '@/lib/production/run-types';
import type { ProductionPlannedAction } from '@/lib/production/production-planner';
import type { ProductionRunnerEvent } from '@/lib/production/production-runner';

const NOW = '2026-10-21T00:00:00.000Z';

const ACCEPTED_CONFIG: HeadlessRunAcceptedConfig = {
  policy: {
    mode: 'mock',
    allowRealProviders: false,
    providers: { image: 'fake', video: 'local', narration: 'fake', music: 'fake' }
  },
  limits: {
    maxIterations: 10,
    maxActionExecutions: 100,
    maxVideoPolls: 40,
    perActionConcurrency: {
      image_generate: 1,
      stock_select: 1,
      video_submit: 1,
      video_poll: 1,
      narration_generate: 1,
      scene_render: 1,
      final_compose: 1
    }
  }
};

function blankScene(id: string, order: number, duration = 2): Scene {
  return {
    id,
    order,
    duration,
    type: 'blank',
    narration: { text: '' },
    visual: { kind: 'blank' },
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: '',
    renders: []
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  return normalizeProject({
    id: 'project-qc',
    title: 'QC',
    description: '',
    durationTarget: 4,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: NOW,
    updatedAt: NOW,
    narration: { text: '', segments: [] },
    scenes: [blankScene('scene-1', 1), blankScene('scene-2', 2)],
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
    },
    ...overrides
  });
}

function attachRender(project: Project, sceneId: string, renderId: string): void {
  const plan = resolveRenderPlan(project);
  const scene = project.scenes.find((entry) => entry.id === sceneId)!;
  const planScene = plan.scenes.find((entry) => entry.sceneId === sceneId)!;
  const render: SceneRenderArtifact = {
    renderId,
    outputPath: `renders/${renderId}.mp4`,
    createdAt: NOW,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    duration: scene.duration,
    filesize: 1000,
    mimeType: 'video/mp4',
    renderer: 'ffmpeg',
    status: 'completed',
    renderFingerprint: createSceneRenderFingerprint(plan, planScene)
  };
  scene.renders = [render, ...(scene.renders ?? [])];
}

function attachComposition(project: Project, sceneIds = project.scenes.map((scene) => scene.id)): CompositionArtifact {
  const plan = resolveRenderPlan(project);
  const artifact: CompositionArtifact = {
    compositionId: 'composition-1',
    projectId: project.id,
    outputPath: 'renders/compositions/final-composition-1.mp4',
    createdAt: NOW,
    sceneIds,
    inputFingerprint: {
      version: 'p10.1',
      audioMix: project.renderSettings.audio,
      presenterSignature: 'presenter:off',
      scenes: sceneIds.map((sceneId) => {
        const scene = project.scenes.find((entry) => entry.id === sceneId)!;
        return {
          sceneId,
          renderId: scene.renders?.[0]?.renderId ?? `render-${sceneId}`,
          narrationSignature: deriveNarrationFreshness(project, scene).narrationSignature
        };
      })
    },
    duration: sceneIds.reduce((sum, sceneId) => {
      const scene = project.scenes.find((entry) => entry.id === sceneId);
      return sum + (scene?.duration ?? 0);
    }, 0),
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    renderer: 'ffmpeg',
    version: 'p10.1',
    filesize: 1000,
    mimeType: 'video/mp4',
    transition: { type: 'none' }
  };
  project.compositions = [artifact];
  return artifact;
}

function makeRun(overrides: Partial<HeadlessRunSnapshot> = {}): HeadlessRunSnapshot {
  return {
    runId: 'run-qc',
    projectId: 'project-qc',
    status: 'completed',
    createdAt: NOW,
    finishedAt: NOW,
    summary: { completed: 1, failed: 0, running: 0, waiting: 0 },
    completedActionIds: ['project:final_compose'],
    failedActionIds: [],
    unresolvedActions: [],
    acceptedConfig: ACCEPTED_CONFIG,
    ...overrides
  };
}

function validProbe(overrides: Partial<{ codec: string; width: number; height: number; fps: string; duration: string; hasAudio: boolean; audioDuration?: string }> = {}): FFprobeResult {
  const hasAudio = overrides.hasAudio !== false;
  return {
    streams: [
      {
        codec_type: 'video',
        codec_name: overrides.codec ?? 'h264',
        width: overrides.width ?? 1920,
        height: overrides.height ?? 1080,
        avg_frame_rate: overrides.fps ?? '30/1',
        duration: overrides.duration ?? '4.000000'
      },
      ...(hasAudio
        ? [
            {
              codec_type: 'audio',
              codec_name: 'aac',
              duration: overrides.audioDuration ?? overrides.duration ?? '4.000000'
            }
          ]
        : [])
    ],
    format: {
      duration: overrides.duration ?? '4.000000',
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      size: '1000'
    }
  };
}

function qcInput(project: Project, run: HeadlessRunSnapshot, events: ProductionRunnerEvent[] = []): ProductionQcInput {
  return { run, project, events };
}

async function evaluate(
  project: Project,
  run: HeadlessRunSnapshot,
  options: {
    probe?: FFprobeResult | Error;
    size?: number | null;
    events?: ProductionRunnerEvent[];
  } = {}
) {
  return evaluateProductionQc(qcInput(project, run, options.events), {
    now: () => NOW,
    readMandate: async () => null,
    readSpendSnapshot: async () => null,
    statFile: async () => (options.size === null ? null : { size: options.size ?? 1000 }),
    probeMedia: async () => {
      if (options.probe instanceof Error) {
        throw options.probe;
      }
      return options.probe ?? validProbe();
    }
  });
}

describe('production QC', () => {
  it('passes a valid MP4 with expected video and audio streams', async () => {
    const project = createProject();
    attachRender(project, 'scene-1', 'render-1');
    attachRender(project, 'scene-2', 'render-2');
    attachComposition(project);

    const report = await evaluate(project, makeRun());

    expect(report.qcStatus).toBe('passed');
    expect(report.output).toMatchObject({
      compositionId: 'composition-1',
      downloadPath: '/api/projects/project-qc/compositions/composition-1/file',
      codec: 'h264',
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 4,
      hasAudio: true,
      audioCodec: 'aac'
    });
    expect(report.scenes).toEqual({ total: 2, passed: 2, failed: 0, skipped: 0 });
    expect(report.failures).toEqual([]);
    expect(report.recovery.paidSubmitRequired).toBe(false);
  });

  it('fails a missing or empty MP4', async () => {
    const project = createProject();
    attachRender(project, 'scene-1', 'render-1');
    attachRender(project, 'scene-2', 'render-2');
    attachComposition(project);

    const missing = await evaluate(project, makeRun(), { size: null });
    expect(missing.qcStatus).toBe('failed');
    expect(missing.failures.map((issue) => issue.code)).toContain('qc.output.missing');

    const empty = await evaluate(project, makeRun(), { size: 0 });
    expect(empty.qcStatus).toBe('failed');
    expect(empty.failures.map((issue) => issue.code)).toContain('qc.output.empty');
  });

  it('fails corrupt or unreadable output', async () => {
    const project = createProject();
    attachRender(project, 'scene-1', 'render-1');
    attachRender(project, 'scene-2', 'render-2');
    attachComposition(project);

    const report = await evaluate(project, makeRun(), {
      probe: new FFprobeError('ffprobe failed to inspect rendered media.', '', 'Invalid data', 'exit')
    });

    expect(report.qcStatus).toBe('failed');
    expect(report.failures.map((issue) => issue.code)).toContain('qc.output.unreadable');
  });

  it('fails wrong codec, resolution, or duration', async () => {
    const project = createProject();
    attachRender(project, 'scene-1', 'render-1');
    attachRender(project, 'scene-2', 'render-2');
    attachComposition(project);

    const codec = await evaluate(project, makeRun(), { probe: validProbe({ codec: 'vp9' }) });
    expect(codec.qcStatus).toBe('failed');
    expect(codec.failures.map((issue) => issue.code)).toContain('qc.output.codec');

    const resolution = await evaluate(project, makeRun(), { probe: validProbe({ width: 1280, height: 720 }) });
    expect(resolution.qcStatus).toBe('failed');
    expect(resolution.failures.map((issue) => issue.code)).toContain('qc.output.resolution');

    const duration = await evaluate(project, makeRun(), { probe: validProbe({ duration: '1.000000' }) });
    expect(duration.qcStatus).toBe('failed');
    expect(duration.failures.map((issue) => issue.code)).toContain('qc.output.duration');
  });

  it('fails missing audio when production expects it', async () => {
    const project = createProject();
    project.scenes[0].narration = { text: 'Spoken line', status: 'generated', audioAssetId: 'audio-1' };
    attachRender(project, 'scene-1', 'render-1');
    attachRender(project, 'scene-2', 'render-2');
    attachComposition(project);

    const report = await evaluate(project, makeRun(), { probe: validProbe({ hasAudio: false }) });

    expect(report.qcStatus).toBe('failed');
    expect(report.failures.map((issue) => issue.code)).toContain('qc.output.audio_missing');
  });

  it('allows missing audio when audio is optional', async () => {
    const project = createProject();
    attachRender(project, 'scene-1', 'render-1');
    attachRender(project, 'scene-2', 'render-2');
    attachComposition(project);

    const report = await evaluate(project, makeRun(), { probe: validProbe({ hasAudio: false }) });

    expect(report.qcStatus).toBe('passed');
    expect(report.output?.hasAudio).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('Audio is optional'))).toBe(true);
  });

  it('does not fail QC for blocked narration_generate when scenes have no narration text', async () => {
    const project = createProject();
    attachRender(project, 'scene-1', 'render-1');
    attachRender(project, 'scene-2', 'render-2');
    attachComposition(project);

    const blockedNarration = (sceneId: string, order: number): ProductionPlannedAction => ({
      id: `scene:${sceneId}:narration_generate`,
      type: 'narration_generate',
      sceneId,
      sceneOrder: order,
      status: 'blocked',
      execute: false,
      dependencyActionIds: [],
      reason: 'Narration text is missing.'
    });

    const report = await evaluate(
      project,
      makeRun({
        unresolvedActions: [blockedNarration('scene-1', 1), blockedNarration('scene-2', 2)]
      })
    );

    expect(report.qcStatus).toBe('passed');
    expect(report.failures.map((issue) => issue.code)).not.toContain('qc.actions.unresolved');
    expect(report.scenes).toEqual({ total: 2, passed: 2, failed: 0, skipped: 0 });
    expect(report.warnings.some((warning) => warning.includes('no narration text'))).toBe(true);
  });

  it('fails incomplete scenes or failed required actions', async () => {
    const project = createProject();

    const report = await evaluate(
      project,
      makeRun({
        status: 'failed',
        completedActionIds: [],
        failedActionIds: ['scene:scene-1:scene_render', 'scene:scene-2:scene_render']
      })
    );

    expect(report.qcStatus).toBe('failed');
    expect(report.failures.some((issue) => issue.code === 'qc.scenes.incomplete' || issue.code === 'qc.actions.failed')).toBe(
      true
    );
    expect(report.scenes.failed).toBeGreaterThan(0);
  });

  it('reports partial production with partial QC status', async () => {
    const project = createProject();
    project.scenes[1].narration = { text: 'Second scene', status: 'failed', error: 'Narration provider failed.' };
    attachRender(project, 'scene-1', 'render-1');
    attachRender(project, 'scene-2', 'render-2');
    attachComposition(project);

    const report = await evaluate(
      project,
      makeRun({
        status: 'partial',
        completedActionIds: ['scene:scene-1:scene_render', 'project:final_compose'],
        failedActionIds: ['scene:scene-2:narration_generate']
      }),
      {
        events: [
          {
            timestamp: NOW,
            iteration: 1,
            code: 'action_failed',
            status: 'failed',
            actionType: 'narration_generate',
            actionId: 'scene:scene-2:narration_generate',
            sceneId: 'scene-2',
            message: 'Narration failed.'
          }
        ]
      }
    );

    expect(report.qcStatus).toBe('partial');
    expect(report.scenes.passed).toBeGreaterThan(0);
    expect(report.scenes.failed).toBeGreaterThan(0);
    expect(report.recovery.paidSubmitRequired).toBe(false);
  });

  it('fails QC after a successful compose job when the MP4 is invalid', async () => {
    const project = createProject();
    attachRender(project, 'scene-1', 'render-1');
    attachRender(project, 'scene-2', 'render-2');
    attachComposition(project);

    const report = await evaluate(project, makeRun({ status: 'completed', completedActionIds: ['project:final_compose'] }), {
      probe: validProbe({ codec: 'mpeg4' })
    });

    expect(report.runStatus).toBe('completed');
    expect(report.qcStatus).toBe('failed');
    expect(report.failures.map((issue) => issue.code)).toContain('qc.output.codec');
  });

  it('includes MCP report fields for Hermes and UI', async () => {
    const project = createProject();
    attachRender(project, 'scene-1', 'render-1');
    attachRender(project, 'scene-2', 'render-2');
    attachComposition(project);

    const report = await evaluateProductionQc(qcInput(project, makeRun()), {
      now: () => NOW,
      statFile: async () => ({ size: 2048 }),
      probeMedia: async () => validProbe(),
      readMandate: async () => ({
        mandateId: 'mandate-1',
        projectId: project.id,
        issuedBy: 'user-1',
        issuedAt: NOW,
        expiresAt: '2099-01-01T00:00:00.000Z',
        status: 'active',
        brief: 'finish the video',
        allowedActions: ['run_production'],
        budgets: { maxCostUsd: 12 }
      }),
      readSpendSnapshot: async () => ({
        version: 1,
        mandateId: 'mandate-1',
        entries: [
          {
            id: 'spend-1',
            idempotencyKey: 'key-1',
            at: Date.parse(NOW),
            modality: 'presenter',
            units: 1,
            estimatedUsd: 1.5,
            status: 'completed'
          }
        ]
      })
    });

    expect(report.projectId).toBe('project-qc');
    expect(report.runId).toBe('run-qc');
    expect(report.qcStatus).toBe('passed');
    expect(report.output?.downloadPath).toContain('/compositions/composition-1/file');
    expect(report.mandate).toMatchObject({
      available: true,
      live: true,
      status: 'active',
      spentUsd: 1.5
    });
  });

  it('marks QC resume as paid-submit-free', async () => {
    const project = createProject();
    attachRender(project, 'scene-1', 'render-1');

    const unresolved: ProductionPlannedAction = {
      id: 'scene:scene-2:video_poll',
      type: 'video_poll',
      sceneId: 'scene-2',
      sceneOrder: 2,
      status: 'ready',
      dependencyActionIds: [],
      execute: true
    };

    const report = await evaluate(
      project,
      makeRun({
        status: 'unresolved',
        completedActionIds: ['scene:scene-1:scene_render'],
        unresolvedActions: [unresolved]
      }),
      {
        events: [
          {
            timestamp: NOW,
            iteration: 1,
            code: 'action_retrying',
            status: 'waiting',
            actionType: 'video_poll',
            actionId: unresolved.id,
            sceneId: 'scene-2',
            message: 'Retrying video poll.'
          }
        ]
      }
    );

    expect(report.recovery.paidSubmitRequired).toBe(false);
    expect(report.recovery.resumeSafe).toBe(true);
    expect(report.recoveryAttempts).toBe(1);
    expect(report.recovery.notes.some((note) => note.includes('Do not submit new paid work'))).toBe(true);
  });

  it('counts skipped scenes without treating them as passed', async () => {
    const project = createProject();
    attachRender(project, 'scene-1', 'render-1');
    attachComposition(project, ['scene-1']);

    const report = await evaluate(
      project,
      makeRun({
        status: 'partial',
        completedActionIds: ['scene:scene-1:scene_render', 'project:final_compose']
      }),
      {
        events: [
          {
            timestamp: NOW,
            iteration: 1,
            code: 'action_skipped',
            status: 'skipped',
            actionType: 'scene_render',
            actionId: 'scene:scene-2:scene_render',
            sceneId: 'scene-2',
            message: 'Scene render skipped.'
          }
        ],
        probe: validProbe({ duration: '2.000000' })
      }
    );

    expect(report.scenes.skipped).toBe(1);
    expect(report.qcStatus).toBe('partial');
  });
});
