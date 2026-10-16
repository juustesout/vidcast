import { describe, expect, it } from 'vitest';

import { deriveProductionPlan } from '@/lib/production/production-planner';
import { runProductionBatch } from '@/lib/production/production-runner';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { ProductionPlannedAction } from '@/lib/production/production-planner';
import type { Asset, AssetType } from '@/lib/types/asset';
import type { CompositionArtifact, Project } from '@/lib/types/render';
import type { SceneRenderArtifact } from '@/lib/types/scene';

const NOW = '2026-01-01T00:00:00.000Z';
const SCENE_ID = 'scene-1';

const IMAGE_ACTION = `scene:${SCENE_ID}:image_generate`;
const NARRATION_ACTION = `scene:${SCENE_ID}:narration_generate`;
const RENDER_ACTION = `scene:${SCENE_ID}:scene_render`;
const COMPOSE_ACTION = 'project:final_compose';

function imageAsset(): Asset {
  return {
    id: `image-${SCENE_ID}`,
    type: 'image',
    status: 'available',
    provenance: 'generated',
    filename: `image-${SCENE_ID}.png`,
    localPath: `assets/image-${SCENE_ID}.png`,
    width: 1920,
    height: 1080,
    metadata: {},
    createdAt: NOW
  };
}

function audioAsset(): Asset {
  return {
    id: `audio-${SCENE_ID}`,
    type: 'audio',
    status: 'available',
    provenance: 'generated',
    filename: `audio-${SCENE_ID}.wav`,
    localPath: `assets/audio-${SCENE_ID}.wav`,
    duration: 3,
    metadata: {},
    createdAt: NOW
  };
}

