import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { projectStore, ProjectReadError } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let originalCwd: string;
let tempRoot: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'project-store-lock-'));
  process.chdir(tempRoot);
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

async function readRawProject(projectId: string): Promise<Project> {
  const raw = await fs.readFile(path.join(tempRoot, 'projects', projectId, 'project.json'), 'utf8');
  return JSON.parse(raw) as Project;
}

describe('project store concurrent writes', () => {
  it('serializes concurrent mutations without losing updates', async () => {
    const project = await projectStore.createProject({ title: 'Concurrent updates' });

    await Promise.all([
      projectStore.mutateProject(project.id, async (current) => {
        await delay(25);
        return { ...current, description: 'updated-by-a' };
      }),
      projectStore.mutateProject(project.id, async (current) => {
        await delay(5);
        return { ...current, ownerId: 'owner-b' };
      })
    ]);

    const final = await projectStore.getProject(project.id);
    expect(final?.description).toBe('updated-by-a');
    expect(final?.ownerId).toBe('owner-b');
  });

  it('keeps project.json valid when many mutations race', async () => {
    const project = await projectStore.createProject({ title: 'Many writers' });

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        projectStore.mutateProject(project.id, async (current) => {
          await delay(Math.random() * 10);
          return { ...current, description: `${current.description ?? ''}${index},` };
        })
      )
    );

    const raw = await readRawProject(project.id);
    const entries = (raw.description ?? '').split(',').filter(Boolean);
    expect(entries).toHaveLength(25);
    expect(new Set(entries).size).toBe(25);
  });

  it('leaves the existing file untouched when a mutation throws and writes no temp files', async () => {
    const project = await projectStore.createProject({ title: 'Atomic failure' });
    const before = await readRawProject(project.id);

    await expect(
      projectStore.mutateProject(project.id, () => {
        throw new Error('mutator exploded');
      })
    ).rejects.toThrow('mutator exploded');

    const after = await readRawProject(project.id);
    expect(after).toEqual(before);

    const projectDir = path.join(tempRoot, 'projects', project.id);
    const entries = await fs.readdir(projectDir);
    expect(entries.filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  it('distinguishes a missing project from a corrupt one', async () => {
    await expect(projectStore.getProject('does-not-exist')).resolves.toBeNull();

    const corruptId = 'corrupt-project';
    const corruptDir = path.join(tempRoot, 'projects', corruptId);
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.writeFile(path.join(corruptDir, 'project.json'), '{ "id": "corrupt-project", ', 'utf8');

    await expect(projectStore.getProject(corruptId)).rejects.toBeInstanceOf(ProjectReadError);

    const summaries = await projectStore.listProjects();
    expect(summaries.some((summary) => summary.id === corruptId)).toBe(false);
  });
});
