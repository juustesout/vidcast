import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as getCompositionFileRoute } from '@/app/api/projects/[id]/compositions/[compositionId]/file/route';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import { projectStore } from '@/lib/storage/project-store';
import type { CompositionArtifact } from '@/lib/types/render';

let originalCwd: string;
let tempRoot: string;

const FIXTURE_BYTES = Buffer.from('ftypisomP159-composition-file-route-fixture');
const RELATIVE_OUTPUT_PATH = 'renders/compositions/final-composition-1.mp4';

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'composition-file-route-'));
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

function makeComposition(projectId: string, overrides: Partial<CompositionArtifact> = {}): CompositionArtifact {
  return {
    compositionId: 'comp-1',
    projectId,
    outputPath: RELATIVE_OUTPUT_PATH,
    createdAt: '2026-01-01T00:00:00.000Z',
    sceneIds: ['scene-1'],
    duration: 3,
    width: 640,
    height: 360,
    fps: 30,
    renderer: 'ffmpeg',
    version: 'p10.1',
    filesize: FIXTURE_BYTES.length,
    mimeType: 'video/mp4',
    transition: { type: 'none' },
    ...overrides
  };
}

async function attachComposition(projectId: string, overrides: Partial<CompositionArtifact> = {}) {
  const updated = await projectStore.mutateProject(projectId, (current) => ({
    ...current,
    compositions: [makeComposition(projectId, overrides)]
  }));
  if (!updated) {
    throw new Error(`Failed to attach composition to ${projectId}`);
  }
  return updated;
}

async function writeFixture(projectId: string, relativePath = RELATIVE_OUTPUT_PATH, bytes = FIXTURE_BYTES): Promise<string> {
  const filePath = path.join(getProjectRoot(projectId), relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
  return filePath;
}

function request(projectId: string, compositionId: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/projects/${projectId}/compositions/${compositionId}/file`, { headers });
}

function context(projectId: string, compositionId: string) {
  return { params: Promise.resolve({ id: projectId, compositionId }) };
}

function getFile(projectId: string, compositionId: string, headers: Record<string, string> = {}): Promise<Response> {
  return getCompositionFileRoute(request(projectId, compositionId, headers), context(projectId, compositionId));
}

describe('GET /api/projects/:id/compositions/:compositionId/file', () => {
  it('returns 401 without authentication', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    await attachComposition(project.id);
    await writeFixture(project.id);

    const response = await getFile(project.id, 'comp-1');
    const payload = (await response.json()) as { message?: string; code?: string };

    expect(response.status).toBe(401);
    expect(payload.code).toBe('UNAUTHENTICATED');
    expect(payload.message).toBe('Authentication required.');
  });

  it('returns 404 when another user does not own the project', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    await attachComposition(project.id);
    await writeFixture(project.id);

    const response = await getFile(project.id, 'comp-1', { cookie: sessionHeader('user-b') });
    const payload = (await response.json()) as { message?: string; code?: string };

    expect(response.status).toBe(404);
    expect(payload.code).toBe('NOT_FOUND');
    expect(payload.message).toBe('Project not found.');
  });

  it('returns 404 for an unknown composition id', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    await attachComposition(project.id);
    await writeFixture(project.id);

    const response = await getFile(project.id, 'missing-comp', { cookie: sessionHeader('user-a') });
    const payload = (await response.json()) as { message?: string; code?: string };

    expect(response.status).toBe(404);
    expect(payload.message).toBe('Composition not found.');
    expect(payload.code).toBeUndefined();
  });

  it('returns 404 when the composition exists but the file is missing on disk', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    await attachComposition(project.id);

    const response = await getFile(project.id, 'comp-1', { cookie: sessionHeader('user-a') });
    const payload = (await response.json()) as { message?: string; code?: string };

    expect(response.status).toBe(404);
    expect(payload.message).toBe('Composition file missing on disk.');
    expect(payload.code).toBeUndefined();
  });

  it('returns 400 when outputPath contains parent-directory segments', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    await attachComposition(project.id, { outputPath: '../secret.mp4' });

    const response = await getFile(project.id, 'comp-1', { cookie: sessionHeader('user-a') });
    const payload = (await response.json()) as { message?: string; code?: string };

    expect(response.status).toBe(400);
    expect(payload.message).toBe('Invalid composition path.');
    expect(payload.code).toBeUndefined();
  });

  it('returns 400 when outputPath is absolute', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    await attachComposition(project.id, { outputPath: '/tmp/outside.mp4' });

    const response = await getFile(project.id, 'comp-1', { cookie: sessionHeader('user-a') });
    const payload = (await response.json()) as { message?: string; code?: string };

    expect(response.status).toBe(400);
    expect(payload.message).toBe('Invalid composition path.');
    expect(payload.code).toBeUndefined();
  });

  it('returns 200 with video/mp4 bytes matching the on-disk fixture', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    await attachComposition(project.id);
    const fixturePath = await writeFixture(project.id);
    const expected = await fs.readFile(fixturePath);

    const response = await getFile(project.id, 'comp-1', { cookie: sessionHeader('user-a') });
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(body.equals(expected)).toBe(true);
    expect(body.equals(FIXTURE_BYTES)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });
});