// A project with one generated-image scene whose image and narration have
// already been produced. No renders or composition exist yet: this is the
// "generation done, rendering pending" mid-state a recovery resumes from.
function generatedProject(options: { withImageAsset: boolean; withAudioAsset: boolean }): Project {
  const assets: Asset[] = [];
  if (options.withImageAsset) {
    assets.push(imageAsset());
  }
  if (options.withAudioAsset) {
    assets.push(audioAsset());
  }

  return normalizeProject({
    id: 'project-force-recovery',
    title: 'Force recovery',
    description: '',
    durationTarget: 3,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: NOW,
    updatedAt: NOW,
    narration: { text: '', segments: [] },
    assets,
    references: [],
    compositions: [],
    scenes: [
      {
        id: SCENE_ID,
        order: 1,
        duration: 3,
        type: 'image',
        narration: { text: 'Narration.', status: 'generated', audioAssetId: `audio-${SCENE_ID}` },
        visual: {
          kind: 'generated_image',
          assetId: `image-${SCENE_ID}`,
          generation: {
            id: `gen-${SCENE_ID}`,
            kind: 'image',
            status: 'generated',
            provider: 'local',
            prompt: 'A deterministic gradient background.',
            referenceIds: [],
            aspectRatio: '16:9',
            assetId: `image-${SCENE_ID}`,
            createdAt: NOW
          }
        },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: false
    }
  } as unknown as Parameters<typeof normalizeProject>[0]);
}

function withGeneratedImage(project: Project, sceneId: string): Project {
  const assets = project.assets.some((asset) => asset.id === `image-${sceneId}`)
    ? project.assets
    : [...project.assets, imageAsset()];
  const scenes = project.scenes.map((scene) =>
    scene.id === sceneId && scene.visual?.kind === 'generated_image'
      ? {
          ...scene,
          visual: {
            ...scene.visual,
            assetId: `image-${sceneId}`,
            generation: { ...scene.visual.generation, status: 'generated' as const, assetId: `image-${sceneId}` }
          }
        }
      : scene
  );
  return { ...project, assets, scenes };
}

function withGeneratedNarration(project: Project, sceneId: string): Project {
  const assets = project.assets.some((asset) => asset.id === `audio-${sceneId}`)
    ? project.assets
    : [...project.assets, audioAsset()];
  const scenes = project.scenes.map((scene) =>
    scene.id === sceneId
      ? { ...scene, narration: { ...(scene.narration ?? { text: '' }), status: 'generated' as const, audioAssetId: `audio-${sceneId}` } }
      : scene
  );
  return { ...project, assets, scenes };
}

function withCompletedRender(project: Project, sceneId: string): Project {
  const plan = resolveRenderPlan(project);
  const planScene = plan.scenes.find((entry) => entry.sceneId === sceneId);
  const render: SceneRenderArtifact = {
    renderId: `render-${sceneId}`,
    outputPath: `renders/${sceneId}.mp4`,
    createdAt: NOW,
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 3,
    filesize: 4096,
    mimeType: 'video/mp4',
    renderer: 'ffmpeg',
    status: 'completed',
    ...(planScene ? { renderFingerprint: createSceneRenderFingerprint(plan, planScene) } : {})
  };
  const scenes = project.scenes.map((scene) =>
    scene.id === sceneId ? { ...scene, renders: [render, ...(scene.renders ?? [])] } : scene
  );
  return { ...project, scenes };
}

function withComposition(project: Project): Project {
  const composition: CompositionArtifact = {
    compositionId: 'composition-1',
    projectId: project.id,
    outputPath: 'compositions/final.mp4',
    createdAt: NOW,
    sceneIds: project.scenes.map((scene) => scene.id),
    inputFingerprint: { version: 'p10.1', scenes: [] },
    duration: 3,
    width: 1920,
    height: 1080,
    fps: 30,
    renderer: 'ffmpeg',
    version: 'p10.1',
    filesize: 4096,
    mimeType: 'video/mp4',
    transition: { type: 'none' }
  } as CompositionArtifact;
  return { ...project, compositions: [composition] };
}

interface HarnessResult {
  executed: string[];
  imageAttempts: number;
  narrationAttempts: number;
  project: Project;
}

async function runHarness(options: {
  force: boolean;
  initialProject: Project;
  initialCompletedActionIds?: string[];
}): Promise<HarnessResult> {
  let project = options.initialProject;
  const executed: string[] = [];
  let imageAttempts = 0;
  let narrationAttempts = 0;

  const result = await runProductionBatch({
    initialProject: options.initialProject,
    derivePlan: (current, planOptions) =>
      deriveProductionPlan(current, { ...planOptions, force: options.force }),
    refreshProject: async () => project,
    initialCompletedActionIds: options.initialCompletedActionIds,
    config: { maxIterations: 24 },
    executeAction: async (action: ProductionPlannedAction) => {
      executed.push(action.id);
      if (!action.sceneId) {
        project = withComposition(project);
        return;
      }
      switch (action.type) {
        case 'image_generate':
          imageAttempts += 1;
          project = withGeneratedImage(project, action.sceneId);
          break;
        case 'narration_generate':
          narrationAttempts += 1;
          project = withGeneratedNarration(project, action.sceneId);
          break;
        case 'scene_render':
          project = withCompletedRender(project, action.sceneId);
          break;
        default:
          break;
      }
    }
  });

  expect(result.status).toBe('completed');
  return { executed, imageAttempts, narrationAttempts, project };
}

function countAssets(project: Project, type: AssetType): number {
  return project.assets.filter((asset) => asset.type === type).length;
}

describe('runProductionBatch force-recovery idempotency', () => {
  it('re-executes generation for a fresh forced run (no completed ids)', async () => {
    const result = await runHarness({
      force: true,
      initialProject: generatedProject({ withImageAsset: true, withAudioAsset: true })
    });

    expect(result.executed).toEqual(
      expect.arrayContaining([IMAGE_ACTION, NARRATION_ACTION, RENDER_ACTION, COMPOSE_ACTION])
    );
    expect(result.imageAttempts).toBe(1);
    expect(result.narrationAttempts).toBe(1);
    expect(countAssets(result.project, 'image')).toBe(1);
    expect(countAssets(result.project, 'audio')).toBe(1);
    expect(result.project.compositions).toHaveLength(1);
  });

  it('does not re-execute completed generation when force is enabled on recovery', async () => {
    const result = await runHarness({
      force: true,
      initialProject: generatedProject({ withImageAsset: true, withAudioAsset: true }),
      initialCompletedActionIds: [IMAGE_ACTION, NARRATION_ACTION]
    });

    expect(result.executed).not.toContain(IMAGE_ACTION);
    expect(result.executed).not.toContain(NARRATION_ACTION);
    expect(result.executed).toEqual(expect.arrayContaining([RENDER_ACTION, COMPOSE_ACTION]));
    expect(result.imageAttempts).toBe(0);
    expect(result.narrationAttempts).toBe(0);
    expect(countAssets(result.project, 'image')).toBe(1);
    expect(countAssets(result.project, 'audio')).toBe(1);
    expect(result.project.compositions).toHaveLength(1);
  });

  it('does not re-execute completed generation on recovery without force', async () => {
    const result = await runHarness({
      force: false,
      initialProject: generatedProject({ withImageAsset: true, withAudioAsset: true }),
      initialCompletedActionIds: [IMAGE_ACTION, NARRATION_ACTION]
    });

    expect(result.executed).toEqual(expect.arrayContaining([RENDER_ACTION, COMPOSE_ACTION]));
    expect(result.executed).not.toContain(IMAGE_ACTION);
    expect(result.executed).not.toContain(NARRATION_ACTION);
    expect(result.imageAttempts).toBe(0);
    expect(result.narrationAttempts).toBe(0);
    expect(result.project.compositions).toHaveLength(1);
  });

  it('re-executes generation on forced recovery when the artifacts are missing', async () => {
    const result = await runHarness({
      force: true,
      // Generation ids were completed before the crash, but the artifacts never
      // made it to disk. The planner must not blindly trust the recorded ids.
      initialProject: generatedProject({ withImageAsset: false, withAudioAsset: false }),
      initialCompletedActionIds: [IMAGE_ACTION, NARRATION_ACTION]
    });

    expect(result.executed).toEqual(expect.arrayContaining([IMAGE_ACTION, NARRATION_ACTION]));
    expect(result.imageAttempts).toBe(1);
    expect(result.narrationAttempts).toBe(1);
    expect(countAssets(result.project, 'image')).toBe(1);
    expect(countAssets(result.project, 'audio')).toBe(1);
    expect(result.project.compositions).toHaveLength(1);
  });

  it('regenerates only the action whose artifact is missing when force is enabled', async () => {
    const result = await runHarness({
      force: true,
      initialProject: generatedProject({ withImageAsset: false, withAudioAsset: true }),
      initialCompletedActionIds: [IMAGE_ACTION, NARRATION_ACTION]
    });

    expect(result.executed).toContain(IMAGE_ACTION);
    expect(result.executed).not.toContain(NARRATION_ACTION);
    expect(result.imageAttempts).toBe(1);
    expect(result.narrationAttempts).toBe(0);
    expect(result.project.compositions).toHaveLength(1);
  });
});
