import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileRunStore, type PersistedRun } from '@/lib/production/run-store';

function createPersistedRun(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    runId: 'run-1',
    projectId: 'project-1',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    summary: { completed: 1, failed: 0, running: 1, waiting: 0 },
    completedActionIds: ['scene:scene-1:image_generate'],
    failedActionIds: [],
    unresolvedActions: [],
    acceptedConfig: {
      policy: {
        mode: 'mock',
        allowRealProviders: false,
        providers: { image: 'fake', video: 'local', narration: 'fake' }
      },
      limits: {
        maxIterations: 10,
        maxActionExecutions: 100,
        maxVideoPolls: 40,
        perActionConcurrency: {
          image_generate: 2,
          video_submit: 2,
          video_poll: 4,
          narration_generate: 2,
          scene_render: 1,
          final_compose: 1
        }
      }
    },
    events: [
      {
        timestamp: '2026-01-01T00:00:01.000Z',
        iteration: 1,
        code: 'run_started',
        status: 'started',
        message: 'started'
      }
    ],
    eventOffset: 0,
    ...overrides
  };
}

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'run-store-'));
}

describe('file run store', () => {
  it('round-trips a run through save/load', async () => {
    const root = await tempRoot();
    const store = new FileRunStore({ projectsRoot: root });
    const run = createPersistedRun();

    await store.save(run);

    expect(await store.load('project-1', 'run-1')).toEqual(run);
  });

  it('overwrites the same run file without leaving temp artifacts', async () => {
    const root = await tempRoot();
    const store = new FileRunStore({ projectsRoot: root });

    await store.save(createPersistedRun());
    await store.save(
      createPersistedRun({
        status: 'completed',
        summary: { completed: 1, failed: 0, running: 0, waiting: 0 }
      })
    );

    expect((await store.load('project-1', 'run-1'))?.status).toBe('completed');
    expect(await fs.readdir(path.join(root, 'project-1', 'runs'))).toEqual(['run-1.json']);
  });

  it('returns null for a missing run', async () => {
    const root = await tempRoot();
    const store = new FileRunStore({ projectsRoot: root });

    expect(await store.load('nope', 'nope')).toBeNull();
  });

  it('ignores corrupt or unrelated files when listing', async () => {
    const root = await tempRoot();
    const store = new FileRunStore({ projectsRoot: root });

    await store.save(createPersistedRun({ runId: 'good' }));
    await fs.mkdir(path.join(root, 'project-1', 'runs'), { recursive: true });
    await fs.writeFile(path.join(root, 'project-1', 'runs', 'bad.json'), '{not json', 'utf8');
    await fs.writeFile(path.join(root, 'project-1', 'runs', 'notes.txt'), 'ignore', 'utf8');

    const all = await store.listAll();

    expect(all).toHaveLength(1);
    expect(all[0].runId).toBe('good');
  });

  it('lists runs across projects sorted by creation time', async () => {
    const root = await tempRoot();
    const store = new FileRunStore({ projectsRoot: root });

    await store.save(createPersistedRun({ runId: 'b', projectId: 'p2', createdAt: '2026-01-02T00:00:00.000Z' }));
    await store.save(createPersistedRun({ runId: 'a', projectId: 'p1', createdAt: '2026-01-01T00:00:00.000Z' }));

    expect((await store.listAll()).map((run) => run.runId)).toEqual(['a', 'b']);
  });

  it('returns an empty list when the projects root does not exist', async () => {
    const store = new FileRunStore({ projectsRoot: path.join(os.tmpdir(), 'run-store-does-not-exist') });

    expect(await store.listAll()).toEqual([]);
  });
});
