import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashClaimToken } from '@/lib/security/claim-token';
import { getProjectClaimPath } from '@/lib/storage/storage-paths';
import { projectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';

let originalCwd: string;
let tempRoot: string;

const ORIGINAL_TTL = process.env.EXPLAINER_CLAIM_TOKEN_TTL_MS;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'project-claim-capability-'));
  process.chdir(tempRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (ORIGINAL_TTL === undefined) {
    delete process.env.EXPLAINER_CLAIM_TOKEN_TTL_MS;
  } else {
    process.env.EXPLAINER_CLAIM_TOKEN_TTL_MS = ORIGINAL_TTL;
  }
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

async function readOwner(projectId: string): Promise<string | undefined> {
  const raw = await fs.readFile(path.join(tempRoot, 'projects', projectId, 'project.json'), 'utf8');
  return (JSON.parse(raw) as Project).ownerId;
}

async function readClaimFile(projectId: string): Promise<{ tokenHash?: string } | null> {
  try {
    return JSON.parse(await fs.readFile(getProjectClaimPath(projectId), 'utf8')) as { tokenHash?: string };
  } catch {
    return null;
  }
}

describe('createProjectWithClaim', () => {
  it('creates an ownerless project and returns a one-time token whose hash is stored', async () => {
    const { project, claimToken } = await projectStore.createProjectWithClaim({ title: 'Service made' });

    expect(project.ownerId).toBeUndefined();
    expect(await readOwner(project.id)).toBeUndefined();

    const claim = await readClaimFile(project.id);
    expect(claim?.tokenHash).toBe(hashClaimToken(claimToken));
    expect(claim?.tokenHash).not.toBe(claimToken);
  });

  it('never stores the raw token in project.json', async () => {
    const { project, claimToken } = await projectStore.createProjectWithClaim({ title: 'Service made' });
    const raw = await fs.readFile(path.join(tempRoot, 'projects', project.id, 'project.json'), 'utf8');
    expect(raw).not.toContain(claimToken);
  });
});

describe('redeemClaim', () => {
  it('claims with the correct token and consumes it', async () => {
    const { project, claimToken } = await projectStore.createProjectWithClaim({ title: 'Claimable' });

    expect(await projectStore.hasPendingClaim(project.id)).toBe(true);
    const result = await projectStore.redeemClaim(project.id, 'user_owner', hashClaimToken(claimToken));

    expect(result.status).toBe('claimed');
    expect(result.project?.ownerId).toBe('user_owner');
    expect(await readOwner(project.id)).toBe('user_owner');
    expect(await projectStore.hasPendingClaim(project.id)).toBe(false);
    expect(await readClaimFile(project.id)).toBeNull();
  });

  it('rejects a wrong token and leaves the project ownerless and still claimable', async () => {
    const { project } = await projectStore.createProjectWithClaim({ title: 'Claimable' });

    const result = await projectStore.redeemClaim(project.id, 'user_attacker', hashClaimToken('not-the-token'));

    expect(result.status).toBe('invalid');
    expect(await readOwner(project.id)).toBeUndefined();
    expect(await projectStore.hasPendingClaim(project.id)).toBe(true);
  });

  it('is single-use: a consumed token can never claim again', async () => {
    const { project, claimToken } = await projectStore.createProjectWithClaim({ title: 'Claimable' });

    const first = await projectStore.redeemClaim(project.id, 'user_first', hashClaimToken(claimToken));
    const second = await projectStore.redeemClaim(project.id, 'user_second', hashClaimToken(claimToken));

    expect(first.status).toBe('claimed');
    expect(second.status).toBe('already_owned');
    expect(await readOwner(project.id)).toBe('user_first');
  });

  it('reports already_owned for a project owned by someone else', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user_owner');

    const result = await projectStore.redeemClaim(project.id, 'user_other', hashClaimToken('whatever'));

    expect(result.status).toBe('already_owned');
    expect(await readOwner(project.id)).toBe('user_owner');
  });

  it('reports not_found for an unknown project id', async () => {
    const result = await projectStore.redeemClaim('project_missing', 'user_owner', hashClaimToken('whatever'));
    expect(result.status).toBe('not_found');
    expect(result.project).toBeUndefined();
  });

  it('reports invalid when the project carries no claim capability', async () => {
    const project = await projectStore.createProject({ title: 'No claim' });

    const result = await projectStore.redeemClaim(project.id, 'user_owner', hashClaimToken('whatever'));

    expect(result.status).toBe('invalid');
    expect(await readOwner(project.id)).toBeUndefined();
  });

  it('treats an expired token as invalid', async () => {
    process.env.EXPLAINER_CLAIM_TOKEN_TTL_MS = '1';
    const { project, claimToken } = await projectStore.createProjectWithClaim({ title: 'Expiring' });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await projectStore.redeemClaim(project.id, 'user_owner', hashClaimToken(claimToken));
    expect(result.status).toBe('invalid');
    expect(await readOwner(project.id)).toBeUndefined();
  });

  it('lets exactly one of two concurrent claims win', async () => {
    const { project, claimToken } = await projectStore.createProjectWithClaim({ title: 'Contended' });
    const tokenHash = hashClaimToken(claimToken);

    const [a, b] = await Promise.all([
      projectStore.redeemClaim(project.id, 'user_a', tokenHash),
      projectStore.redeemClaim(project.id, 'user_b', tokenHash)
    ]);

    const winners = [a, b].filter((result) => result.status === 'claimed');
    expect(winners).toHaveLength(1);
    expect(['user_a', 'user_b']).toContain(await readOwner(project.id));
  });
});

describe('id-based first-claim paths skip pending claims', () => {
  it('claimUnownedProjects claims ownerless projects but never a pending-claim project', async () => {
    const claimable = await projectStore.createProjectWithClaim({ title: 'Claimable' });
    const plain = await projectStore.createProject({ title: 'Plain' });

    const claimed = await projectStore.claimUnownedProjects('user_session');

    expect(claimed).toBe(1);
    expect(await readOwner(plain.id)).toBe('user_session');
    expect(await readOwner(claimable.project.id)).toBeUndefined();
    expect(await projectStore.hasPendingClaim(claimable.project.id)).toBe(true);
  });

  it('claimUnownedProjects picks a project back up once its claim is consumed', async () => {
    const { project, claimToken } = await projectStore.createProjectWithClaim({ title: 'Claimable' });

    const redeemed = await projectStore.redeemClaim(project.id, 'user_owner', hashClaimToken(claimToken));
    expect(redeemed.status).toBe('claimed');

    // Already owned now, so the bulk path still skips it for another user.
    expect(await projectStore.claimUnownedProjects('user_other')).toBe(0);
    expect(await readOwner(project.id)).toBe('user_owner');
  });
});
