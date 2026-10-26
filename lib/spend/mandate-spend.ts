import fs from 'node:fs/promises';
import path from 'node:path';

import {
  isMandateLive,
  readProjectMandate,
  resolveMandateStatus
} from '@/lib/storage/mandate-store';
import { getProjectMandateSpendPath } from '@/lib/storage/storage-paths';
import type { MandateBudgetSettings, ProductionMandate } from '@/lib/types/mandate';
import { FileExclusiveLock } from '@/lib/utils/exclusive-file-lock';
import { withKeyedLock } from '@/lib/utils/keyed-mutex';

import type {
  PaidSubmitModality,
  PaidSubmitReservationStatus,
  PaidSubmitSettlement
} from './paid-submit-cap';

export type MandateBudgetErrorCode =
  | 'mandate.budget.exceeded'
  | 'mandate.budget.invalid'
  | 'mandate.budget.unavailable'
  | 'mandate.budget.denied';

export class MandateBudgetError extends Error {
  readonly status: number;
  readonly code: MandateBudgetErrorCode;

  constructor(message: string, status: number, code: MandateBudgetErrorCode) {
    super(message);
    this.name = 'MandateBudgetError';
    this.status = status;
    this.code = code;
  }
}

export interface MandateSpendEntry {
  id: string;
  idempotencyKey: string;
  at: number;
  modality: PaidSubmitModality;
  provider?: string;
  sceneId?: string;
  units: number;
  estimatedUsd?: number;
  status: PaidSubmitReservationStatus;
  observedUsd?: number;
  settledAt?: number;
}

export interface MandateSpendFile {
  version: 1;
  mandateId: string;
  entries: MandateSpendEntry[];
}

export interface MandateSpendReserveInput {
  id: string;
  idempotencyKey: string;
  modality: PaidSubmitModality;
  provider?: string;
  sceneId?: string;
  estimatedUsd?: number;
  at?: number;
}

export interface MandateSpendReservation {
  id: string;
  reused: boolean;
}

const MAX_LEDGER_ENTRIES = 10000;
const FILE_LOCK_WAIT_MS = 2000;
const FILE_LOCK_RETRY_MS = 20;
const MANDATE_SPEND_MODALITIES = ['image', 'video', 'narration', 'music', 'presenter'] as const;

const MODALITY_LIMIT_KEY: Record<PaidSubmitModality, keyof MandateBudgetSettings> = {
  image: 'maxImageSubmits',
  video: 'maxVideoSubmits',
  narration: 'maxNarrationSubmits',
  music: 'maxMusicSubmits',
  presenter: 'maxPresenterSubmits'
};

function emptyState(mandateId: string): MandateSpendFile {
  return { version: 1, mandateId, entries: [] };
}

function unavailableLedger(): MandateBudgetError {
  return new MandateBudgetError('Mandate spend ledger is unavailable.', 403, 'mandate.budget.unavailable');
}

function isMandateSpendModality(value: string): value is PaidSubmitModality {
  return (MANDATE_SPEND_MODALITIES as readonly string[]).includes(value);
}

function countedUnits(entry: Pick<MandateSpendEntry, 'units'>): number {
  if (!Number.isFinite(entry.units) || entry.units <= 0) {
    throw new MandateBudgetError(
      'Mandate spend ledger cannot treat unknown cost as zero.',
      403,
      'mandate.budget.invalid'
    );
  }
  return entry.units;
}

function sumUnits(entries: MandateSpendEntry[]): number {
  return entries.reduce((sum, entry) => sum + countedUnits(entry), 0);
}

function knownUsd(entry: Pick<MandateSpendEntry, 'estimatedUsd' | 'observedUsd'>): number | undefined {
  const usd = entry.observedUsd !== undefined ? entry.observedUsd : entry.estimatedUsd;
  if (usd === undefined) {
    return undefined;
  }
  if (!Number.isFinite(usd) || usd < 0) {
    throw new MandateBudgetError(
      'Mandate spend ledger cannot treat unknown cost as zero.',
      403,
      'mandate.budget.invalid'
    );
  }
  return usd;
}

