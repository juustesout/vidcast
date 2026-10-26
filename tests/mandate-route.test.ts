import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DELETE as deleteMandateRoute, GET as getMandateRoute, POST as createMandateRoute } from '@/app/api/projects/[id]/mandates/route';
import { GET as getProjectFileRoute } from '@/app/api/projects/[id]/files/[...path]/route';
import { PUT as updateProjectRoute } from '@/app/api/projects/[id]/route';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { readProjectMandate } from '@/lib/storage/mandate-store';
import { projectStore } from '@/lib/storage/project-store';
import type { ProductionMandate } from '@/lib/types/mandate';

let originalCwd: string;
let tempRoot: string;

const SERVICE_TOKEN = 'service-token-mandate-route-32chars';

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mandate-route-'));
  process.chdir(tempRoot);
  delete process.env.EXPLAINER_API_TOKEN;
});

afterEach(async () => {
  process.chdir(originalCwd);
  delete process.env.EXPLAINER_API_TOKEN;
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

function sessionHeader(subject: string): string {
  return `${SESSION_COOKIE_NAME}=${createUserSessionCookie(subject)}`;
}

function context(projectId: string) {
  return { params: Promise.resolve({ id: projectId }) };
}

function postMandate(projectId: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  return createMandateRoute(
    new Request(`http://localhost/api/projects/${projectId}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {})
    }),
    context(projectId)
  );
}

function getMandate(projectId: string, headers: Record<string, string>): Promise<Response> {
  return getMandateRoute(new Request(`http://localhost/api/projects/${projectId}/mandates`, { headers }), context(projectId));
}

function deleteMandate(projectId: string, headers: Record<string, string>): Promise<Response> {
  return deleteMandateRoute(
    new Request(`http://localhost/api/projects/${projectId}/mandates`, { method: 'DELETE', headers }),
    context(projectId)
  );
}

describe('POST/GET/DELETE /api/projects/:id/mandates', () => {
  it('lets the owning user mint, read, and revoke a production mandate', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');

    const created = await postMandate(project.id, { brief: 'Author and produce this project' }, { cookie: sessionHeader('user-a') });
    const createdPayload = (await created.json()) as { mandate: ProductionMandate; live: boolean };

    expect(created.status).toBe(201);
    expect(createdPayload.live).toBe(true);
    expect(createdPayload.mandate.status).toBe('active');
    expect(createdPayload.mandate.issuedBy).toBe('user-a');
    expect(createdPayload.mandate.projectId).toBe(project.id);
    expect(createdPayload.mandate.allowedActions).toContain('run_production');

    const read = await getMandate(project.id, { cookie: sessionHeader('user-a') });
    const readPayload = (await read.json()) as { mandate: ProductionMandate };
    expect(read.status).toBe(200);
    expect(readPayload.mandate.mandateId).toBe(createdPayload.mandate.mandateId);

    const revoked = await deleteMandate(project.id, { cookie: sessionHeader('user-a') });
    const revokedPayload = (await revoked.json()) as { mandate: ProductionMandate };
    expect(revoked.status).toBe(200);
    expect(revokedPayload.mandate.status).toBe('revoked');
    expect((await readProjectMandate(project.id))?.status).toBe('revoked');
  });

  it('rejects unauthenticated mandate minting', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    const response = await postMandate(project.id, {}, {});
    expect(response.status).toBe(401);
  });

  it('hides another user\'s project from mandate minting', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    const response = await postMandate(project.id, {}, { cookie: sessionHeader('user-b') });
    expect(response.status).toBe(404);
  });

  it('forbids a service token from minting or revoking a mandate', async () => {
    process.env.EXPLAINER_API_TOKEN = SERVICE_TOKEN;
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');

    const minted = await postMandate(project.id, {}, { authorization: `Bearer ${SERVICE_TOKEN}` });
    expect(minted.status).toBe(403);
    expect(await readProjectMandate(project.id)).toBeNull();

    const userMint = await postMandate(project.id, {}, { cookie: sessionHeader('user-a') });
    expect(userMint.status).toBe(201);

    const revoked = await deleteMandate(project.id, { authorization: `Bearer ${SERVICE_TOKEN}` });
    expect(revoked.status).toBe(403);
    expect((await readProjectMandate(project.id))?.status).toBe('active');
  });

  it('lets a service token read mandate status without minting or revoking', async () => {
    process.env.EXPLAINER_API_TOKEN = SERVICE_TOKEN;
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');

    const missing = await getMandate(project.id, { authorization: `Bearer ${SERVICE_TOKEN}` });
    expect(missing.status).toBe(404);

    const userMint = await postMandate(project.id, { brief: 'Produce this project' }, { cookie: sessionHeader('user-a') });
    expect(userMint.status).toBe(201);

    const read = await getMandate(project.id, { authorization: `Bearer ${SERVICE_TOKEN}` });
    const payload = (await read.json()) as { mandate: ProductionMandate; live: boolean };
    expect(read.status).toBe(200);
    expect(payload.live).toBe(true);
    expect(payload.mandate.status).toBe('active');
    expect(payload.mandate.issuedBy).toBe('user-a');
    expect(payload.mandate.brief).toBe('Produce this project');
  });

  it('reports an expired mandate as not live on GET', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    const created = await postMandate(
      project.id,
      { ttlMs: 60_000, expiresAt: '2000-01-01T00:00:00.000Z' },
      { cookie: sessionHeader('user-a') }
    );
    expect(created.status).toBe(201);

    const read = await getMandate(project.id, { cookie: sessionHeader('user-a') });
    const payload = (await read.json()) as { mandate: ProductionMandate; live: boolean };
    expect(read.status).toBe(200);
    expect(payload.live).toBe(false);
    expect(payload.mandate.status).toBe('expired');
  });

  it('does not let update_project forge a mandate', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    const response = await updateProjectRoute(
      new Request(`http://localhost/api/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: sessionHeader('user-a') },
        body: JSON.stringify({
          title: 'Still owned',
          mandate: { status: 'active', issuedBy: 'forged' }
        })
      }),
      context(project.id)
    );

    expect(response.status).toBe(200);
    expect(await readProjectMandate(project.id)).toBeNull();
  });

  it('does not serve mandate.json through the project file route', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    await postMandate(project.id, {}, { cookie: sessionHeader('user-a') });

    const response = await getProjectFileRoute(
      new Request(`http://localhost/api/projects/${project.id}/files/mandate.json`, {
        headers: { cookie: sessionHeader('user-a') }
      }),
      { params: Promise.resolve({ id: project.id, path: ['mandate.json'] }) }
    );
    const payload = (await response.json()) as { message?: string };

    expect(response.status).toBe(400);
    expect(payload.message).toBe('Invalid file path.');
  });
});
