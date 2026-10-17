import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeyedLimitQueueFullError, getKeyedLimitQueueLength, resetKeyedLimiterForTests, withKeyedLimit } from '@/lib/concurrency/keyed-limiter';
import { runFfmpeg } from '@/lib/render/ffmpeg-executor';
import {
  FFMPEG_CONCURRENCY_ENV,
  MAX_FFMPEG_CONCURRENCY,
  getFfmpegLimiterStats,
  resetFfmpegLimiterForTests,
  resolveFfmpegConcurrencyLimit
} from '@/lib/render/ffmpeg-limiter';

const originalConcurrency = process.env[FFMPEG_CONCURRENCY_ENV];
let tempRoot: string;

const probeScript = `
const fs = require('node:fs');
const [id, lockPath, logPath, sleepRaw, mode] = process.argv.slice(1);
const sleepMs = Number(sleepRaw);
let locked = false;
try {
  fs.writeFileSync(lockPath, id, { flag: 'wx' });
  locked = true;
} catch {
  fs.appendFileSync(logPath + '.violations', 'overlap\\n');
}
fs.appendFileSync(logPath, 'start ' + id + ' ' + Date.now() + '\\n');
setTimeout(() => {
  fs.appendFileSync(logPath, 'end ' + id + ' ' + Date.now() + '\\n');
  if (locked) {
    try { fs.unlinkSync(lockPath); } catch {}
  }
  if (mode === 'fail') {
    process.exit(3);
  }
}, sleepMs);
`;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-limiter-'));
  delete process.env[FFMPEG_CONCURRENCY_ENV];
  resetFfmpegLimiterForTests();
});