function sumKnownUsd(entries: MandateSpendEntry[]): number {
  return entries.reduce((sum, entry) => {
    const usd = knownUsd(entry);
    return usd === undefined ? sum : sum + usd;
  }, 0);
}

function limitExceeded(label: string, count: number, limit: number): MandateBudgetError {
  return new MandateBudgetError(
    `Mandate budget exceeded for ${label} (${count}/${limit}).`,
    403,
    'mandate.budget.exceeded'
  );
}

function assertLiveMandate(mandate: ProductionMandate, atMs: number): void {
  if (isMandateLive(mandate, atMs)) {
    return;
  }
  const status = resolveMandateStatus(mandate, atMs);
  throw new MandateBudgetError(
    `The production mandate is ${status}. New paid actions are not authorized.`,
    403,
    'mandate.budget.denied'
  );
}

function applyReserve(
  state: MandateSpendFile,
  mandate: ProductionMandate,
  input: MandateSpendReserveInput,
  at: number
): { entry: MandateSpendEntry; reused: boolean } {
  assertLiveMandate(mandate, at);
  if (state.mandateId !== mandate.mandateId) {
    state.mandateId = mandate.mandateId;
    state.entries = [];
  }

  const existing = state.entries.find((entry) => entry.idempotencyKey === input.idempotencyKey);
  if (existing) {
    if (existing.status === 'reserved') {
      return { entry: existing, reused: true };
    }
    throw new MandateBudgetError(
      'Mandate spend reservation was already settled for this request.',
      409,
      'mandate.budget.invalid'
    );
  }

  const units = 1;
  const budgets = mandate.budgets;
  const addedUsd = input.estimatedUsd;
  if (addedUsd !== undefined && (!Number.isFinite(addedUsd) || addedUsd < 0)) {
    throw new MandateBudgetError(
      'Mandate spend ledger cannot treat unknown estimated cost as zero.',
      403,
      'mandate.budget.invalid'
    );
  }

  if (budgets?.maxSubmits !== undefined) {
    const next = sumUnits(state.entries) + units;
    if (next > budgets.maxSubmits) {
      throw limitExceeded('submits', next, budgets.maxSubmits);
    }
  }

  const modalityLimit = budgets?.[MODALITY_LIMIT_KEY[input.modality]];
  if (modalityLimit !== undefined) {
    const next = sumUnits(state.entries.filter((entry) => entry.modality === input.modality)) + units;
    if (next > modalityLimit) {
      throw limitExceeded(input.modality, next, modalityLimit);
    }
  }

  if (budgets?.maxCostUsd !== undefined && addedUsd !== undefined) {
    const next = sumKnownUsd(state.entries) + addedUsd;
    if (next > budgets.maxCostUsd + 1e-9) {
      throw new MandateBudgetError(
        `Mandate USD budget exceeded ($${next.toFixed(2)}/$${budgets.maxCostUsd.toFixed(2)}).`,
        403,
        'mandate.budget.exceeded'
      );
    }
  }

  const reserved: MandateSpendEntry = {
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    at,
    modality: input.modality,
    provider: input.provider,
    sceneId: input.sceneId,
    units,
    estimatedUsd: addedUsd,
    status: 'reserved'
  };
  state.entries.push(reserved);
  if (state.entries.length > MAX_LEDGER_ENTRIES) {
    state.entries = state.entries.slice(state.entries.length - MAX_LEDGER_ENTRIES);
  }
  return { entry: reserved, reused: false };
}

