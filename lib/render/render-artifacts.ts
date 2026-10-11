import path from 'node:path';

import { getProjectRendersRoot } from '@/lib/storage/storage-paths';

export interface SceneRenderPaths {
  rendersRoot: string;
  /**
   * Per-render scratch directory. Each render must own a unique temp directory
   * so concurrent renders in the same project cannot delete each other's files.
   */
  tempRoot: string;
  outputPath: string;
  metadataPath: string;
}

export function createSceneRenderPaths(projectId: string, sceneId: string, renderId: string): SceneRenderPaths {
  const rendersRoot = getProjectRendersRoot(projectId);
  const safeSceneId = sceneId.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const outputFilename = `${safeSceneId}-render-${renderId}.mp4`;
  const metadataFilename = `${safeSceneId}-render-${renderId}.json`;
  return {
    rendersRoot,
    tempRoot: path.join(rendersRoot, '.tmp', renderId),
    outputPath: path.join(rendersRoot, outputFilename),
    metadataPath: path.join(rendersRoot, metadataFilename)
  };
}
