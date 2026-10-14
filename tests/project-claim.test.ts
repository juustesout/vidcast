import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { projectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';

let originalCwd: string;
let tempRoot: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'project-claim-'));
  process.chdir(tempRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

function projectJsonPath(projectId: string): string {
  return path.join(tempRoot, 'projects', projectId, 'project.json');
}

async function readOwner(projectId: string): Promise<string | undefined> {
  const raw = await fs.readFile(projectJsonPath(projectId), 'utf8');
  return (JSON.parse(raw) as Project).ownerId;
}

describe('claimUnownedProjects', () => {
  it('claims every unowned project and reports the count', async () => {
    const first = await projectStore.createProject({ title: 'First' });
    const second = await projectStore.createProject({ title: 'Second' });

    const claimed = await projectStore.claimUnownedProjects('user_owner');

    expect(claimed).toBe(2);
    expect(await readOwner(first.id)).toBe('user_owner');
    expect(await readOwner(second.id)).toBe('user_owner');
  });

  it('does not touch a project already owned by another subject', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user_first');
    const before = await fs.readFile(projectJsonPath(project.id), 'utf8');

    const claimed = await projectStore.claimUnownedProjects('user_second');
    const after = await fs.readFile(projectJsonPath(project.id), 'utf8');

    expect(claimed).toBe(0);
    expect(after).toBe(before);
    expect(await readOwner(project.id)).toBe('user_first');
  });

  it('does not re-claim a project already owned by the same subject', async () => {
    await projectStore.createProject({ title: 'Mine' });

    expect(await projectStore.claimUnownedProjects('user_me')).toBe(1);
    expect(await projectStore.claimUnownedProjects('user_me')).toBe(0);
  });

  it('assigns a single owner when two subjects claim concurrently', async () => {
    const project = await projectStore.createProject({ title: 'Contended' });

    const [first, second] = await Promise.all([
      projectStore.claimUnownedProjects('user_a'),
      projectStore.claimUnownedProjects('user_b')
    ]);

    expect(first + second).toBe(1);
    expect(['user_a', 'user_b']).toContain(await readOwner(project.id));
  });

  it('skips unreadable projects and still claims the readable ones', async () => {
    const good = await projectStore.createProject({ title: 'Readable' });

    const corruptDir = path.join(tempRoot, 'projects', 'project-corrupt');
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.writeFile(path.join(corruptDir, 'project.json'), '{ "id": "project-corrupt", ', 'utf8');

    const missingDir = path.join(tempRoot, 'projects', 'project-missing-json');
    await fs.mkdir(missingDir, { recursive: true });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const claimed = await projectStore.claimUnownedProjects('user_owner');
    warn.mockRestore();

    expect(claimed).toBe(1);
    expect(await readOwner(good.id)).toBe('user_owner');
  });
});