function applyFinalize(
  state: MandateSpendFile,
  id: string,
  status: Exclude<PaidSubmitReservationStatus, 'reserved'>,
  settlement?: PaidSubmitSettlement
): void {
  state.entries = state.entries.map((entry) => {
    if (entry.id !== id) {
      return entry;
    }
    const next: MandateSpendEntry = {
      ...entry,
      status,
      settledAt: Date.now()
    };
    if (settlement?.actualUsd !== undefined) {
      if (!Number.isFinite(settlement.actualUsd) || settlement.actualUsd < 0) {
        throw new MandateBudgetError(
          'Mandate spend ledger cannot treat unknown actual cost as zero.',
          403,
          'mandate.budget.invalid'
        );
      }
      next.observedUsd = settlement.actualUsd;
    }
    return next;
  });
}

function applyRollback(state: MandateSpendFile, id: string): void {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) {
    return;
  }
  if (entry.status !== 'reserved') {
    throw new MandateBudgetError(
      'Mandate spend reservation cannot be rolled back after settlement.',
      403,
      'mandate.budget.invalid'
    );
  }
  state.entries = state.entries.filter((item) => item.id !== id);
}

export interface MandateSpendLedger {
  reserve(mandate: ProductionMandate, input: MandateSpendReserveInput): Promise<MandateSpendReservation>;
  finalize(
    id: string,
    status: Exclude<PaidSubmitReservationStatus, 'reserved'>,
    settlement?: PaidSubmitSettlement
  ): Promise<void>;
  rollback(id: string): Promise<void>;
  snapshot(): Promise<MandateSpendFile>;
}

export class InMemoryMandateSpendLedger implements MandateSpendLedger {
  private state: MandateSpendFile | undefined;
  private readonly lockKey: string;
  private readonly now: () => number;

  constructor(options: { now?: () => number; lockKey?: string } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.lockKey = options.lockKey ?? `mandate-spend:memory:${Math.random().toString(36).slice(2)}`;
  }

  async reserve(mandate: ProductionMandate, input: MandateSpendReserveInput): Promise<MandateSpendReservation> {
    return withKeyedLock(this.lockKey, async () => {
      this.state ??= emptyState(mandate.mandateId);
      const result = applyReserve(this.state, mandate, input, input.at ?? this.now());
      return { id: result.entry.id, reused: result.reused };
    });
  }

  async finalize(
    id: string,
    status: Exclude<PaidSubmitReservationStatus, 'reserved'>,
    settlement?: PaidSubmitSettlement
  ): Promise<void> {
    await withKeyedLock(this.lockKey, async () => {
      if (!this.state) {
        return;
      }
      applyFinalize(this.state, id, status, settlement);
    });
  }

  async rollback(id: string): Promise<void> {
    await withKeyedLock(this.lockKey, async () => {
      if (!this.state) {
        return;
      }
      applyRollback(this.state, id);
    });
  }

  async snapshot(): Promise<MandateSpendFile> {
    return this.state
      ? { version: 1, mandateId: this.state.mandateId, entries: [...this.state.entries] }
      : { version: 1, mandateId: '', entries: [] };
  }
}

export class FileMandateSpendLedger implements MandateSpendLedger {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly lockKey: string;
  private readonly fileLock: FileExclusiveLock;

