import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveRenderPlan } from './scene-resolver';
import { validateRenderPlan } from './render-plan-validator';
import { createSceneRenderPaths } from './render-artifacts';
import { LocalFFmpegRenderer, type Renderer, SceneRenderError } from './renderer';
import { projectStore } from '@/lib/storage/project-store';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import type { Project, SceneRenderResult } from '@/lib/types/render';
import { createId } from '@/lib/utils/ids';
import { createSceneRenderFingerprint } from './render-fingerprint';
import { HtmlStillError } from './html-still/errors';
import { HtmlStillRefreshError, refreshHtmlStillIfStale } from './html-still/freshness';

export interface SceneRenderServiceResult {
  projectId: string;
  sceneId: string;
  render: SceneRenderResult;
}

function htmlStillRenderError(error: HtmlStillError | HtmlStillRefreshError): SceneRenderError {
  if (error instanceof HtmlStillError && (error.code === 'html.image.missing' || error.code === 'html.project.notFound' || error.code === 'html.scene.notFound')) {
    return new SceneRenderError(error.message, 'MISSING_ASSET', error.code);
  }
  if (error instanceof HtmlStillRefreshError && error.code === 'html.project.notFound') {
    return new SceneRenderError(error.message, 'INVALID_PLAN', error.code);
  }
  const details = error instanceof HtmlStillError ? error.code : error.code;
  return new SceneRenderError(error.message, 'INVALID_PLAN', details);
}

async function ensureHtmlStillCurrent(project: Project, sceneId: string): Promise<Project> {
  try {
    return await refreshHtmlStillIfStale(project, sceneId);
  } catch (error) {
    if (error instanceof HtmlStillError || error instanceof HtmlStillRefreshError) {
      throw htmlStillRenderError(error);
    }
    throw error;
  }
}

export class SceneRenderService {
  private readonly renderer: Renderer;

  constructor(renderer: Renderer = new LocalFFmpegRenderer()) {
    this.renderer = renderer;
  }

  async renderScene(projectId: string, sceneId: string): Promise<SceneRenderServiceResult> {
    const loaded = await projectStore.getProject(projectId);
    if (!loaded) {
      throw new SceneRenderError(`Project ${projectId} not found.`, 'INVALID_PLAN');
    }

    const project = await ensureHtmlStillCurrent(loaded, sceneId);

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
    await fs.mkdir(paths.rendersRoot, { recursive: true });

    let render: SceneRenderResult;
    try {
      render = await this.renderer.render(singleScenePlan, {
        projectId,
        sceneId,
        renderId,
        outputPath: paths.outputPath,
        tempDir: paths.tempRoot,
        sceneWidth: singleScenePlan.width,
        sceneHeight: singleScenePlan.height,
        sceneFps: singleScenePlan.fps,
        fit: singleScenePlan.fit
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
