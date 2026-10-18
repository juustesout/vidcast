import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { deriveProductionPlan } from '@/lib/production/production-planner';
import { runProcess } from '@/lib/render/ffmpeg-executor';
import { LocalFFmpegRenderer } from '@/lib/render/renderer';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import {
  DEFAULT_NARRATION_END_PADDING_SECONDS,
  formatSceneTiming,
  resolveMeasuredNarrationDuration,
  resolveSceneTiming
} from '@/lib/render/scene-timing';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { resolveCompositionPlan } from '@/lib/render/video-composition-service';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import { validateProject } from '@/lib/validation/project-validation';
import type { Project } from '@/lib/types/render';

const PROJECT_ID = 'project-p32-1-scene-timing';

function createProject(): Project {
  const now = new Date().toISOString();
  return {
    id: PROJECT_ID,
    title: 'P32.1 Scene Timing',
    description: 'desc',
    durationTarget: 10,
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
    assets: [
      {
        id: 'audio-1',
        type: 'audio',
        status: 'available',
        provenance: 'generated',
        filename: 'narration.mp3',
        localPath: 'assets/narration.mp3',
        mimeType: 'audio/mpeg',
        duration: 3.1,
        filesize: 32,
        metadata: {},
        createdAt: now,
        updatedAt: now
      }
    ],
    references: [],
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 2,
        type: 'blank',
        narration: {
          text: 'Measured narration that is longer than the authored scene.',
          audioAssetId: 'audio-1',
          status: 'generated',
          duration: 3.1
        },
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

async function writeProjectFiles(): Promise<void> {
  const root = getProjectRoot(PROJECT_ID);
  for (const relativePath of ['renders/scene-1.mp4', 'assets/narration.mp3']) {
    const full = path.join(root, relativePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, 'ok', 'utf8');
  }
}

function attachRender(project: Project, duration: number, renderFingerprint?: string): void {
  project.scenes[0].renders = [
    {
      renderId: 'render-1',
      outputPath: 'renders/scene-1.mp4',
      createdAt: new Date().toISOString(),
      width: 1280,
      height: 720,
      fps: 30,
      duration,
      filesize: 100,
      mimeType: 'video/mp4',
      renderer: 'ffmpeg',
      status: 'completed',
      renderFingerprint
    }
  ];
}

afterEach(async () => {
  await fs.rm(getProjectRoot(PROJECT_ID), { recursive: true, force: true });
});

describe('audio-aware scene timing', () => {
  it('keeps the authored duration when narration is shorter', () => {
    const timing = resolveSceneTiming({ duration: 8, narrationDuration: 4 });

    expect(timing.authoredDuration).toBe(8);
    expect(timing.effectiveDuration).toBe(8);
    expect(timing.adjusted).toBe(false);
    expect(timing.exceedsMax).toBe(false);
  });

  it('keeps the authored duration when narration fits within the end-padding band', () => {
    const timing = resolveSceneTiming({ duration: 1, narrationDuration: 0.8 });

    expect(timing.effectiveDuration).toBe(1);
    expect(timing.adjusted).toBe(false);
    expect(formatSceneTiming(timing)).toContain('fits authored');
  });

  it('keeps the authored duration when narration equals it', () => {
    const timing = resolveSceneTiming({ duration: 5, narrationDuration: 5 });

    expect(timing.effectiveDuration).toBe(5);
    expect(timing.adjusted).toBe(false);
  });

  it('adds the end margin only when narration just exceeds the authored duration', () => {
    const timing = resolveSceneTiming({ duration: 5, narrationDuration: 5.1 });

    expect(timing.effectiveDuration).toBeCloseTo(5.35, 5);
    expect(timing.adjusted).toBe(true);
  });

  it('does not reject fitting narration at the maximum duration', () => {
    const timing = resolveSceneTiming(
      { duration: 600, narrationDuration: 599.9 },
      { maxDurationSeconds: 600 }
    );

    expect(timing.effectiveDuration).toBe(600);
    expect(timing.adjusted).toBe(false);
    expect(timing.exceedsMax).toBe(false);
  });

  it('extends the scene when narration is longer than the authored duration', () => {
    const timing = resolveSceneTiming({ duration: 5, narrationDuration: 7.5 });

    expect(timing.effectiveDuration).toBeCloseTo(7.75, 5);
    expect(timing.adjusted).toBe(true);
    expect(timing.exceedsMax).toBe(false);
  });

  it('keeps measured trailing silence and adds a natural end margin', () => {
    const timing = resolveSceneTiming({ duration: 5, narrationDuration: 7 });

    expect(timing.narrationDuration).toBe(7);
    expect(timing.endPaddingSeconds).toBe(DEFAULT_NARRATION_END_PADDING_SECONDS);
    expect(timing.effectiveDuration).toBeCloseTo(7.25, 5);
  });

  it('reports a deterministic overflow instead of clipping narration', () => {
    const timing = resolveSceneTiming(
      { duration: 10, narrationDuration: 10.5 },
      { maxDurationSeconds: 10 }
    );

    expect(timing.effectiveDuration).toBeCloseTo(10.75, 5);
    expect(timing.exceedsMax).toBe(true);
  });

  it('keeps scenes without narration unchanged', () => {
    const timing = resolveSceneTiming({ duration: 6 });

    expect(timing.narrationDuration).toBeUndefined();
    expect(timing.effectiveDuration).toBe(6);
    expect(timing.adjusted).toBe(false);
  });

  it('produces identical timing for identical inputs', () => {
    const first = resolveSceneTiming({ duration: 5, narrationDuration: 6.2 });
    const second = resolveSceneTiming({ duration: 5, narrationDuration: 6.2 });

    expect(second).toEqual(first);
  });

  it('uses the largest persisted narration duration and falls back to the linked asset', () => {
    const project = createProject();
    const scene = project.scenes[0];

    expect(resolveMeasuredNarrationDuration(scene.narration, project.assets)).toBe(3.1);

    project.assets[0].duration = 3.4;
    expect(resolveMeasuredNarrationDuration(scene.narration, project.assets)).toBe(3.4);

    scene.narration = { ...scene.narration!, duration: undefined };
    expect(resolveMeasuredNarrationDuration(scene.narration, project.assets)).toBe(3.4);

    project.assets.length = 0;
    scene.narration = { ...scene.narration!, duration: 3.1 };
    expect(resolveMeasuredNarrationDuration(scene.narration, project.assets)).toBe(3.1);
  });
});

describe('timeline parity across planning, rendering and composition', () => {
  it('uses the fitted duration in the render plan and composition plan', async () => {
    const project = createProject();
    const renderPlan = resolveRenderPlan(project);
    const planScene = renderPlan.scenes[0];

    expect(planScene.duration).toBeCloseTo(3.35, 5);
    expect(planScene.timing?.adjusted).toBe(true);
    expect(planScene.status).toBe('renderable');
    expect(renderPlan.ready).toBe(true);

    attachRender(project, 3.35, createSceneRenderFingerprint(renderPlan, planScene));
    await writeProjectFiles();

    const compositionPlan = await resolveCompositionPlan(project, { type: 'none' });
    expect(compositionPlan.items[0].duration).toBeCloseTo(planScene.duration, 5);
    expect(compositionPlan.totalDuration).toBeCloseTo(planScene.duration, 5);
    expect(compositionPlan.items[0].narrationAudioDuration).toBe(3.1);
  });

  it('treats an old-duration render as stale in production planning', () => {
    const project = createProject();
    const renderPlan = resolveRenderPlan(project);
    const planScene = renderPlan.scenes[0];
    const oldPlan = {
      ...renderPlan,
      scenes: [{ ...planScene, duration: project.scenes[0].duration }]
    };

    attachRender(
      project,
      project.scenes[0].duration,
      createSceneRenderFingerprint(oldPlan, oldPlan.scenes[0])
    );

    const plan = deriveProductionPlan(project);
    const renderAction = plan.actions.find((action) => action.id === 'scene:scene-1:scene_render');

    expect(renderAction?.status).toBe('ready');
    expect(renderAction?.execute).toBe(true);
  });


  it('renders the fitted duration instead of the authored duration', async () => {
    try {
      await runProcess('ffmpeg', ['-version']);
    } catch {
      return;
    }

    const project = createProject();
    const plan = resolveRenderPlan(project);
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'p32-1-timing-'));

    try {
      const renderer = new LocalFFmpegRenderer();
      const result = await renderer.render(plan, {
        projectId: project.id,
        sceneId: 'scene-1',
        renderId: 'render-p32-1',
        outputPath: path.join(tempRoot, 'scene-1.mp4'),
        tempDir: path.join(tempRoot, 'tmp'),
        sceneWidth: plan.width,
        sceneHeight: plan.height,
        sceneFps: plan.fps
      });

      expect(result.duration).toBeCloseTo(3.35, 1);
      expect(result.duration).toBeGreaterThan(3.1);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 120000);

  it('rejects a composition when the render predates the fitted duration', async () => {
    const project = createProject();
    attachRender(project, 2);
    await writeProjectFiles();

    await expect(resolveCompositionPlan(project, { type: 'none' })).rejects.toThrow(/re-render the scene/);
  });

  it('marks a render stale and rejects composition when narration shrinks the effective duration', async () => {
    const project = createProject();
    attachRender(project, 3.35);

    project.scenes[0].narration = { ...project.scenes[0].narration!, duration: 1.5 };
    project.assets[0].duration = 1.5;

    const plan = deriveProductionPlan(project);
    const renderAction = plan.actions.find((action) => action.id === 'scene:scene-1:scene_render');
    expect(renderAction?.status).toBe('ready');
    expect(renderAction?.execute).toBe(true);

    await writeProjectFiles();
    await expect(resolveCompositionPlan(project, { type: 'none' })).rejects.toThrow(/re-render the scene/);
  });

  it('returns the same measured narration duration used by the render plan', async () => {
    const project = createProject();
    project.scenes[0].narration = { ...project.scenes[0].narration!, duration: 3.4 };
    project.assets[0].duration = 3.1;

    const renderPlan = resolveRenderPlan(project);
    const planScene = renderPlan.scenes[0];
    expect(planScene.duration).toBeCloseTo(3.65, 5);
    expect(planScene.timing?.narrationDuration).toBe(3.4);

    attachRender(project, planScene.duration, createSceneRenderFingerprint(renderPlan, planScene));
    await writeProjectFiles();

    const compositionPlan = await resolveCompositionPlan(project, { type: 'none' });
    expect(compositionPlan.items[0].narrationAudioDuration).toBe(3.4);
  });

  it('produces the same production plan for identical inputs', () => {
    const project = createProject();
    attachRender(project, 2, 'stale');

    expect(deriveProductionPlan(project)).toEqual(deriveProductionPlan(project));
  });

  it('surfaces an overflow as a project validation error', () => {
    const project = createProject();
    project.scenes[0].narration = {
      ...project.scenes[0].narration!,
      duration: 600.5
    };
    project.assets[0].duration = 600.5;

    const validation = validateProject(project);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((issue) => issue.code)).toContain('scene.narration.duration.exceedsMax');
  });

  it('blocks composition with a clear error when fitting exceeds the hard maximum', () => {
    const project = createProject();
    project.scenes[0].narration = {
      ...project.scenes[0].narration!,
      duration: 600.5
    };
    project.assets[0].duration = 600.5;

    const renderPlan = resolveRenderPlan(project);
    expect(renderPlan.ready).toBe(false);
    expect(renderPlan.scenes[0].status).toBe('invalid');
    expect(renderPlan.scenes[0].timing?.exceedsMax).toBe(true);
    expect(renderPlan.scenes[0].issues.map((issue) => issue.code)).toContain('scene.narration.duration.exceedsMax');
  });
});