  constructor(options: { filePath: string; now?: () => number; lockKey?: string }) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => Date.now());
    this.lockKey = options.lockKey ?? `mandate-spend:${this.filePath}`;
    this.fileLock = new FileExclusiveLock({ resolvePath: () => `${this.filePath}.lock` });
  }

  private async read(mandateId: string): Promise<MandateSpendFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyState(mandateId);
      }
      throw unavailableLedger();
    }

    let parsed: MandateSpendFile;
    try {
      parsed = JSON.parse(raw) as MandateSpendFile;
    } catch {
      throw unavailableLedger();
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries) || typeof parsed.mandateId !== 'string') {
      throw unavailableLedger();
    }
    return { version: 1, mandateId: parsed.mandateId, entries: parsed.entries };
  }

  private async write(state: MandateSpendFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temp, this.filePath);
  }

  private async mutate<T>(operation: (state: MandateSpendFile) => T, mandateId?: string): Promise<T> {
    return withKeyedLock(this.lockKey, async () => {
      const deadline = Date.now() + FILE_LOCK_WAIT_MS;
      while (Date.now() < deadline) {
        if (await this.fileLock.tryAcquire('lock')) {
          try {
            const state = await this.read(mandateId ?? '');
            const result = operation(state);
            await this.write(state);
            return result;
          } finally {
            await this.fileLock.release('lock');
          }
        }
        await new Promise((resolve) => setTimeout(resolve, FILE_LOCK_RETRY_MS));
      }
      throw unavailableLedger();
    });
  }

  async reserve(mandate: ProductionMandate, input: MandateSpendReserveInput): Promise<MandateSpendReservation> {
    try {
      return await this.mutate((state) => {
        const result = applyReserve(state, mandate, input, input.at ?? this.now());
        return { id: result.entry.id, reused: result.reused };
      }, mandate.mandateId);
    } catch (error) {
      if (error instanceof MandateBudgetError) {
        throw error;
      }
      throw unavailableLedger();
    }
  }

  async finalize(
    id: string,
    status: Exclude<PaidSubmitReservationStatus, 'reserved'>,
    settlement?: PaidSubmitSettlement
  ): Promise<void> {
    await this.mutate((state) => {
      applyFinalize(state, id, status, settlement);
    });
  }

  async rollback(id: string): Promise<void> {
    await this.mutate((state) => {
      applyRollback(state, id);
    });
  }

  async snapshot(): Promise<MandateSpendFile> {
    return this.read('');
  }
}

let testLedger: MandateSpendLedger | undefined;
let testReadMandate: ((projectId: string) => Promise<ProductionMandate | null>) | undefined;

export function setMandateSpendLedgerForTests(ledger: MandateSpendLedger | undefined): void {
  testLedger = ledger;
}

export function setMandateSpendReaderForTests(
  reader: ((projectId: string) => Promise<ProductionMandate | null>) | undefined
): void {
  testReadMandate = reader;
}

function resolveLedger(projectId: string): MandateSpendLedger {
  if (testLedger) {
    return testLedger;
  }
  return new FileMandateSpendLedger({ filePath: getProjectMandateSpendPath(projectId) });
}

async function loadMandate(projectId: string): Promise<ProductionMandate | null> {
  if (testReadMandate) {
    return testReadMandate(projectId);
  }
  return readProjectMandate(projectId);
}

export async function assertAndReserveMandateSpend(input: {
  projectId: string;
  sceneId?: string;
  modality: string;
  provider?: string;
  idempotencyKey: string;
  estimatedUsd?: number;
  reservationId: string;
}): Promise<MandateSpendReservation | undefined> {
  const mandate = await loadMandate(input.projectId);
  if (!mandate) {
    return undefined;
  }

  if (!isMandateSpendModality(input.modality)) {
    throw new MandateBudgetError(
      `Mandate spend ledger cannot reserve unknown modality ${input.modality}.`,
      403,
      'mandate.budget.invalid'
    );
  }

  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) {
    throw new MandateBudgetError('Mandate spend reservation requires an idempotency key.', 403, 'mandate.budget.invalid');
  }

  return resolveLedger(input.projectId).reserve(mandate, {
    id: input.reservationId,
    idempotencyKey,
    modality: input.modality,
    provider: input.provider,
    sceneId: input.sceneId,
    estimatedUsd: input.estimatedUsd
  });
}

export async function finalizeMandateSpend(
  projectId: string,
  reservationId: string,
  status: Exclude<PaidSubmitReservationStatus, 'reserved'>,
  settlement?: PaidSubmitSettlement
): Promise<void> {
  const mandate = await loadMandate(projectId);
  if (!mandate && !testLedger) {
    return;
  }
  await resolveLedger(projectId).finalize(reservationId, status, settlement);
}

export async function rollbackMandateSpend(projectId: string, reservationId: string): Promise<void> {
  const mandate = await loadMandate(projectId);
  if (!mandate && !testLedger) {
    return;
  }
  await resolveLedger(projectId).rollback(reservationId);
}
