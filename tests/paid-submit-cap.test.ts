import { afterEach, describe, expect, it, vi } from 'vitest';

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setMandateSpendLedgerForTests, setMandateSpendReaderForTests } from '@/lib/spend/mandate-spend';
import {
  FilePaidSubmitLedger,
  InMemoryPaidSubmitLedger,
  PaidSubmitCapError,
  assertAndReservePaidSubmit,
  finalizePaidSubmit,
  resolvePaidSubmitCapConfig,
  resolvePaidSubmitUnits,
  setPaidSubmitLedgerForTests
} from '@/lib/spend/paid-submit-cap';

function enablePaidSpendCap(overrides: Record<string, string> = {}): void {
  vi.stubEnv('PAID_SPEND_CAP_ENABLED', 'true');
  vi.stubEnv('PAID_SPEND_CAP_WINDOW_HOURS', '24');
  vi.stubEnv('PAID_SPEND_CAP_MAX_SUBMITS', '3');
  vi.stubEnv('PAID_SPEND_CAP_MAX_IMAGE_SUBMITS', '2');
  vi.stubEnv('PAID_SPEND_CAP_MAX_VIDEO_SUBMITS', '1');
  vi.stubEnv('PAID_SPEND_CAP_MAX_NARRATION_SUBMITS', '3');
  vi.stubEnv('PAID_SPEND_CAP_MAX_MUSIC_SUBMITS', '1');
  vi.stubEnv('PAID_SPEND_CAP_MAX_PRESENTER_SUBMITS', '1');
  for (const [name, value] of Object.entries(overrides)) {
    vi.stubEnv(name, value);
  }
}

function realImage(projectId = 'project-1') {
  return { projectId, sceneId: 'scene-1', modality: 'image', mode: 'real' as const };
}

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

afterEach(() => {
  vi.unstubAllEnvs();
  setPaidSubmitLedgerForTests(undefined);
  setMandateSpendLedgerForTests(undefined);
  setMandateSpendReaderForTests(undefined);
});

describe('resolvePaidSubmitCapConfig', () => {
  it('is disabled by default', () => {
    expect(resolvePaidSubmitCapConfig({})).toEqual({ enabled: false });
  });

  it('fails closed when enabled with missing limits', () => {
    expect(() => resolvePaidSubmitCapConfig({ PAID_SPEND_CAP_ENABLED: 'true' })).toThrow(PaidSubmitCapError);
    try {
      resolvePaidSubmitCapConfig({ PAID_SPEND_CAP_ENABLED: 'true' });
    } catch (error) {
      expect(error).toMatchObject({ status: 403, code: 'paid.spend.cap.invalid' });
    }
  });

  it('fails closed when a limit is negative or non-numeric', () => {
    expect(() =>
      resolvePaidSubmitCapConfig({
        PAID_SPEND_CAP_ENABLED: 'true',
        PAID_SPEND_CAP_WINDOW_HOURS: '24',
        PAID_SPEND_CAP_MAX_SUBMITS: '-1',
        PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '2',
        PAID_SPEND_CAP_MAX_VIDEO_SUBMITS: '1',
        PAID_SPEND_CAP_MAX_NARRATION_SUBMITS: '3',
        PAID_SPEND_CAP_MAX_MUSIC_SUBMITS: '1',
        PAID_SPEND_CAP_MAX_PRESENTER_SUBMITS: '1'
      })
    ).toThrow(/PAID_SPEND_CAP_MAX_SUBMITS/);
  });

  it('fails closed when a provider limit is missing or invalid instead of treating it as unlimited', () => {
    const required = {
      PAID_SPEND_CAP_ENABLED: 'true',
      PAID_SPEND_CAP_WINDOW_HOURS: '24',
      PAID_SPEND_CAP_MAX_SUBMITS: '3',
      PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '2',
      PAID_SPEND_CAP_MAX_VIDEO_SUBMITS: '1',
      PAID_SPEND_CAP_MAX_NARRATION_SUBMITS: '3',
      PAID_SPEND_CAP_MAX_MUSIC_SUBMITS: '1',
      PAID_SPEND_CAP_MAX_PRESENTER_SUBMITS: '1'
    };
    expect(() =>
      resolvePaidSubmitCapConfig({ ...required, PAID_SPEND_CAP_MAX_PROVIDER_OPENAI_SUBMITS: 'abc' })
    ).toThrow(/PAID_SPEND_CAP_MAX_PROVIDER_OPENAI_SUBMITS/);
    expect(() =>
      resolvePaidSubmitCapConfig({ ...required, PAID_SPEND_CAP_MAX_PROVIDER_OPENAI_SUBMITS: '' })
    ).toThrow(/PAID_SPEND_CAP_MAX_PROVIDER_OPENAI_SUBMITS/);
  });
});

