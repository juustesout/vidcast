import fs from 'node:fs/promises';
import path from 'node:path';

import { getProjectClaimPath } from './storage-paths';

/**
 * Server-side record of a single-use project claim capability. Only the token
 * hash is stored; the raw token lives exclusively with the service caller that
 * created the project. It is kept in a sibling `claim.json` next to
 * `project.json` so it can never leak through project read/update responses or
 * the generic project file route (which only serves assets/references/renders/
 * previews).
 */
export interface ProjectClaimRecord {
  tokenHash: string;
  createdAt: string;
  expiresAt?: string;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export async function writeProjectClaim(projectId: string, record: ProjectClaimRecord): Promise<void> {
  const target = getProjectClaimPath(projectId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(record, null, 2), 'utf8');
}

export async function readProjectClaim(projectId: string): Promise<ProjectClaimRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(getProjectClaimPath(projectId), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }

  let parsed: Partial<ProjectClaimRecord>;
  try {
    parsed = JSON.parse(raw) as Partial<ProjectClaimRecord>;
  } catch {
    return null;
  }

  if (typeof parsed.tokenHash !== 'string' || !parsed.tokenHash) {
    return null;
  }

  return {
    tokenHash: parsed.tokenHash,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : undefined
  };
}

export async function deleteProjectClaim(projectId: string): Promise<void> {
  await fs.rm(getProjectClaimPath(projectId), { force: true });
}
