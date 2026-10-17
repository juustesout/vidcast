import fs from 'node:fs/promises';
import path from 'node:path';

import { getProjectRunsRoot, getProjectsRoot, getRunJsonPath } from '@/lib/storage/storage-paths';
import type { RunRegistryEntry } from './run-registry';

// Durable representation of a run: the public snapshot plus the event log and
// its cursor offset. Re-exported here so persistence consumers depend on the
// store module rather than the registry internals.
export type PersistedRun = RunRegistryEntry;

export interface RunStore {
  save(run: PersistedRun): Promise<void>;
  load(projectId: string, runId: string): Promise<PersistedRun | null>;
  listAll(): Promise<PersistedRun[]>;
  // Looks up a run without knowing its project. Used by status/log reads so a
  // route instance that never saw the run can recover it from durable state.
  findByRunId?(runId: string): Promise<PersistedRun | null>;
  // Optional cross-process execution lock. When implemented, it lets multiple
  // service instances (e.g. one per route worker) agree that a single run is
  // executed by exactly one owner at a time. Stores without it keep the plain
  // single-instance behaviour used by unit tests.
  tryAcquireExecutionLock?(projectId: string, runId: string): Promise<RunExecutionLock | null>;
  isExecutionLocked?(projectId: string, runId: string): Promise<boolean>;
}

export interface RunExecutionLock {
  release(): Promise<void>;
}

interface StoredEnvelope {
  version: 1;
  run: PersistedRun;
}

const STORE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Minimal structural validation. Anything that fails is treated as corrupt and
// skipped rather than crashing recovery.
function isPersistedRun(value: unknown): value is PersistedRun {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.runId !== 'string' || typeof value.projectId !== 'string' || typeof value.status !== 'string') {
    return false;
  }
  if (!isRecord(value.acceptedConfig)) {
    return false;
  }
  if (!Array.isArray(value.events) || !Array.isArray(value.completedActionIds) || !Array.isArray(value.failedActionIds)) {
    return false;
  }
  return typeof value.eventOffset === 'number';
}

function parseEnvelope(raw: string): PersistedRun | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const candidate = parsed.version === STORE_VERSION ? parsed.run : parsed;
    return isPersistedRun(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export interface FileRunStoreOptions {
  // Override the projects root, used by tests with temporary directories.
  // When omitted, the workspace `projects/` root is used.
  projectsRoot?: string;
}

export class FileRunStore implements RunStore {
  private readonly projectsRoot: string | null;
  // runId -> projectId. Avoids scanning every project for repeated status/log
  // polls. Entries are refreshed by save/load and removed when a lookup misses.
  private readonly runProjects = new Map<string, string>();

  constructor(options: FileRunStoreOptions = {}) {
    this.projectsRoot = options.projectsRoot ?? null;
  }

  async save(run: PersistedRun): Promise<void> {
    const dir = this.runsDir(run.projectId);
    await fs.mkdir(dir, { recursive: true });

    const envelope: StoredEnvelope = {
      version: STORE_VERSION,
      run
    };
    const target = this.runFile(run.projectId, run.runId);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await fs.writeFile(temp, JSON.stringify(envelope), 'utf8');
    await fs.rename(temp, target);
    this.runProjects.set(run.runId, run.projectId);
  }

  async load(projectId: string, runId: string): Promise<PersistedRun | null> {
    try {
      const raw = await fs.readFile(this.runFile(projectId, runId), 'utf8');
      const parsed = parseEnvelope(raw);
      if (parsed) {
        this.runProjects.set(runId, projectId);
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async findByRunId(runId: string): Promise<PersistedRun | null> {
    const knownProjectId = this.runProjects.get(runId);
    if (knownProjectId) {
      const known = await this.load(knownProjectId, runId);
      if (known) {
        return known;
      }
      this.runProjects.delete(runId);
    }

    const root = this.rootDir();
    let projectEntries;
    try {
      projectEntries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) {
        continue;
      }
      const loaded = await this.load(projectEntry.name, runId);
      if (loaded) {
        return loaded;
      }
    }

    return null;
  }

  async listAll(): Promise<PersistedRun[]> {
    const root = this.rootDir();
    let projectEntries;
    try {
      projectEntries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }

    const runs: PersistedRun[] = [];
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) {
        continue;
      }
      const runsDir = path.join(root, projectEntry.name, 'runs');
      let runEntries;
      try {
        runEntries = await fs.readdir(runsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const runEntry of runEntries) {
        if (!runEntry.isFile() || !runEntry.name.endsWith('.json')) {
          continue;
        }
        try {
          const raw = await fs.readFile(path.join(runsDir, runEntry.name), 'utf8');
          const parsed = parseEnvelope(raw);
          if (parsed) {
            runs.push(parsed);
          }
        } catch {
          continue;
        }
      }
    }

    return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private rootDir(): string {
    return this.projectsRoot ?? getProjectsRoot();
  }

  private runsDir(projectId: string): string {
    return this.projectsRoot ? path.join(this.projectsRoot, projectId, 'runs') : getProjectRunsRoot(projectId);
  }

  private runFile(projectId: string, runId: string): string {
    return this.projectsRoot
      ? path.join(this.projectsRoot, projectId, 'runs', `${runId}.json`)
      : getRunJsonPath(projectId, runId);
  }

  private lockFile(projectId: string, runId: string): string {
    return this.projectsRoot
      ? path.join(this.projectsRoot, projectId, 'runs', `${runId}.lock`)
      : path.join(getProjectRunsRoot(projectId), `${runId}.lock`);
  }

  async tryAcquireExecutionLock(projectId: string, runId: string): Promise<RunExecutionLock | null> {
    const target = this.lockFile(projectId, runId);
    await fs.mkdir(path.dirname(target), { recursive: true });

    // One atomic-create attempt, plus one retry after reclaiming a stale lock.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(target, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
        let released = false;
        return {
          release: async () => {
            if (released) {
              return;
            }
            released = true;
            try {
              await handle.close();
            } catch {
              // already closed
            }
            try {
              await fs.unlink(target);
            } catch {
              // already removed
            }
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }

        if (await this.isExecutionLocked(projectId, runId)) {
          return null;
        }

        // Owner is gone (crashed/restarted); reclaim and retry once.
        try {
          await fs.unlink(target);
        } catch {
          // raced with another reclaimer; the retry will re-check
        }
      }
    }

    return null;
  }

  async isExecutionLocked(projectId: string, runId: string): Promise<boolean> {
    let raw: string;
    try {
      raw = await fs.readFile(this.lockFile(projectId, runId), 'utf8');
    } catch {
      return false;
    }

    try {
      const parsed = JSON.parse(raw) as { pid?: unknown };
      if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) {
        return false;
      }
      return isProcessAlive(parsed.pid);
    } catch {
      return false;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