describe('assertAndReservePaidSubmit', () => {
  it('does not consult the ledger in mock mode even when the cap is enabled', async () => {
    enablePaidSpendCap();
    const ledger = new InMemoryPaidSubmitLedger();
    const original = ledger.reserve.bind(ledger);
    let reserveCalls = 0;
    ledger.reserve = async (input) => {
      reserveCalls += 1;
      return original(input);
    };
    setPaidSubmitLedgerForTests(ledger);

    await expect(
      assertAndReservePaidSubmit({ projectId: 'project-1', modality: 'image', mode: 'mock' })
    ).resolves.toBeUndefined();
    expect(reserveCalls).toBe(0);
    expect((await ledger.snapshot()).entries).toHaveLength(0);
  });

  it('fails closed for a real submit when the cap is disabled', async () => {
    const ledger = new InMemoryPaidSubmitLedger();
    let reserveCalls = 0;
    const original = ledger.reserve.bind(ledger);
    ledger.reserve = async (input) => {
      reserveCalls += 1;
      return original(input);
    };
    setPaidSubmitLedgerForTests(ledger);

    await expect(assertAndReservePaidSubmit(realImage())).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.invalid'
    });
    expect(reserveCalls).toBe(0);
  });

  it('fails closed for a real submit when the enabled flag is invalid', async () => {
    vi.stubEnv('PAID_SPEND_CAP_ENABLED', 'maybe');
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());

    await expect(assertAndReservePaidSubmit(realImage())).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.invalid'
    });
  });

  it('denies a real submit when the host cap is 0', async () => {
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '0' });
    const ledger = new InMemoryPaidSubmitLedger();
    setPaidSubmitLedgerForTests(ledger);

    await expect(assertAndReservePaidSubmit(realImage())).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.exceeded'
    });
    expect((await ledger.snapshot()).entries).toHaveLength(0);
  });

  it('allows one remaining unit and denies the next', async () => {
    enablePaidSpendCap({
      PAID_SPEND_CAP_MAX_SUBMITS: '1',
      PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '2'
    });
    const ledger = new InMemoryPaidSubmitLedger();
    setPaidSubmitLedgerForTests(ledger);

    const first = await assertAndReservePaidSubmit(realImage());
    expect(first?.counted).toBe(true);
    await expect(assertAndReservePaidSubmit(realImage('project-2'))).rejects.toMatchObject({
      code: 'paid.spend.cap.exceeded'
    });
    expect((await ledger.snapshot()).entries).toHaveLength(1);
  });

  it('enforces the modality limit independently of remaining host units', async () => {
    enablePaidSpendCap({
      PAID_SPEND_CAP_MAX_SUBMITS: '5',
      PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '1'
    });
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());

    await assertAndReservePaidSubmit(realImage());
    await expect(assertAndReservePaidSubmit(realImage('project-2'))).rejects.toMatchObject({
      code: 'paid.spend.cap.exceeded'
    });
  });

  it('serializes concurrent real reserves under the host lock', async () => {
    enablePaidSpendCap({
      PAID_SPEND_CAP_MAX_SUBMITS: '1',
      PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '2'
    });
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());

    const results = await Promise.allSettled([
      assertAndReservePaidSubmit(realImage('project-a')),
      assertAndReservePaidSubmit(realImage('project-b'))
    ]);
    const accepted = results.filter((result) => result.status === 'fulfilled');
    const denied = results.filter((result) => result.status === 'rejected');
    expect(accepted).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'paid.spend.cap.exceeded' })
    });
  });

  it('keeps the debit after a failed provider POST', async () => {
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '1', PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '1' });
    const ledger = new InMemoryPaidSubmitLedger();
    setPaidSubmitLedgerForTests(ledger);

    const reserved = await assertAndReservePaidSubmit(realImage());
    await finalizePaidSubmit(reserved, 'failed');
    expect((await ledger.snapshot()).entries[0]?.status).toBe('failed');
    await expect(assertAndReservePaidSubmit(realImage('project-2'))).rejects.toMatchObject({
      code: 'paid.spend.cap.exceeded'
    });
  });

  it('fails closed for an unknown future modality instead of treating cost as zero', async () => {
    enablePaidSpendCap();
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());

    await expect(
      assertAndReservePaidSubmit({ projectId: 'project-1', modality: 'stock', mode: 'real' })
    ).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.invalid'
    });
    expect(resolvePaidSubmitUnits('image')).toBe(1);
  });

  it('prunes entries outside the configured window', async () => {
    enablePaidSpendCap({
      PAID_SPEND_CAP_WINDOW_HOURS: '1',
      PAID_SPEND_CAP_MAX_SUBMITS: '1',
      PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '1'
    });
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const ledger = new InMemoryPaidSubmitLedger({ now: () => now });
    setPaidSubmitLedgerForTests(ledger);

    await ledger.reserve({
      entry: {
        id: 'paid_submit_old',
        at: now,
        modality: 'image',
        projectId: 'project-old'
      },
      windowHours: 1,
      maxSubmits: 1,
      maxModalitySubmits: 1
    });

    now += 2 * 60 * 60 * 1000;
    await expect(assertAndReservePaidSubmit(realImage())).resolves.toMatchObject({ counted: true });
  });

  it('fails closed when the durable ledger is unreadable', async () => {
    enablePaidSpendCap();
    const filePath = path.join(os.tmpdir(), `paid-spend-${process.pid}-${Date.now()}`, 'spend-state.json');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{not-json', 'utf8');
    setPaidSubmitLedgerForTests(new FilePaidSubmitLedger({ filePath }));

    await expect(assertAndReservePaidSubmit(realImage())).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.unavailable'
    });
  });

  it('does not treat an unset flag as protection even if limits are present', () => {
    expect(
      resolvePaidSubmitCapConfig({
        PAID_SPEND_CAP_WINDOW_HOURS: '24',
        PAID_SPEND_CAP_MAX_SUBMITS: '1'
      })
    ).toEqual({ enabled: false });
  });

  it('fails closed on an ambiguous enabled flag instead of silently disabling', () => {
    expect(() => resolvePaidSubmitCapConfig({ PAID_SPEND_CAP_ENABLED: 'maybe' })).toThrow(PaidSubmitCapError);
  });

  it('enforces an optional future-provider limit from env without new guard logic', async () => {
    enablePaidSpendCap({
      PAID_SPEND_CAP_MAX_SUBMITS: '5',
      PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '5',
      PAID_SPEND_CAP_MAX_PROVIDER_OPENAI_SUBMITS: '1'
    });
    const ledger = new InMemoryPaidSubmitLedger();
    setPaidSubmitLedgerForTests(ledger);

    await expect(
      assertAndReservePaidSubmit({ ...realImage(), provider: 'openai' })
    ).resolves.toMatchObject({ counted: true });
    await expect(
      assertAndReservePaidSubmit({ ...realImage('project-2'), provider: 'openai' })
    ).rejects.toMatchObject({ code: 'paid.spend.cap.exceeded' });
  });

  it('keeps a reserved debit after a crash with no finalize', async () => {
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '1', PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '1' });
    const ledger = new InMemoryPaidSubmitLedger();
    setPaidSubmitLedgerForTests(ledger);

    await assertAndReservePaidSubmit(realImage());
    expect((await ledger.snapshot()).entries[0]?.status).toBe('reserved');
    await expect(assertAndReservePaidSubmit(realImage('project-2'))).rejects.toMatchObject({
      code: 'paid.spend.cap.exceeded'
    });
  });

  it('records known actual USD on settle and keeps the unit debit when actual cost stays unknown', async () => {
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '1', PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '1' });
    const ledger = new InMemoryPaidSubmitLedger();
    setPaidSubmitLedgerForTests(ledger);

    const reserved = await assertAndReservePaidSubmit(realImage());
    await finalizePaidSubmit(reserved, 'completed');
    const settled = (await ledger.snapshot()).entries[0];
    expect(settled).toMatchObject({ status: 'completed', units: 1 });
    expect(settled?.observedUsd).toBeUndefined();
    await expect(assertAndReservePaidSubmit(realImage('project-2'))).rejects.toMatchObject({
      code: 'paid.spend.cap.exceeded'
    });
  });

  it('settles a known actual USD without treating missing cost as zero', async () => {
    enablePaidSpendCap();
    const ledger = new InMemoryPaidSubmitLedger();
    setPaidSubmitLedgerForTests(ledger);

    const reserved = await assertAndReservePaidSubmit({
      ...realImage(),
      modality: 'presenter',
      provider: 'heygen'
    });
    await finalizePaidSubmit(reserved, 'completed', { actualUsd: 0.1 });
    expect((await ledger.snapshot()).entries[0]?.observedUsd).toBe(0.1);
  });

  it('refuses a ledger reset while a reserved submit is still in flight', async () => {
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '1', PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '1' });
    const ledger = new InMemoryPaidSubmitLedger();
    setPaidSubmitLedgerForTests(ledger);

    await assertAndReservePaidSubmit(realImage());
    await expect(ledger.reset()).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.in_flight'
    });
    expect((await ledger.snapshot()).entries).toHaveLength(1);
  });

  it('refuses a durable ledger reset while a reserved submit is still in flight', async () => {
    const filePath = path.join(os.tmpdir(), `paid-spend-${process.pid}-${Date.now()}-reset`, 'spend-state.json');
    const ledger = new FilePaidSubmitLedger({ filePath });
    await ledger.reserve({
      entry: { id: 'paid_submit_inflight', modality: 'image', projectId: 'project-1' },
      windowHours: 24,
      maxSubmits: 1,
      maxModalitySubmits: 1
    });
    await expect(ledger.reset()).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.in_flight'
    });
    expect((await ledger.snapshot()).entries).toHaveLength(1);
  });

  it('allows a ledger reset only after in-flight reserves are settled', async () => {
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '1', PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '1' });
    const ledger = new InMemoryPaidSubmitLedger();
    setPaidSubmitLedgerForTests(ledger);

    const reserved = await assertAndReservePaidSubmit(realImage());
    await finalizePaidSubmit(reserved, 'failed');
    await ledger.reset();
    expect((await ledger.snapshot()).entries).toHaveLength(0);
    await expect(assertAndReservePaidSubmit(realImage('project-2'))).resolves.toMatchObject({ counted: true });
  });

  it('does not reclaim a lock owned by a living process even when the lock file is old', async () => {
    const filePath = path.join(os.tmpdir(), `paid-spend-${process.pid}-${Date.now()}-live-lock`, 'spend-state.json');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const lockBody = `${process.pid}:${Date.now() - 120_000}`;
    await fs.writeFile(`${filePath}.lock`, lockBody, 'utf8');
    const ledger = new FilePaidSubmitLedger({ filePath });

    await expect(
      ledger.reserve({
        entry: { id: 'paid_submit_live', modality: 'image', projectId: 'project-1' },
        windowHours: 24,
        maxSubmits: 1,
        maxModalitySubmits: 1
      })
    ).rejects.toMatchObject({ code: 'paid.spend.cap.unavailable' });
    expect(await fs.readFile(`${filePath}.lock`, 'utf8')).toBe(lockBody);
  });

  it('does not reclaim a recently dead lock until it is stale', async () => {
    const filePath = path.join(os.tmpdir(), `paid-spend-${process.pid}-${Date.now()}-fresh-dead`, 'spend-state.json');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const lockBody = `${await exitedChildPid()}:${Date.now()}`;
    await fs.writeFile(`${filePath}.lock`, lockBody, 'utf8');
    const ledger = new FilePaidSubmitLedger({ filePath });

    await expect(
      ledger.reserve({
        entry: { id: 'paid_submit_fresh_dead', modality: 'image', projectId: 'project-1' },
        windowHours: 24,
        maxSubmits: 1,
        maxModalitySubmits: 1
      })
    ).rejects.toMatchObject({ code: 'paid.spend.cap.unavailable' });
    expect(await fs.readFile(`${filePath}.lock`, 'utf8')).toBe(lockBody);
  });

  it('reclaims a lock only after the owner pid is dead and the lock is stale', async () => {
    const filePath = path.join(os.tmpdir(), `paid-spend-${process.pid}-${Date.now()}-dead-lock`, 'spend-state.json');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(`${filePath}.lock`, `${await exitedChildPid()}:${Date.now() - 120_000}`, 'utf8');
    const ledger = new FilePaidSubmitLedger({ filePath });

    await expect(
      ledger.reserve({
        entry: { id: 'paid_submit_dead', modality: 'image', projectId: 'project-1' },
        windowHours: 24,
        maxSubmits: 1,
        maxModalitySubmits: 1
      })
    ).resolves.toMatchObject({ id: 'paid_submit_dead', status: 'reserved' });
  });

  it('serializes two file ledgers on the same path so parallel reserves cannot overshoot', async () => {
    const filePath = path.join(os.tmpdir(), `paid-spend-${process.pid}-${Date.now()}-file`, 'spend-state.json');
    const left = new FilePaidSubmitLedger({ filePath, lockKey: `paid-submit-cap:left:${filePath}` });
    const right = new FilePaidSubmitLedger({ filePath, lockKey: `paid-submit-cap:right:${filePath}` });
    const request = {
      windowHours: 24,
      maxSubmits: 1,
      maxModalitySubmits: 2
    };

    const results = await Promise.allSettled([
      left.reserve({ entry: { id: 'paid_submit_a', modality: 'image', projectId: 'project-a' }, ...request }),
      right.reserve({ entry: { id: 'paid_submit_b', modality: 'image', projectId: 'project-b' }, ...request })
    ]);
    const accepted = results.filter((result) => result.status === 'fulfilled');
    const denied = results.filter((result) => result.status === 'rejected');
    expect(accepted).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'paid.spend.cap.exceeded' })
    });
    expect((await left.snapshot()).entries).toHaveLength(1);
  });
});
