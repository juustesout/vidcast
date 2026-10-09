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
  }

  async load(projectId: string, runId: string): Promise<PersistedRun | null> {
    try {
      const raw = await fs.readFile(this.runFile(projectId, runId), 'utf8');
      return parseEnvelope(raw);
    } catch {
      return null;
    }
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
}
