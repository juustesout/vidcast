import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileExclusiveLock, InMemoryExclusiveLock } from '@/lib/utils/exclusive-file-lock';

async function exitedChildPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  if (!pid) {
    throw new Error('failed to spawn exited child');
  }
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  return pid;
}

describe('InMemoryExclusiveLock', () => {
  it('rejects a second acquire until release', async () => {
    const lock = new InMemoryExclusiveLock();
    expect(await lock.tryAcquire('scene-a')).toBe(true);
    expect(await lock.tryAcquire('scene-a')).toBe(false);
    expect(await lock.tryAcquire('scene-b')).toBe(true);
    await lock.release('scene-a');
    expect(await lock.tryAcquire('scene-a')).toBe(true);
  });
});

describe('FileExclusiveLock', () => {
  it('creates an exclusive lock file atomically', async () => {
    const dir = path.join(os.tmpdir(), `exclusive-lock-${process.pid}-${Date.now()}`);
    const lock = new FileExclusiveLock({
      resolvePath: (key) => path.join(dir, `${key}.lock`)
    });

    expect(await lock.tryAcquire('scene-a')).toBe(true);
    expect(await lock.tryAcquire('scene-a')).toBe(false);
    await lock.release('scene-a');
    expect(await lock.tryAcquire('scene-a')).toBe(true);
  });

  it('does not reclaim a lock owned by a living process even when old', async () => {
    const dir = path.join(os.tmpdir(), `exclusive-lock-live-${process.pid}-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const lockPath = path.join(dir, 'scene-a.lock');
    const body = `${process.pid}:${Date.now() - 120_000}`;
    await fs.writeFile(lockPath, body, 'utf8');
    const lock = new FileExclusiveLock({
      resolvePath: () => lockPath
    });

    expect(await lock.tryAcquire('scene-a')).toBe(false);
    expect(await fs.readFile(lockPath, 'utf8')).toBe(body);
  });

  it('does not reclaim a recently dead lock until it is stale', async () => {
    const dir = path.join(os.tmpdir(), `exclusive-lock-fresh-${process.pid}-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const lockPath = path.join(dir, 'scene-a.lock');
    await fs.writeFile(lockPath, `${await exitedChildPid()}:${Date.now()}`, 'utf8');
    const lock = new FileExclusiveLock({
      resolvePath: () => lockPath
    });

    expect(await lock.tryAcquire('scene-a')).toBe(false);
  });

  it('reclaims a lock only after the owner pid is dead and the lock is stale', async () => {
    const dir = path.join(os.tmpdir(), `exclusive-lock-dead-${process.pid}-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    const lockPath = path.join(dir, 'scene-a.lock');
    await fs.writeFile(lockPath, `${await exitedChildPid()}:${Date.now() - 120_000}`, 'utf8');
    const lock = new FileExclusiveLock({
      resolvePath: () => lockPath
    });

    expect(await lock.tryAcquire('scene-a')).toBe(true);
  });

  it('lets only one of two lock instances acquire the same path', async () => {
    const dir = path.join(os.tmpdir(), `exclusive-lock-race-${process.pid}-${Date.now()}`);
    const resolvePath = () => path.join(dir, 'scene-a.lock');
    const left = new FileExclusiveLock({ resolvePath });
    const right = new FileExclusiveLock({ resolvePath });

    const results = await Promise.all([left.tryAcquire('scene-a'), right.tryAcquire('scene-a')]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
