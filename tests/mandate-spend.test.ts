import { afterEach, describe, expect, it, vi } from 'vitest';

import os from 'node:os';
import path from 'node:path';

import {
  FileMandateSpendLedger,
  InMemoryMandateSpendLedger,
  MandateBudgetError,
  assertAndReserveMandateSpend,
  finalizeMandateSpend,
  setMandateSpendLedgerForTests,
  setMandateSpendReaderForTests
} from '@/lib/spend/mandate-spend';
import {
  InMemoryPaidSubmitLedger,
  PaidSubmitCapError,
  assertAndReservePaidSubmit,
  finalizePaidSubmit,
  setPaidSubmitLedgerForTests
} from '@/lib/spend/paid-submit-cap';
import type { ProductionMandate } from '@/lib/types/mandate';

function liveMandate(overrides: Partial<ProductionMandate> = {}): ProductionMandate {
  return {
    mandateId: 'mandate_1',
    projectId: 'project-1',
    issuedBy: 'user_test',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: 'active',
    brief: '',
    allowedActions: ['generate_image', 'generate_video', 'generate_narration', 'manage_project_music', 'run_production'],
    ...overrides
  };
}

function enablePaidSpendCap(overrides: Record<string, string> = {}): void {
  vi.stubEnv('PAID_SPEND_CAP_ENABLED', 'true');
  vi.stubEnv('PAID_SPEND_CAP_WINDOW_HOURS', '24');
  vi.stubEnv('PAID_SPEND_CAP_MAX_SUBMITS', '10');
  vi.stubEnv('PAID_SPEND_CAP_MAX_IMAGE_SUBMITS', '10');
  vi.stubEnv('PAID_SPEND_CAP_MAX_VIDEO_SUBMITS', '10');
  vi.stubEnv('PAID_SPEND_CAP_MAX_NARRATION_SUBMITS', '10');
  vi.stubEnv('PAID_SPEND_CAP_MAX_MUSIC_SUBMITS', '10');
  vi.stubEnv('PAID_SPEND_CAP_MAX_PRESENTER_SUBMITS', '10');
  for (const [name, value] of Object.entries(overrides)) {
    vi.stubEnv(name, value);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  setPaidSubmitLedgerForTests(undefined);
  setMandateSpendLedgerForTests(undefined);
  setMandateSpendReaderForTests(undefined);
});

