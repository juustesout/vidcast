import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveRenderPlan } from './scene-resolver';
import { validateRenderPlan } from './render-plan-validator';
import { createSceneRenderPaths, ensureRenderDirectories } from './render-artifacts';
import { LocalFFmpegRenderer } from './renderer';
import { projectStore } from '@/lib/storage/project-store';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import type { SceneRenderResult } from '@/lib/types/render';
import { createId } from '@/lib/utils/ids';
import { SceneRenderError } from './renderer';
import { createSceneRenderFingerprint } from './render-fingerprint';

export interface SceneRenderServiceResult {
  projectId: string;
  sceneId: string;
  render: SceneRenderResult;
}

export class SceneRenderService {
  private readonly renderer = new LocalFFmpegRenderer();

  async renderScene(projectId: string, sceneId: string): Promise<SceneRenderServiceResult> {
    const project = await projectStore.getProject(projectId);
    if (!project) {
      throw new SceneRenderError(`Project ${projectId} not found.`, 'INVALID_PLAN');
    }

    const resolved = resolveRenderPlan(project);
    const scenePlan = resolved.scenes.find((entry) => entry.sceneId === sceneId);
    if (!scenePlan) {
      throw new SceneRenderError(`Scene ${sceneId} not found.`, 'INVALID_PLAN');
    }

    const singleScenePlan = {
      ...resolved,
      scenes: [scenePlan],
      ready: scenePlan.status === 'renderable' && resolved.issues.every((issue) => issue.severity !== 'error')
    };

    const validation = validateRenderPlan(singleScenePlan);
    if (!validation.valid) {
      throw new SceneRenderError(validation.errors.map((issue) => issue.message).join(' '), 'INVALID_PLAN');
    }

    const renderId = createId('render');
    const paths = createSceneRenderPaths(projectId, sceneId, renderId);
    const { tempRoot } = await ensureRenderDirectories(projectId);

    let render: SceneRenderResult;
    try {
      render = await this.renderer.render(singleScenePlan, {
        projectId,
        sceneId,
        renderId,
        outputPath: paths.outputPath,
        tempDir: tempRoot,
        sceneWidth: singleScenePlan.width,
        sceneHeight: singleScenePlan.height,
        sceneFps: singleScenePlan.fps
      });
    } catch (error) {
      const failedScenePlan = singleScenePlan.scenes[0];
      const failedRender: SceneRenderResult = {
        renderId,
        sceneId,
        outputPath: paths.outputPath,
        createdAt: new Date().toISOString(),
        width: singleScenePlan.width,
        height: singleScenePlan.height,
        fps: singleScenePlan.fps,
        duration: failedScenePlan.duration,
        filesize: 0,
        mimeType: 'video/mp4',
        renderer: 'ffmpeg',
        status: 'failed',
        message: error instanceof Error ? error.message : 'Render failed.',
        renderFingerprint: createSceneRenderFingerprint(singleScenePlan, failedScenePlan)
      };

      await projectStore.mutateProject(projectId, (current) => ({
        ...current,
        scenes: current.scenes.map((scene) =>
          scene.id === sceneId ? { ...scene, renders: [failedRender, ...(scene.renders ?? [])] } : scene
        )
      }));

      throw error;
    }

    const relativeOutputPath = path.relative(getProjectRoot(projectId), render.outputPath).replace(/\\/g, '/');
    render.outputPath = relativeOutputPath;

    const persisted = await projectStore.mutateProject(projectId, (current) => ({
      ...current,
      scenes: current.scenes.map((scene) =>
        scene.id === sceneId ? { ...scene, renders: [render, ...(scene.renders ?? [])] } : scene
      )
    }));

    if (!persisted) {
      throw new SceneRenderError(`Project ${projectId} disappeared during render.`, 'INVALID_PLAN');
    }

    await fs.writeFile(paths.metadataPath, JSON.stringify(render, null, 2), 'utf8');

    return {
      projectId,
      sceneId,
      render
    };
  }
}

export const sceneRenderService = new SceneRenderService();
