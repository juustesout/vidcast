import { describe, expect, it } from 'vitest';

import { HeadlessProductionRunService } from '@/lib/production/run-service';
import { applyProjectUpdate } from '@/lib/projects/project-update';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { deriveProductionPlan } from '@/lib/production/production-planner';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import { deriveSceneRenderStatus } from '@/lib/render/render-status';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { OVERLAY_STYLE_LIMITS } from '@/lib/constants';
import type { Project } from '@/lib/types/render';
import type { SceneRenderArtifact } from '@/lib/types/scene';

function baseProject(): Project {
  const now = new Date().toISOString();
  return normalizeProject({
    id: 'project-overlay-authoring',
    title: 'Overlay Authoring',
    description: 'desc',
    durationTarget: 30,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 4,
        type: 'image',
        narration: { text: 'Scene one narration' },
        visual: { kind: 'blank' },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'title', text: 'Original title', position: 'top' },
        referenceIds: [],
        notes: ''
      }
    ],
    assets: [],
    references: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1280,
      height: 720,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    }
  });
}

function overlayOf(project: Project) {
  return project.scenes[0].overlay!;
}

const VALID_STYLE = {
  fontSize: 96,
  color: '#ff0000',
  box: true,
  margin: 64
};

describe('overlay patch-shape guard', () => {
  it('rejects non-object style/timing without throwing', () => {
    const existing = baseProject();

    for (const [field, value] of [['style', 'big'], ['timing', 4]] as const) {
      let result: ReturnType<typeof applyProjectUpdate> | undefined;
      expect(() => {
        result = applyProjectUpdate(existing, {
          ...existing,
          scenes: [{ ...existing.scenes[0], overlay: { type: 'title', text: 'x', [field]: value } }]
        });
      }).not.toThrow();

      expect(result?.validation.valid).toBe(false);
      expect(result?.validation.errors.some((error) => error.code === `scene.overlay.${field}.invalid`)).toBe(true);
    }
  });

  it('treats null style/timing as absent', () => {
    const existing = baseProject();
    const result = applyProjectUpdate(existing, {
      ...existing,
      scenes: [{ ...existing.scenes[0], overlay: { type: 'title', text: 'x', style: null, timing: null } }]
    });

    expect(result.validation.valid).toBe(true);
  });
});

