import fs from 'node:fs/promises';
import path from 'node:path';

import { getProjectRendersRoot } from '@/lib/storage/storage-paths';

export interface SceneRenderPaths {
  rendersRoot: string;
  tempRoot: string;
  outputPath: string;
  metadataPath: string;
}

export async function ensureRenderDirectories(projectId: string): Promise<{ rendersRoot: string; tempRoot: string }> {
  const rendersRoot = getProjectRendersRoot(projectId);
  const tempRoot = path.join(rendersRoot, '.tmp');
  await fs.mkdir(rendersRoot, { recursive: true });
  await fs.mkdir(tempRoot, { recursive: true });
  return { rendersRoot, tempRoot };
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
