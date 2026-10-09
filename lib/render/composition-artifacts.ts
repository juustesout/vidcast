import fs from 'node:fs/promises';
import path from 'node:path';

import { getProjectRendersRoot } from '@/lib/storage/storage-paths';

export interface CompositionPaths {
  compositionsRoot: string;
  tempRoot: string;
  outputPath: string;
  relativeOutputPath: string;
  metadataPath: string;
}

export async function ensureCompositionDirectories(projectId: string): Promise<{ compositionsRoot: string; tempRoot: string }> {
  const compositionsRoot = path.join(getProjectRendersRoot(projectId), 'compositions');
  const tempRoot = path.join(compositionsRoot, '.tmp');
  await fs.mkdir(compositionsRoot, { recursive: true });
  await fs.mkdir(tempRoot, { recursive: true });
  return { compositionsRoot, tempRoot };
}

export function createCompositionPaths(projectId: string, compositionId: string): CompositionPaths {
  const compositionsRoot = path.join(getProjectRendersRoot(projectId), 'compositions');
  const filename = `final-${compositionId}.mp4`;
  const metadataFilename = `final-${compositionId}.json`;
  return {
    compositionsRoot,
    tempRoot: path.join(compositionsRoot, '.tmp', compositionId),
    outputPath: path.join(compositionsRoot, filename),
    relativeOutputPath: `renders/compositions/${filename}`,
    metadataPath: path.join(compositionsRoot, metadataFilename)
  };
}
