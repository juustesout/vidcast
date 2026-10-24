import { projectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';

import { htmlStillAssetIsCurrent } from './fingerprint';
import { resolveHtmlStillImages, type ResolvedHtmlStillImage } from './image-assets';
import { renderSceneHtmlStill } from './service';

export class HtmlStillRefreshError extends Error {
  readonly code: 'html.project.notFound' | 'html.scene.invalidVisualKind' | 'html.stale';

  constructor(code: HtmlStillRefreshError['code'], message: string) {
    super(message);
    this.name = 'HtmlStillRefreshError';
    this.code = code;
  }
}

export async function refreshHtmlStillIfStale(project: Project, sceneId: string): Promise<Project> {
  const scene = project.scenes.find((entry) => entry.id === sceneId);
  if (!scene || scene.visual?.kind !== 'html') {
    return project;
  }

  const visual = scene.visual;
  const images: ResolvedHtmlStillImage[] = await resolveHtmlStillImages(project, visual);

  if (htmlStillAssetIsCurrent(visual, images)) {
    return project;
  }

  await renderSceneHtmlStill(project.id, sceneId);

  const refreshed = await projectStore.getProject(project.id);
  if (!refreshed) {
    throw new HtmlStillRefreshError('html.project.notFound', `Project ${project.id} disappeared during HTML still render.`);
  }

  const refreshedScene = refreshed.scenes.find((entry) => entry.id === sceneId);
  if (!refreshedScene || refreshedScene.visual?.kind !== 'html') {
    throw new HtmlStillRefreshError('html.scene.invalidVisualKind', `Scene ${sceneId} is no longer an HTML still after refresh.`);
  }

  const refreshedImages: ResolvedHtmlStillImage[] = await resolveHtmlStillImages(refreshed, refreshedScene.visual);

  if (!htmlStillAssetIsCurrent(refreshedScene.visual, refreshedImages)) {
    throw new HtmlStillRefreshError('html.stale', `HTML still for scene ${sceneId} is still stale after refresh.`);
  }

  return refreshed;
}