describe('mandate spend ledger', () => {
  it('does nothing when no mandate exists', async () => {
    setMandateSpendReaderForTests(async () => null);
    const ledger = new InMemoryMandateSpendLedger();
    setMandateSpendLedgerForTests(ledger);

    await expect(
      assertAndReserveMandateSpend({
        projectId: 'project-1',
        modality: 'image',
        idempotencyKey: 'attempt-1',
        reservationId: 'paid_submit_1'
      })
    ).resolves.toBeUndefined();
    expect((await ledger.snapshot()).entries).toHaveLength(0);
  });

  it('enforces maxSubmits and maxImageSubmits independently', async () => {
    const mandate = liveMandate({ budgets: { maxSubmits: 2, maxImageSubmits: 1 } });
    setMandateSpendReaderForTests(async () => mandate);
    const ledger = new InMemoryMandateSpendLedger();
    setMandateSpendLedgerForTests(ledger);

    await expect(
      assertAndReserveMandateSpend({
        projectId: 'project-1',
        modality: 'image',
        idempotencyKey: 'image-1',
        reservationId: 'paid_submit_1'
      })
    ).resolves.toMatchObject({ reused: false });
    await expect(
      assertAndReserveMandateSpend({
        projectId: 'project-1',
        modality: 'image',
        idempotencyKey: 'image-2',
        reservationId: 'paid_submit_2'
      })
    ).rejects.toMatchObject({ code: 'mandate.budget.exceeded', status: 403 });

    await expect(
      assertAndReserveMandateSpend({
        projectId: 'project-1',
        modality: 'narration',
        idempotencyKey: 'narration-1',
        reservationId: 'paid_submit_3'
      })
    ).resolves.toMatchObject({ reused: false });
    await expect(
      assertAndReserveMandateSpend({
        projectId: 'project-1',
        modality: 'music',
        idempotencyKey: 'music-1',
        reservationId: 'paid_submit_4'
      })
    ).rejects.toMatchObject({ code: 'mandate.budget.exceeded' });
  });

  it('enforces per-modality limits for video, narration, music, and presenter', async () => {
    const mandate = liveMandate({
      budgets: {
        maxVideoSubmits: 1,
        maxNarrationSubmits: 1,
        maxMusicSubmits: 1,
        maxPresenterSubmits: 1
      }
    });
    setMandateSpendReaderForTests(async () => mandate);
    setMandateSpendLedgerForTests(new InMemoryMandateSpendLedger());

    for (const modality of ['video', 'narration', 'music', 'presenter'] as const) {
      await assertAndReserveMandateSpend({
        projectId: 'project-1',
        modality,
        idempotencyKey: `${modality}-1`,
        reservationId: `${modality}-1`
      });
      await expect(
        assertAndReserveMandateSpend({
          projectId: 'project-1',
          modality,
          idempotencyKey: `${modality}-2`,
          reservationId: `${modality}-2`
        })
      ).rejects.toMatchObject({ code: 'mandate.budget.exceeded' });
    }
  });

  it('reuses a reserved idempotency key without double counting', async () => {
    const mandate = liveMandate({ budgets: { maxSubmits: 1 } });
    setMandateSpendReaderForTests(async () => mandate);
    const ledger = new InMemoryMandateSpendLedger();
    setMandateSpendLedgerForTests(ledger);

    const first = await assertAndReserveMandateSpend({
      projectId: 'project-1',
      modality: 'image',
      idempotencyKey: 'attempt-1',
      reservationId: 'paid_submit_1'
    });
    const second = await assertAndReserveMandateSpend({
      projectId: 'project-1',
      modality: 'image',
      idempotencyKey: 'attempt-1',
      reservationId: 'paid_submit_2'
    });
    expect(first?.reused).toBe(false);
    expect(second?.reused).toBe(true);
    expect(second?.id).toBe(first?.id);
    expect((await ledger.snapshot()).entries).toHaveLength(1);
  });

  it('keeps a failed submit in the count', async () => {
    const mandate = liveMandate({ budgets: { maxSubmits: 1 } });
    setMandateSpendReaderForTests(async () => mandate);
    const ledger = new InMemoryMandateSpendLedger();
    setMandateSpendLedgerForTests(ledger);

    const reserved = await assertAndReserveMandateSpend({
      projectId: 'project-1',
      modality: 'image',
      idempotencyKey: 'attempt-1',
      reservationId: 'paid_submit_1'
    });
    await finalizeMandateSpend('project-1', reserved!.id, 'failed');
    await expect(
      assertAndReserveMandateSpend({
        projectId: 'project-1',
        modality: 'image',
        idempotencyKey: 'attempt-2',
        reservationId: 'paid_submit_2'
      })
    ).rejects.toMatchObject({ code: 'mandate.budget.exceeded' });
  });

  it('refuses a new paid submit after revoke or expiry', async () => {
    const ledger = new InMemoryMandateSpendLedger();
    setMandateSpendLedgerForTests(ledger);

    setMandateSpendReaderForTests(async () => liveMandate({ status: 'revoked', revokedAt: new Date().toISOString() }));
    await expect(
      assertAndReserveMandateSpend({
        projectId: 'project-1',
        modality: 'image',
        idempotencyKey: 'attempt-revoked',
        reservationId: 'paid_submit_revoked'
      })
    ).rejects.toMatchObject({ code: 'mandate.budget.denied', status: 403 });

    setMandateSpendReaderForTests(async () =>
      liveMandate({ expiresAt: new Date(Date.now() - 1000).toISOString(), status: 'active' })
    );
    await expect(
      assertAndReserveMandateSpend({
        projectId: 'project-1',
        modality: 'image',
        idempotencyKey: 'attempt-expired',
        reservationId: 'paid_submit_expired'
      })
    ).rejects.toMatchObject({ code: 'mandate.budget.denied' });
    expect((await ledger.snapshot()).entries).toHaveLength(0);
  });

  it('enforces maxCostUsd only when an estimate is known', async () => {
    const mandate = liveMandate({ budgets: { maxCostUsd: 0.2 } });
    setMandateSpendReaderForTests(async () => mandate);
    const ledger = new InMemoryMandateSpendLedger();
    setMandateSpendLedgerForTests(ledger);

    await expect(
      assertAndReserveMandateSpend({
        projectId: 'project-1',
        modality: 'image',
        idempotencyKey: 'image-unknown-cost',
        reservationId: 'paid_submit_image'
      })
    ).resolves.toMatchObject({ reused: false });

    await expect(
      assertAndReserveMandateSpend({
        projectId: 'project-1',
        modality: 'presenter',
        idempotencyKey: 'presenter-1',
        reservationId: 'paid_submit_presenter',
        estimatedUsd: 0.25
      })
    ).rejects.toMatchObject({ code: 'mandate.budget.exceeded' });
  });

  it('serializes concurrent reserves so they cannot overshoot maxSubmits', async () => {
    const mandate = liveMandate({ budgets: { maxSubmits: 1 } });
    setMandateSpendReaderForTests(async () => mandate);
    setMandateSpendLedgerForTests(new InMemoryMandateSpendLedger());

    const results = await Promise.allSettled([
      assertAndReserveMandateSpend({
        projectId: 'project-1',
        modality: 'image',
        idempotencyKey: 'a',
        reservationId: 'a'
      }),
      assertAndReserveMandateSpend({
        projectId: 'project-1',
        modality: 'image',
        idempotencyKey: 'b',
        reservationId: 'b'
      })
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('serializes two file ledgers on the same path', async () => {
    const filePath = path.join(os.tmpdir(), `mandate-spend-${process.pid}-${Date.now()}`, 'mandate-spend.json');
    const mandate = liveMandate({ budgets: { maxSubmits: 1 } });
    const left = new FileMandateSpendLedger({ filePath, lockKey: `mandate-spend:left:${filePath}` });
    const right = new FileMandateSpendLedger({ filePath, lockKey: `mandate-spend:right:${filePath}` });

    const results = await Promise.allSettled([
      left.reserve(mandate, { id: 'a', idempotencyKey: 'a', modality: 'image' }),
      right.reserve(mandate, { id: 'b', idempotencyKey: 'b', modality: 'image' })
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await left.snapshot()).entries).toHaveLength(1);
  });
});

describe('host cap plus mandate budget', () => {
  it('enforces the mandate limit while the host cap still has remaining units', async () => {
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '5', PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '5' });
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
    setMandateSpendLedgerForTests(new InMemoryMandateSpendLedger());
    setMandateSpendReaderForTests(async () => liveMandate({ budgets: { maxImageSubmits: 1 } }));

    await expect(
      assertAndReservePaidSubmit({
        projectId: 'project-1',
        modality: 'image',
        mode: 'real',
        idempotencyKey: 'image-1'
      })
    ).resolves.toMatchObject({ counted: true });
    await expect(
      assertAndReservePaidSubmit({
        projectId: 'project-1',
        modality: 'image',
        mode: 'real',
        idempotencyKey: 'image-2'
      })
    ).rejects.toBeInstanceOf(MandateBudgetError);
  });

  it('rolls back the mandate debit when the host cap rejects the submit', async () => {
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '0', PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '5' });
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
    const mandateLedger = new InMemoryMandateSpendLedger();
    setMandateSpendLedgerForTests(mandateLedger);
    setMandateSpendReaderForTests(async () => liveMandate({ budgets: { maxSubmits: 5 } }));

    await expect(
      assertAndReservePaidSubmit({
        projectId: 'project-1',
        modality: 'image',
        mode: 'real',
        idempotencyKey: 'image-1'
      })
    ).rejects.toBeInstanceOf(PaidSubmitCapError);
    expect((await mandateLedger.snapshot()).entries).toHaveLength(0);
  });

  it('does not debit the host cap twice for a reused mandate reservation', async () => {
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '1', PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '1' });
    const host = new InMemoryPaidSubmitLedger();
    setPaidSubmitLedgerForTests(host);
    setMandateSpendLedgerForTests(new InMemoryMandateSpendLedger());
    setMandateSpendReaderForTests(async () => liveMandate({ budgets: { maxSubmits: 1 } }));

    const first = await assertAndReservePaidSubmit({
      projectId: 'project-1',
      modality: 'image',
      mode: 'real',
      idempotencyKey: 'same-attempt'
    });
    const second = await assertAndReservePaidSubmit({
      projectId: 'project-1',
      modality: 'image',
      mode: 'real',
      idempotencyKey: 'same-attempt'
    });
    expect(first?.id).toBe(second?.id);
    expect((await host.snapshot()).entries).toHaveLength(1);
  });

  it('keeps a reserved debit after a crash with no finalize', async () => {
    enablePaidSpendCap({ PAID_SPEND_CAP_MAX_SUBMITS: '1', PAID_SPEND_CAP_MAX_IMAGE_SUBMITS: '1' });
    setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
    const mandateLedger = new InMemoryMandateSpendLedger();
    setMandateSpendLedgerForTests(mandateLedger);
    setMandateSpendReaderForTests(async () => liveMandate({ budgets: { maxSubmits: 1 } }));

    await assertAndReservePaidSubmit({
      projectId: 'project-1',
      modality: 'image',
      mode: 'real',
      idempotencyKey: 'crash-1'
    });
    expect((await mandateLedger.snapshot()).entries[0]?.status).toBe('reserved');
    await expect(
      assertAndReservePaidSubmit({
        projectId: 'project-1',
        modality: 'image',
        mode: 'real',
        idempotencyKey: 'crash-2'
      })
    ).rejects.toBeInstanceOf(MandateBudgetError);
  });

  it('records known presenter USD on settle without inventing image cost', async () => {
    enablePaidSpendCap();
    const host = new InMemoryPaidSubmitLedger();
    setPaidSubmitLedgerForTests(host);
    const mandateLedger = new InMemoryMandateSpendLedger();
    setMandateSpendLedgerForTests(mandateLedger);
    setMandateSpendReaderForTests(async () => liveMandate({ budgets: { maxCostUsd: 1 } }));

    const reserved = await assertAndReservePaidSubmit({
      projectId: 'project-1',
      modality: 'presenter',
      provider: 'heygen',
      mode: 'real',
      idempotencyKey: 'presenter-1',
      estimatedUsd: 0.1
    });
    await finalizePaidSubmit(reserved, 'completed', { actualUsd: 0.12 });
    expect((await mandateLedger.snapshot()).entries[0]).toMatchObject({
      status: 'completed',
      estimatedUsd: 0.1,
      observedUsd: 0.12
    });
    expect((await host.snapshot()).entries[0]?.observedUsd).toBe(0.12);
  });
});