afterEach(async () => {
  if (originalConcurrency === undefined) {
    delete process.env[FFMPEG_CONCURRENCY_ENV];
  } else {
    process.env[FFMPEG_CONCURRENCY_ENV] = originalConcurrency;
  }
  resetFfmpegLimiterForTests();
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

function probeArgs(id: string, sleepMs: number, mode = 'ok') {
  return [
    '-e',
    probeScript,
    id,
    path.join(tempRoot, `lock-${id}`),
    path.join(tempRoot, 'events.log'),
    String(sleepMs),
    mode
  ];
}

async function readEvents(): Promise<Array<{ kind: string; id: string; at: number }>> {
  const raw = await fs.readFile(path.join(tempRoot, 'events.log'), 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [kind, id, at] = line.split(' ');
      return { kind, id, at: Number(at) };
    });
}

describe('FFmpeg concurrency configuration', () => {
  it('defaults to one and rejects partial or out-of-range values', () => {
    expect(resolveFfmpegConcurrencyLimit(undefined)).toBe(1);
    expect(resolveFfmpegConcurrencyLimit('')).toBe(1);
    expect(resolveFfmpegConcurrencyLimit('2abc')).toBe(1);
    expect(resolveFfmpegConcurrencyLimit('1.5')).toBe(1);
    expect(resolveFfmpegConcurrencyLimit('0')).toBe(1);
    expect(resolveFfmpegConcurrencyLimit('-1')).toBe(1);
    expect(resolveFfmpegConcurrencyLimit(String(MAX_FFMPEG_CONCURRENCY + 1))).toBe(1);
    expect(resolveFfmpegConcurrencyLimit('2')).toBe(2);
    expect(resolveFfmpegConcurrencyLimit(` ${MAX_FFMPEG_CONCURRENCY} `)).toBe(MAX_FFMPEG_CONCURRENCY);
  });
});

describe('shared FFmpeg limiter', () => {
  it('serializes scene-render and final-compose spawns across one process', async () => {
    process.env[FFMPEG_CONCURRENCY_ENV] = '1';

    const operations = ['scene_render', 'final_compose', 'scene_render', 'final_compose'] as const;
    await Promise.all(
      operations.map((operation, index) =>
        runFfmpeg(process.execPath, probeArgs(`job-${index}`, 100), {}, operation)
      )
    );

    const violations = await fs.readFile(path.join(tempRoot, 'events.log.violations'), 'utf8').catch(() => '');
    expect(violations).toBe('');

    const events = await readEvents();
    const starts = events.filter((event) => event.kind === 'start');
    const ends = events.filter((event) => event.kind === 'end');
    expect(starts).toHaveLength(4);
    expect(ends).toHaveLength(4);

    for (let index = 0; index < 4; index += 1) {
      expect(ends[index].at).toBeGreaterThanOrEqual(starts[index].at);
      if (index > 0) {
        expect(starts[index].at).toBeGreaterThanOrEqual(ends[index - 1].at);
      }
    }
    expect(getFfmpegLimiterStats()).toMatchObject({ limit: 1, active: 0, queued: 0 });
  });

  it('makes later work wait for a slot and does not start early', async () => {
    process.env[FFMPEG_CONCURRENCY_ENV] = '1';

    const started = Date.now();
    const first = runFfmpeg(process.execPath, probeArgs('first', 180), {}, 'scene_render');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = runFfmpeg(process.execPath, probeArgs('second', 10), {}, 'final_compose');

    await Promise.all([first, second]);
    const waitedMs = Date.now() - started;
    expect(waitedMs).toBeGreaterThanOrEqual(170);

    const events = await readEvents();
    expect(events.map((event) => `${event.kind} ${event.id}`)).toEqual([
      'start first',
      'end first',
      'start second',
      'end second'
    ]);
  });

  it('logs long queue waits with the active count', async () => {
    process.env[FFMPEG_CONCURRENCY_ENV] = '1';
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      const first = runFfmpeg(process.execPath, probeArgs('long-first', 1_150), {}, 'scene_render');
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = runFfmpeg(process.execPath, probeArgs('long-second', 10), {}, 'final_compose');
      await Promise.all([first, second]);

      expect(info).toHaveBeenCalledWith(expect.stringContaining('[ffmpeg-limiter] final_compose waited'));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('limit=1'));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('active=1'));
    } finally {
      info.mockRestore();
    }
  });

  it('releases the slot after a failed child', async () => {
    process.env[FFMPEG_CONCURRENCY_ENV] = '1';

    await expect(
      runFfmpeg(process.execPath, probeArgs('failing', 30, 'fail'), {}, 'scene_render')
    ).rejects.toMatchObject({ reason: 'exit', exitCode: 3 });

    await expect(runFfmpeg(process.execPath, probeArgs('after-failure', 10), {}, 'scene_render')).resolves.toMatchObject({
      exitCode: 0
    });
    expect(getFfmpegLimiterStats().active).toBe(0);
  });

  it('releases the slot after a timeout', async () => {
    process.env[FFMPEG_CONCURRENCY_ENV] = '1';

    await expect(
      runFfmpeg(process.execPath, probeArgs('slow', 1_000), { timeoutMs: 80 }, 'scene_render')
    ).rejects.toMatchObject({ reason: 'timeout' });

    const started = Date.now();
    await expect(runFfmpeg(process.execPath, probeArgs('after-timeout', 10), {}, 'scene_render')).resolves.toMatchObject({
      exitCode: 0
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(getFfmpegLimiterStats().active).toBe(0);
  });

  it('drops process-local limiter state on restart', async () => {
    process.env[FFMPEG_CONCURRENCY_ENV] = '1';
    await runFfmpeg(process.execPath, probeArgs('before-restart', 10), {}, 'scene_render');
    resetFfmpegLimiterForTests();

    expect(getFfmpegLimiterStats()).toMatchObject({ active: 0, queued: 0 });
    await expect(runFfmpeg(process.execPath, probeArgs('after-restart', 10), {}, 'scene_render')).resolves.toMatchObject({
      exitCode: 0
    });
  });
});

describe('bounded keyed queue', () => {
  it('rejects instead of growing an unbounded waiter queue', async () => {
    resetKeyedLimiterForTests();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = withKeyedLimit('bounded-test', 1, () => gate, { maxQueue: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const waiting = withKeyedLimit('bounded-test', 1, async () => undefined, { maxQueue: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(getKeyedLimitQueueLength('bounded-test')).toBe(1);
    await expect(withKeyedLimit('bounded-test', 1, async () => undefined, { maxQueue: 1 })).rejects.toBeInstanceOf(
      KeyedLimitQueueFullError
    );

    release();
    await Promise.all([running, waiting]);
    expect(getKeyedLimitQueueLength('bounded-test')).toBe(0);
  });
});
