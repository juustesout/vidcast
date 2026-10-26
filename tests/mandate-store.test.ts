import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MandateStoreError,
  bindProjectMandateRun,
  createProjectMandate,
  readProjectMandate,
  requireLiveProjectMandate,
  resolveMandateStatus,
  revokeProjectMandate
} from '@/lib/storage/mandate-store';
import { getProjectMandatePath } from '@/lib/storage/storage-paths';

let originalCwd: string;
let tempRoot: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mandate-store-'));
  process.chdir(tempRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('mandate store', () => {
  it('creates a sibling mandate.json that is not project.json', async () => {
    const mandate = await createProjectMandate({ projectId: 'project-1', issuedBy: 'user-a', brief: 'Ship it' });
    const raw = await fs.readFile(getProjectMandatePath('project-1'), 'utf8');
    const stored = JSON.parse(raw) as { mandateId: string; projectId: string; status: string };

    expect(mandate.status).toBe('active');
    expect(mandate.issuedBy).toBe('user-a');
    expect(stored.mandateId).toBe(mandate.mandateId);
    expect(stored.projectId).toBe('project-1');
    expect(await fs.access(path.join(tempRoot, 'projects', 'project-1', 'project.json')).then(() => true, () => false)).toBe(false);
  });

  it('rejects a second active mandate for the same project', async () => {
    await createProjectMandate({ projectId: 'project-1', issuedBy: 'user-a' });
    await expect(createProjectMandate({ projectId: 'project-1', issuedBy: 'user-a' })).rejects.toMatchObject({
      code: 'MANDATE_CONFLICT',
      status: 409
    });
  });

  it('revokes an active mandate and refuses live use', async () => {
    await createProjectMandate({ projectId: 'project-1', issuedBy: 'user-a' });
    const revoked = await revokeProjectMandate('project-1');
    expect(revoked.status).toBe('revoked');
    await expect(requireLiveProjectMandate('project-1')).rejects.toMatchObject({ code: 'MANDATE_REVOKED', status: 403 });
  });

  it('treats an expired mandate as not live', async () => {
    const issuedAt = Date.parse('2026-01-01T00:00:00.000Z');
    await createProjectMandate(
      { projectId: 'project-1', issuedBy: 'user-a', ttlMs: 60_000 },
      () => issuedAt
    );
    const stored = await readProjectMandate('project-1');
    expect(stored).not.toBeNull();
    expect(resolveMandateStatus(stored!, issuedAt + 120_000)).toBe('expired');
    await expect(requireLiveProjectMandate('project-1', () => issuedAt + 120_000)).rejects.toMatchObject({
      code: 'MANDATE_EXPIRED'
    });
  });

  it('binds the first accepted production run and refuses a second run id', async () => {
    await createProjectMandate({ projectId: 'project-1', issuedBy: 'user-a' });
    const bound = await bindProjectMandateRun('project-1', 'run-1');
    expect(bound.status).toBe('consumed');
    expect(bound.boundRunId).toBe('run-1');
    await expect(bindProjectMandateRun('project-1', 'run-1')).resolves.toMatchObject({ boundRunId: 'run-1' });
    await expect(bindProjectMandateRun('project-1', 'run-2')).rejects.toMatchObject({ code: 'MANDATE_BOUND', status: 409 });
  });

  it('treats a bound mandate as expired after its TTL even during an active run', async () => {
    const issuedAt = Date.parse('2026-01-01T00:00:00.000Z');
    await createProjectMandate(
      { projectId: 'project-1', issuedBy: 'user-a', ttlMs: 60_000 },
      () => issuedAt
    );
    await bindProjectMandateRun('project-1', 'run-1', () => issuedAt + 1_000);
    const stored = await readProjectMandate('project-1');
    expect(stored?.status).toBe('consumed');
    expect(stored?.boundRunId).toBe('run-1');
    expect(resolveMandateStatus(stored!, issuedAt + 120_000)).toBe('expired');
    await expect(requireLiveProjectMandate('project-1', () => issuedAt + 120_000)).rejects.toMatchObject({
      code: 'MANDATE_EXPIRED',
      status: 403
    });
  });

  it('does not treat a missing mandate as live', async () => {
    await expect(requireLiveProjectMandate('missing')).rejects.toBeInstanceOf(MandateStoreError);
    await expect(requireLiveProjectMandate('missing')).rejects.toMatchObject({ code: 'MANDATE_NOT_FOUND', status: 403 });
  });
});
