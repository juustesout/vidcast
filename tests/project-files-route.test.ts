import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as getProjectFileRoute } from '@/app/api/projects/[id]/files/[...path]/route';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import { projectStore } from '@/lib/storage/project-store';

let originalCwd: string;
let tempRoot: string;

const FIXTURE_BYTES = Buffer.from('p178-project-file-fixture');

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'project-files-route-'));
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

function request(projectId: string, segments: string[], headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/projects/${projectId}/files/${segments.map(encodeURIComponent).join('/')}`, { headers });
}

function context(projectId: string, segments: string[]) {
  return { params: Promise.resolve({ id: projectId, path: segments }) };
}

function getFile(projectId: string, segments: string[], headers: Record<string, string> = {}): Promise<Response> {
  return getProjectFileRoute(request(projectId, segments, headers), context(projectId, segments));
}

describe('GET /api/projects/:id/files/[...path]', () => {
  it('returns 401 without authentication', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    const response = await getFile(project.id, ['assets', 'ok.png']);
    const payload = (await response.json()) as { code?: string };

    expect(response.status).toBe(401);
    expect(payload.code).toBe('UNAUTHENTICATED');
  });

  it('returns 200 for an owned in-project asset', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    const filePath = path.join(getProjectRoot(project.id), 'assets', 'ok.png');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, FIXTURE_BYTES);

    const response = await getFile(project.id, ['assets', 'ok.png'], { cookie: sessionHeader('user-a') });
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(body.equals(FIXTURE_BYTES)).toBe(true);
  });

  it('returns 400 for parent-directory segments', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    const secretPath = path.join(tempRoot, 'secret.txt');
    await fs.writeFile(secretPath, 'secret');

    const response = await getFile(project.id, ['assets', '..', 'secret.txt'], { cookie: sessionHeader('user-a') });
    const payload = (await response.json()) as { message?: string };

    expect(response.status).toBe(400);
    expect(payload.message).toBe('Invalid file path.');
  });

  it('returns 400 for encoded parent-directory segments', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    const response = await getFile(project.id, ['assets', '%2e%2e', 'secret.txt'], { cookie: sessionHeader('user-a') });
    const payload = (await response.json()) as { message?: string };

    expect(response.status).toBe(400);
    expect(payload.message).toBe('Invalid file path.');
  });

  it('returns 400 for a sibling path that would only match the project root as a string prefix', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    const siblingRoot = `${getProjectRoot(project.id)}-evil`;
    const siblingFile = path.join(siblingRoot, 'assets', 'leak.png');
    await fs.mkdir(path.dirname(siblingFile), { recursive: true });
    await fs.writeFile(siblingFile, Buffer.from('leaked'));

    const response = await getFile(
      project.id,
      ['assets', '..', '..', `${project.id}-evil`, 'assets', 'leak.png'],
      { cookie: sessionHeader('user-a') }
    );
    const payload = (await response.json()) as { message?: string };

    expect(response.status).toBe(400);
    expect(payload.message).toBe('Invalid file path.');
  });
});
