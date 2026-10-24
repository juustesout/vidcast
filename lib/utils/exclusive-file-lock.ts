import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Cross-process exclusive lock using atomic `wx` file creation.
 *
 * Reclaim is allowed only when the owner pid is dead and the lock is older
 * than `staleMs`. A living owner is never stolen, even if the lock file is old.
 */
export const EXCLUSIVE_FILE_LOCK_STALE_MS = 30_000;

export interface ExclusiveLock {
  tryAcquire(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
}

export class InMemoryExclusiveLock implements ExclusiveLock {
  private readonly held = new Set<string>();

  async tryAcquire(key: string): Promise<boolean> {
    if (this.held.has(key)) {
      return false;
    }
    this.held.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.held.delete(key);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class FileExclusiveLock implements ExclusiveLock {
  private readonly resolvePath: (key: string) => string;
  private readonly staleMs: number;
  private readonly now: () => number;

  constructor(options: {
    resolvePath: (key: string) => string;
    staleMs?: number;
    now?: () => number;
  }) {
    this.resolvePath = options.resolvePath;
    this.staleMs = options.staleMs ?? EXCLUSIVE_FILE_LOCK_STALE_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async tryAcquire(key: string): Promise<boolean> {
    const lockPath = this.resolvePath(key);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    if (await this.createLock(lockPath)) {
      return true;
    }
    if (await this.tryReclaimStaleLock(lockPath)) {
      return this.createLock(lockPath);
    }
    return false;
  }

  async release(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolvePath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private async createLock(lockPath: string): Promise<boolean> {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(`${process.pid}:${this.now()}`, 'utf8');
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  }

  private async tryReclaimStaleLock(lockPath: string): Promise<boolean> {
    let raw: string;
    let mtimeMs: number;
    try {
      raw = await fs.readFile(lockPath, 'utf8');
      mtimeMs = (await fs.stat(lockPath)).mtimeMs;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }

    const [pidRaw, startedAtRaw] = raw.trim().split(':');
    const ownerPid = Number(pidRaw);
    const startedAt = Number(startedAtRaw);
    const ageMs = Number.isFinite(startedAt) ? this.now() - startedAt : this.now() - mtimeMs;

    if (Number.isInteger(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
      return false;
    }

    if (ageMs < this.staleMs) {
      return false;
    }

    return this.unlinkIfUnchanged(lockPath, raw);
  }

  private async unlinkIfUnchanged(lockPath: string, expected: string): Promise<boolean> {
    try {
      const current = await fs.readFile(lockPath, 'utf8');
      if (current !== expected) {
        return false;
      }
      await fs.unlink(lockPath);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }
}
