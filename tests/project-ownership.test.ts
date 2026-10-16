import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PUT as updateProjectRoute } from '@/app/api/projects/[id]/route';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { projectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';

let originalCwd: string;
let tempRoot: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'project-ownership-'));
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

async function readOwner(projectId: string): Promise<string | undefined> {
  const raw = await fs.readFile(path.join(tempRoot, 'projects', projectId, 'project.json'), 'utf8');
  return (JSON.parse(raw) as Project).ownerId;
}

function putProject(projectId: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  return updateProjectRoute(
    new Request(`http://localhost/api/projects/${projectId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ id: projectId }) }
  );
}

describe('PUT /api/projects/:id ownership immutability', () => {
  it('lets the owner update content but never reassign ownership', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user_owner');

    const response = await putProject(
      project.id,
      { ...project, title: 'Renamed', ownerId: 'user_attacker' },
      { cookie: sessionHeader('user_owner') }
    );

    expect(response.status).toBe(200);
    expect(await readOwner(project.id)).toBe('user_owner');
    const stored = await projectStore.getProject(project.id);
    expect(stored?.title).toBe('Renamed');
    expect(stored?.ownerId).toBe('user_owner');
  });

  it('does not let an owner clear ownership', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user_owner');

    const response = await putProject(project.id, { title: 'Still mine', ownerId: undefined }, { cookie: sessionHeader('user_owner') });

    expect(response.status).toBe(200);
    expect(await readOwner(project.id)).toBe('user_owner');
  });

  it('does not let a service token assign ownership to a browser subject', async () => {
    process.env.EXPLAINER_API_TOKEN = 'service-token-1234567890';
    const project = await projectStore.createProject({ title: 'Service' });

    const response = await putProject(
      project.id,
      { title: 'x', ownerId: 'user_x' },
      { authorization: 'Bearer service-token-1234567890' }
    );

    expect(response.status).toBe(200);
    expect(await readOwner(project.id)).toBeUndefined();
    expect((await projectStore.getProject(project.id))?.ownerId).toBeUndefined();
  });

  it('does not let a service token strip an existing owner', async () => {
    process.env.EXPLAINER_API_TOKEN = 'service-token-1234567890';
    const project = await projectStore.createProject({ title: 'Owned' }, 'user_owner');

    const response = await putProject(
      project.id,
      { title: 'x', ownerId: undefined },
      { authorization: 'Bearer service-token-1234567890' }
    );

    expect(response.status).toBe(200);
    expect(await readOwner(project.id)).toBe('user_owner');
  });

  it('still applies normal owner content updates', async () => {
    const project = await projectStore.createProject({ title: 'Owned', description: 'before' }, 'user_owner');

    const response = await putProject(project.id, { description: 'after' }, { cookie: sessionHeader('user_owner') });

    expect(response.status).toBe(200);
    const stored = await projectStore.getProject(project.id);
    expect(stored?.title).toBe('Owned');
    expect(stored?.description).toBe('after');
    expect(stored?.ownerId).toBe('user_owner');
  });
});