describe('overlay style/timing validation', () => {
  function applyStyle(overlay: Record<string, unknown>): ReturnType<typeof applyProjectUpdate> {
    const existing = baseProject();
    return applyProjectUpdate(existing, {
      ...existing,
      scenes: [{ ...existing.scenes[0], overlay: { type: 'title', text: 'x', ...overlay } }]
    });
  }

  it('accepts well-formed style and timing', () => {
    const result = applyStyle({ style: VALID_STYLE, timing: { fadeInSeconds: 1, fadeOutSeconds: 0.5 } });
    expect(result.validation.valid).toBe(true);
    expect(overlayOf(result.project).style).toEqual(VALID_STYLE);
    expect(overlayOf(result.project).timing).toEqual({ fadeInSeconds: 1, fadeOutSeconds: 0.5 });
  });

  it('accepts optional style/timing omitted or partial', () => {
    expect(applyStyle({}).validation.valid).toBe(true);
    expect(applyStyle({ style: { fontSize: 48 } }).validation.valid).toBe(true);
    expect(applyStyle({ timing: { fadeInSeconds: 0 } }).validation.valid).toBe(true);
  });

  it('accepts the shared bounds and rejects values outside them', () => {
    const { MIN_FONT_SIZE, MAX_FONT_SIZE, MIN_MARGIN, MAX_MARGIN } = OVERLAY_STYLE_LIMITS;

    expect(applyStyle({ style: { fontSize: MIN_FONT_SIZE } }).validation.valid).toBe(true);
    expect(applyStyle({ style: { fontSize: MAX_FONT_SIZE } }).validation.valid).toBe(true);
    expect(applyStyle({ style: { margin: MIN_MARGIN } }).validation.valid).toBe(true);
    expect(applyStyle({ style: { margin: MAX_MARGIN } }).validation.valid).toBe(true);

    const low = applyStyle({ style: { fontSize: MIN_FONT_SIZE - 1 } });
    expect(low.validation.errors.some((error) => error.code === 'scene.overlay.style.fontSize.invalid')).toBe(true);

    const high = applyStyle({ style: { fontSize: MAX_FONT_SIZE + 1 } });
    expect(high.validation.errors.some((error) => error.code === 'scene.overlay.style.fontSize.invalid')).toBe(true);

    const narrow = applyStyle({ style: { margin: MIN_MARGIN - 1 } });
    expect(narrow.validation.errors.some((error) => error.code === 'scene.overlay.style.margin.invalid')).toBe(true);

    const wide = applyStyle({ style: { margin: MAX_MARGIN + 1 } });
    expect(wide.validation.errors.some((error) => error.code === 'scene.overlay.style.margin.invalid')).toBe(true);
  });

  it('rejects wrong types for known fields', () => {
    expect(applyStyle({ style: { fontSize: 'huge' } }).validation.errors.some((error) => error.code === 'scene.overlay.style.fontSize.invalid')).toBe(true);
    expect(applyStyle({ style: { margin: Number.NaN } }).validation.errors.some((error) => error.code === 'scene.overlay.style.margin.invalid')).toBe(true);
    expect(applyStyle({ style: { box: 'yes' } }).validation.errors.some((error) => error.code === 'scene.overlay.style.box.invalid')).toBe(true);
    expect(applyStyle({ style: { color: 123 } }).validation.errors.some((error) => error.code === 'scene.overlay.style.color.invalid')).toBe(true);
    expect(applyStyle({ style: { color: 'not a color' } }).validation.errors.some((error) => error.code === 'scene.overlay.style.color.invalid')).toBe(true);
    expect(applyStyle({ position: 'middle' }).validation.errors.some((error) => error.code === 'scene.overlay.position.invalid')).toBe(true);
    expect(applyStyle({ text: 42 }).validation.errors.some((error) => error.code === 'scene.overlay.text.invalid')).toBe(true);
    expect(applyStyle({ data: 'nope' }).validation.errors.some((error) => error.code === 'scene.overlay.data.invalid')).toBe(true);
  });

  it('accepts hex and named overlay colors', () => {
    for (const color of ['#fff', '#ff0000', '0xff0000', '0xff0000aa', 'white', 'black@0.45']) {
      expect(applyStyle({ style: { color } }).validation.valid).toBe(true);
    }
  });

  it('rejects negative or absurd fades', () => {
    expect(applyStyle({ timing: { fadeInSeconds: -1 } }).validation.errors.some((error) => error.code === 'scene.overlay.timing.fadeInSeconds.invalid')).toBe(true);
    expect(applyStyle({ timing: { fadeOutSeconds: -0.5 } }).validation.errors.some((error) => error.code === 'scene.overlay.timing.fadeOutSeconds.invalid')).toBe(true);
    expect(applyStyle({ timing: { fadeInSeconds: 10_000 } }).validation.errors.some((error) => error.code === 'scene.overlay.timing.fadeInSeconds.invalid')).toBe(true);
  });

  it('keeps legacy overlays without style/timing valid and preserves unknown fields', () => {
    const existing = baseProject();
    existing.scenes[0].overlay = { type: 'callout', text: 'Legacy' };
    const result = applyProjectUpdate(existing, { ...existing });

    expect(result.validation.valid).toBe(true);
    expect(overlayOf(result.project).style).toBeUndefined();
    expect(overlayOf(result.project).timing).toBeUndefined();

    const withExtra = applyProjectUpdate(existing, {
      ...existing,
      scenes: [{ ...existing.scenes[0], overlay: { type: 'callout', text: 'Legacy', data: { speaker: 'Ada' } } }]
    });
    expect(withExtra.validation.valid).toBe(true);
    expect(overlayOf(withExtra.project).data).toEqual({ speaker: 'Ada' });
  });
});

