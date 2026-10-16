import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as createProjectRoute } from '@/app/api/projects/route';
import { GET as getProjectRoute } from '@/app/api/projects/[id]/route';
import { POST as claimProjectRoute } from '@/app/api/projects/[id]/claim/route';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { projectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';

let originalCwd: string;
let tempRoot: string;

const SERVICE_TOKEN = 'service-token-claim-route';

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'project-claim-route-'));
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

function createRequest(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return createProjectRoute(
    new Request('http://localhost/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {})
    })
  );
}

function claimRequest(projectId: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return claimProjectRoute(
    new Request(`http://localhost/api/projects/${projectId}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {})
    }),
    { params: Promise.resolve({ id: projectId }) }
  );
}

function getProject(projectId: string, headers: Record<string, string> = {}): Promise<Response> {
  return getProjectRoute(new Request(`http://localhost/api/projects/${projectId}`, { headers }), {
    params: Promise.resolve({ id: projectId })
  });
}

async function readOwner(projectId: string): Promise<string | undefined> {
  const raw = await fs.readFile(path.join(tempRoot, 'projects', projectId, 'project.json'), 'utf8');
  return (JSON.parse(raw) as Project).ownerId;
}

describe('POST /api/projects claim token issuance', () => {
  it('returns a one-time claimToken to a service caller and stores no owner', async () => {
    process.env.EXPLAINER_API_TOKEN = SERVICE_TOKEN;

    const response = await createRequest({ title: 'Made by Hermes' }, { authorization: `Bearer ${SERVICE_TOKEN}` });
    const payload = (await response.json()) as { project: { id: string; ownerId?: string }; claimToken?: string };

    expect(response.status).toBe(201);
    expect(payload.project.ownerId).toBeUndefined();
    expect(typeof payload.claimToken).toBe('string');
    expect(payload.claimToken?.length).toBeGreaterThanOrEqual(40);
    expect(await readOwner(payload.project.id)).toBeUndefined();
  });

  it('does not return a claimToken to a user and assigns ownership directly', async () => {
    const response = await createRequest({ title: 'Made by user' }, { cookie: sessionHeader('user_owner') });
    const payload = (await response.json()) as { project: { id: string; ownerId?: string }; claimToken?: string };

    expect(response.status).toBe(201);
    expect(payload.claimToken).toBeUndefined();
    expect(payload.project.ownerId).toBe('user_owner');
  });
});

describe('POST /api/projects/:id/claim', () => {
  it('lets the intended user claim a service project and then read it', async () => {
    process.env.EXPLAINER_API_TOKEN = SERVICE_TOKEN;
    const created = await createRequest({ title: 'Claimable' }, { authorization: `Bearer ${SERVICE_TOKEN}` });
    const { project, claimToken } = (await created.json()) as { project: { id: string }; claimToken: string };

    const response = await claimRequest(project.id, { token: claimToken }, { cookie: sessionHeader('user_owner') });
    const payload = (await response.json()) as { project?: { ownerId?: string } };

    expect(response.status).toBe(200);
    expect(payload.project?.ownerId).toBe('user_owner');
    expect(await readOwner(project.id)).toBe('user_owner');

    const read = await getProject(project.id, { cookie: sessionHeader('user_owner') });
    expect(read.status).toBe(200);
  });

  it('never exposes the claim token or its hash through a project read', async () => {
    process.env.EXPLAINER_API_TOKEN = SERVICE_TOKEN;
    const created = await createRequest({ title: 'Claimable' }, { authorization: `Bearer ${SERVICE_TOKEN}` });
    const { project, claimToken } = (await created.json()) as { project: { id: string }; claimToken: string };

    await claimRequest(project.id, { token: claimToken }, { cookie: sessionHeader('user_owner') });

    const read = await getProject(project.id, { cookie: sessionHeader('user_owner') });
    const body = await read.text();
    expect(body).not.toContain(claimToken);
    expect(body).not.toContain('claimToken');
    expect(body).not.toContain('tokenHash');
  });

  it('rejects a service token', async () => {
    process.env.EXPLAINER_API_TOKEN = SERVICE_TOKEN;
    const created = await createRequest({ title: 'Claimable' }, { authorization: `Bearer ${SERVICE_TOKEN}` });
    const { project, claimToken } = (await created.json()) as { project: { id: string }; claimToken: string };

    const response = await claimRequest(project.id, { token: claimToken }, { authorization: `Bearer ${SERVICE_TOKEN}` });

    expect(response.status).toBe(403);
    expect(await readOwner(project.id)).toBeUndefined();
  });

  it('requires authentication', async () => {
    const project = (await projectStore.createProjectWithClaim({ title: 'Claimable' })).project;

    const response = await claimRequest(project.id, { token: 'whatever' });

    expect(response.status).toBe(401);
  });

  it('rejects a missing or wrong token without claiming', async () => {
    const { project, claimToken } = await projectStore.createProjectWithClaim({ title: 'Claimable' });

    const missing = await claimRequest(project.id, {}, { cookie: sessionHeader('user_owner') });
    const wrong = await claimRequest(project.id, { token: `${claimToken}x` }, { cookie: sessionHeader('user_owner') });

    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(await readOwner(project.id)).toBeUndefined();
  });

  it('returns 404 for an unknown project', async () => {
    const response = await claimRequest('project_missing', { token: 'whatever' }, { cookie: sessionHeader('user_owner') });
    expect(response.status).toBe(404);
  });

  it('returns 409 when the project is already owned', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user_owner');

    const response = await claimRequest(project.id, { token: 'whatever' }, { cookie: sessionHeader('user_other') });

    expect(response.status).toBe(409);
    expect(await readOwner(project.id)).toBe('user_owner');
  });

  it('cannot be replayed after a successful claim', async () => {
    const { project, claimToken } = await projectStore.createProjectWithClaim({ title: 'Claimable' });

    const first = await claimRequest(project.id, { token: claimToken }, { cookie: sessionHeader('user_first') });
    const second = await claimRequest(project.id, { token: claimToken }, { cookie: sessionHeader('user_second') });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await readOwner(project.id)).toBe('user_first');
  });

  it('lets only the token holder claim when another user knows the id', async () => {
    const { project } = await projectStore.createProjectWithClaim({ title: 'Claimable' });

    const response = await claimRequest(project.id, { token: 'guessed' }, { cookie: sessionHeader('user_attacker') });

    expect(response.status).toBe(403);
    expect(await readOwner(project.id)).toBeUndefined();
  });
});