describe('overlay authoring mock E2E', () => {
  it('persists an authored overlay, flips a completed render to stale, and schedules a mock re-render', async () => {
    const project = baseProject();
    const sceneBefore = project.scenes[0];

    const planBefore = resolveRenderPlan(project);
    const fingerprintBefore = createSceneRenderFingerprint(planBefore, planBefore.scenes[0]);
    const completed: SceneRenderArtifact = {
      renderId: 'render-before',
      outputPath: 'renders/scene-1/render-before.mp4',
      createdAt: new Date().toISOString(),
      width: planBefore.width,
      height: planBefore.height,
      fps: planBefore.fps,
      duration: sceneBefore.duration,
      filesize: 1234,
      mimeType: 'video/mp4',
      renderer: 'ffmpeg',
      status: 'completed',
      renderFingerprint: fingerprintBefore
    };
    sceneBefore.renders = [completed];

    expect(deriveSceneRenderStatus(project, sceneBefore, planBefore).status).toBe('rendered');
    expect(deriveProductionPlan(project).actions.find((action) => action.id === 'scene:scene-1:scene_render')?.status).toBe('current');

    // Author the overlay exactly as an API/MCP client would: resend the complete
    // scene object (scenes[] is replaced wholesale).
    const updatedScene = {
      ...sceneBefore,
      overlay: {
        type: 'title' as const,
        text: 'Authored title',
        position: 'bottom' as const,
        style: { fontSize: 88, color: '#00ffcc', box: true, margin: 48 },
        timing: { fadeInSeconds: 0.8, fadeOutSeconds: 0.4 }
      }
    };
    const { project: updated, validation } = applyProjectUpdate(project, { ...project, scenes: [updatedScene] });

    expect(validation.valid).toBe(true);
    expect(updated.scenes[0].overlay?.text).toBe('Authored title');
    expect(updated.scenes[0].overlay?.style).toEqual({ fontSize: 88, color: '#00ffcc', box: true, margin: 48 });
    expect(updated.scenes[0].overlay?.timing).toEqual({ fadeInSeconds: 0.8, fadeOutSeconds: 0.4 });
    // The completed render artifact is retained because the full scene was resent.
    expect(updated.scenes[0].renders).toHaveLength(1);

    const planAfter = resolveRenderPlan(updated);
    expect(createSceneRenderFingerprint(planAfter, planAfter.scenes[0])).not.toBe(fingerprintBefore);
    expect(deriveSceneRenderStatus(updated, updated.scenes[0], planAfter).status).toBe('stale');

    const renderAction = deriveProductionPlan(updated).actions.find((action) => action.id === 'scene:scene-1:scene_render');
    expect(renderAction?.status).toBe('ready');
    expect(renderAction?.execute).toBe(true);

    // Mock production run: no paid providers. The batch only executes the
    // scene_render action that the stale overlay produced.
    const executed: string[] = [];
    const service = new HeadlessProductionRunService(
      {
        maxConcurrentRuns: 1,
        runner: {
          maxIterations: 5,
          maxActionExecutions: 5,
          maxVideoPolls: 1,
          limits: { image_generate: 1, video_submit: 1, video_poll: 1, narration_generate: 1, scene_render: 1, final_compose: 1 }
        },
        registry: { maxEventsPerRun: 100, retentionMs: 60_000, maxLogPageLimit: 100 },
        policy: { allowRealProviders: false, defaultMode: 'mock' }
      },
      {
        store: {
          async getProject(projectId: string) {
            return projectId === updated.id ? updated : null;
          }
        },
        runBatch: async (input) => {
          const plan = input.derivePlan(updated, {});
          const action = plan.actions.find((entry) => entry.id === 'scene:scene-1:scene_render');
          if (action?.execute) {
            await input.executeAction(action);
            executed.push(action.id);
          }
          return {
            status: 'completed',
            project: updated,
            iterations: 1,
            completedActionIds: action ? [action.id] : [],
            failedActionIds: [],
            unresolvedActions: [],
            events: []
          };
        },
        renderScene: async (projectId, sceneId) => ({
          projectId,
          sceneId,
          render: {
            renderId: 'render-after',
            sceneId,
            outputPath: 'renders/scene-1/render-after.mp4',
            createdAt: new Date().toISOString(),
            width: planAfter.width,
            height: planAfter.height,
            fps: planAfter.fps,
            duration: updated.scenes[0].duration,
            filesize: 2000,
            mimeType: 'video/mp4',
            renderer: 'ffmpeg',
            status: 'completed',
            renderFingerprint: createSceneRenderFingerprint(planAfter, planAfter.scenes[0])
          }
        })
      }
    );

    const started = await service.startOrReuseRun({ projectId: updated.id, policy: { mode: 'mock' } });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const run = service.getRun(started.run.runId);
      if (run.status === 'completed' || run.status === 'failed') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(service.getRun(started.run.runId).status).toBe('completed');
    expect(executed).toEqual(['scene:scene-1:scene_render']);
  });
});
