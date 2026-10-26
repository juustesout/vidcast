import fs from 'node:fs/promises';
import path from 'node:path';

import { getPaidSpendStatePath } from '@/lib/storage/storage-paths';
import type { RunMode } from '@/lib/production/run-types';
import { createId } from '@/lib/utils/ids';
import { withKeyedLock } from '@/lib/utils/keyed-mutex';
import {
  MandateBudgetError,
  assertAndReserveMandateSpend,
  finalizeMandateSpend,
  rollbackMandateSpend
} from './mandate-spend';

export const PAID_SUBMIT_MODALITIES = ['image', 'video', 'narration', 'music', 'presenter'] as const;

export type PaidSubmitModality = (typeof PAID_SUBMIT_MODALITIES)[number];

export type PaidSubmitCapErrorCode =
  | 'paid.spend.cap.exceeded'
  | 'paid.spend.cap.invalid'
  | 'paid.spend.cap.unavailable'
  | 'paid.spend.cap.in_flight';

export class PaidSubmitCapError extends Error {
  readonly status: number;
  readonly code: PaidSubmitCapErrorCode;

  constructor(message: string, status: number, code: PaidSubmitCapErrorCode) {
    super(message);
    this.name = 'PaidSubmitCapError';
    this.status = status;
    this.code = code;
  }
}

export interface PaidSubmitReserveInput {
  projectId: string;
  sceneId?: string;
  modality: string;
  provider?: string;
  mode: RunMode;
  idempotencyKey?: string;
  estimatedUsd?: number;
}

export interface PaidSubmitReservation {
  id: string;
  counted: true;
  projectId: string;
}

export type PaidSubmitReservationStatus = 'reserved' | 'completed' | 'failed';

export interface PaidSubmitLedgerEntry {
  id: string;
  at: number;
  modality: PaidSubmitModality;
  provider?: string;
  projectId: string;
  sceneId?: string;
  units: number;
  status: PaidSubmitReservationStatus;
  observedUsd?: number;
  settledAt?: number;
}

export interface PaidSubmitLedgerFile {
  version: 1;
  entries: PaidSubmitLedgerEntry[];
}

export type PaidSubmitCapConfig =
  | { enabled: false }
  | {
      enabled: true;
      windowHours: number;
      maxSubmits: number;
      maxByModality: Record<PaidSubmitModality, number>;
      maxByProvider: Record<string, number>;
    };

export interface PaidSubmitSettlement {
  actualUsd?: number;
}

type PaidSubmitReserveEntry = Omit<PaidSubmitLedgerEntry, 'status' | 'at' | 'units'> & {
  at?: number;
  units?: number;
};

export interface PaidSubmitLedger {
  reserve(input: {
    entry: PaidSubmitReserveEntry;
    windowHours: number;
    maxSubmits: number;
    maxModalitySubmits: number;
    maxProviderSubmits?: number;
  }): Promise<PaidSubmitLedgerEntry>;
  finalize(
    id: string,
    status: Exclude<PaidSubmitReservationStatus, 'reserved'>,
    settlement?: PaidSubmitSettlement
  ): Promise<void>;
  snapshot(): Promise<PaidSubmitLedgerFile>;
  reset(): Promise<void>;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
const MAX_LEDGER_ENTRIES = 10000;
const FINALIZE_ATTEMPTS = 3;
const FILE_LOCK_STALE_MS = 30_000;
const FILE_LOCK_RETRY_MS = 20;
const FILE_LOCK_WAIT_MS = 2000;
const PROVIDER_LIMIT_PREFIX = 'PAID_SPEND_CAP_MAX_PROVIDER_';
const PROVIDER_LIMIT_SUFFIX = '_SUBMITS';

function emptyState(): PaidSubmitLedgerFile {
  return { version: 1, entries: [] };
}

export function isPaidSubmitModality(value: unknown): value is PaidSubmitModality {
  return typeof value === 'string' && (PAID_SUBMIT_MODALITIES as readonly string[]).includes(value);
}

export function paidSubmitModalityLimitEnvName(modality: PaidSubmitModality): string {
  return `PAID_SPEND_CAP_MAX_${modality.toUpperCase()}_SUBMITS`;
}

export function normalizePaidSubmitProviderToken(provider: string): string {
  return provider.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function paidSubmitProviderLimitEnvName(provider: string): string {
  return `${PROVIDER_LIMIT_PREFIX}${normalizePaidSubmitProviderToken(provider)}${PROVIDER_LIMIT_SUFFIX}`;
}

function invalidConfig(name: string): PaidSubmitCapError {
  return new PaidSubmitCapError(
    `Paid provider spend cap is enabled but ${name} is missing or invalid.`,
    403,
    'paid.spend.cap.invalid'
  );
}

function unavailableLedger(): PaidSubmitCapError {
  return new PaidSubmitCapError('Paid provider spend cap ledger is unavailable.', 403, 'paid.spend.cap.unavailable');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseNonNegativeInt(raw: string | undefined, name: string): number {
  if (raw === undefined || raw.trim() === '') {
    throw invalidConfig(name);
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw invalidConfig(name);
  }
  return parsed;
}

function parsePositiveNumber(raw: string | undefined, name: string): number {
  if (raw === undefined || raw.trim() === '') {
    throw invalidConfig(name);
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw invalidConfig(name);
  }
  return parsed;
}

function parseEnabledFlag(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  throw invalidConfig('PAID_SPEND_CAP_ENABLED');
}

function parseProviderLimits(env: Record<string, string | undefined>): Record<string, number> {
  const maxByProvider: Record<string, number> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(PROVIDER_LIMIT_PREFIX) || !name.endsWith(PROVIDER_LIMIT_SUFFIX)) {
      continue;
    }
    const token = name.slice(PROVIDER_LIMIT_PREFIX.length, name.length - PROVIDER_LIMIT_SUFFIX.length);
    if (!token || token !== normalizePaidSubmitProviderToken(token)) {
      throw invalidConfig(name);
    }
    maxByProvider[token] = parseNonNegativeInt(value, name);
  }
  return maxByProvider;
}

export function resolvePaidSubmitCapConfig(
  env: Record<string, string | undefined> = process.env
): PaidSubmitCapConfig {
  const enabled = parseEnabledFlag(env.PAID_SPEND_CAP_ENABLED);
  if (!enabled) {
    return { enabled: false };
  }

  const windowHours = parsePositiveNumber(env.PAID_SPEND_CAP_WINDOW_HOURS, 'PAID_SPEND_CAP_WINDOW_HOURS');
  const maxSubmits = parseNonNegativeInt(env.PAID_SPEND_CAP_MAX_SUBMITS, 'PAID_SPEND_CAP_MAX_SUBMITS');
  const maxByModality = {} as Record<PaidSubmitModality, number>;
  for (const modality of PAID_SUBMIT_MODALITIES) {
    const name = paidSubmitModalityLimitEnvName(modality);
    maxByModality[modality] = parseNonNegativeInt(env[name], name);
  }

  return {
    enabled: true,
    windowHours,
    maxSubmits,
    maxByModality,
    maxByProvider: parseProviderLimits(env)
  };
}

function pruneEntries(entries: PaidSubmitLedgerEntry[], cutoff: number): PaidSubmitLedgerEntry[] {
  const kept = entries.filter((entry) => entry.at >= cutoff);
  return kept.length > MAX_LEDGER_ENTRIES ? kept.slice(kept.length - MAX_LEDGER_ENTRIES) : kept;
}

function capExceeded(label: string, count: number, limit: number, windowHours: number): PaidSubmitCapError {
  return new PaidSubmitCapError(
    `Paid provider spend cap exceeded for ${label} (${count}/${limit} in ${windowHours}h).`,
    403,
    'paid.spend.cap.exceeded'
  );
}

function countedUnits(entry: Pick<PaidSubmitLedgerEntry, 'units'>): number {
  if (!Number.isFinite(entry.units) || entry.units <= 0) {
    throw new PaidSubmitCapError(
      'Paid provider spend cap cannot treat unknown cost as zero.',
      403,
      'paid.spend.cap.invalid'
    );
  }
  return entry.units;
}

function sumUnits(entries: PaidSubmitLedgerEntry[]): number {
  return entries.reduce((sum, entry) => sum + countedUnits(entry), 0);
}

function assertNoInFlight(state: PaidSubmitLedgerFile): void {
  const inFlight = state.entries.filter((entry) => entry.status === 'reserved').length;
  if (inFlight > 0) {
    throw new PaidSubmitCapError(
      `Paid provider spend cap reset refused: ${inFlight} reserved submit(s) are still in flight.`,
      403,
      'paid.spend.cap.in_flight'
    );
  }
}

function applyReserve(
  state: PaidSubmitLedgerFile,
  input: {
    entry: Omit<PaidSubmitLedgerEntry, 'status'>;
    windowHours: number;
    maxSubmits: number;
    maxModalitySubmits: number;
    maxProviderSubmits?: number;
  }
): PaidSubmitLedgerEntry {
  const cutoff = input.entry.at - input.windowHours * 60 * 60 * 1000;
  state.entries = pruneEntries(state.entries, cutoff);
  const added = countedUnits(input.entry);
  const hostCount = sumUnits(state.entries);
  const modalityCount = sumUnits(state.entries.filter((entry) => entry.modality === input.entry.modality));
  if (hostCount + added > input.maxSubmits) {
    throw capExceeded(input.entry.modality, hostCount + added, input.maxSubmits, input.windowHours);
  }
  if (modalityCount + added > input.maxModalitySubmits) {
    throw capExceeded(input.entry.modality, modalityCount + added, input.maxModalitySubmits, input.windowHours);
  }
  if (input.maxProviderSubmits !== undefined && input.entry.provider) {
    const providerToken = normalizePaidSubmitProviderToken(input.entry.provider);
    const providerCount = sumUnits(
      state.entries.filter(
        (entry) => entry.provider !== undefined && normalizePaidSubmitProviderToken(entry.provider) === providerToken
      )
    );
    if (providerCount + added > input.maxProviderSubmits) {
      throw capExceeded(input.entry.provider, providerCount + added, input.maxProviderSubmits, input.windowHours);
    }
  }
  const reserved: PaidSubmitLedgerEntry = { ...input.entry, status: 'reserved', units: added };
  state.entries.push(reserved);
  return reserved;
}

function applySettlement(
  entry: PaidSubmitLedgerEntry,
  status: Exclude<PaidSubmitReservationStatus, 'reserved'>,
  settlement?: PaidSubmitSettlement
): PaidSubmitLedgerEntry {
  const next: PaidSubmitLedgerEntry = {
    ...entry,
    status,
    settledAt: Date.now()
  };
  if (settlement?.actualUsd !== undefined) {
    if (!Number.isFinite(settlement.actualUsd) || settlement.actualUsd < 0) {
      throw new PaidSubmitCapError(
        'Paid provider spend cap cannot treat unknown actual cost as zero.',
        403,
        'paid.spend.cap.invalid'
      );
    }
    next.observedUsd = settlement.actualUsd;
  }
  return next;
}

export class InMemoryPaidSubmitLedger implements PaidSubmitLedger {
  private state: PaidSubmitLedgerFile = emptyState();
  private readonly lockKey: string;
  private readonly now: () => number;

  constructor(options: { now?: () => number; lockKey?: string } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.lockKey = options.lockKey ?? `paid-submit-cap:memory:${createId('ledger')}`;
  }

  async reserve(input: {
    entry: PaidSubmitReserveEntry;
    windowHours: number;
    maxSubmits: number;
    maxModalitySubmits: number;
    maxProviderSubmits?: number;
  }): Promise<PaidSubmitLedgerEntry> {
    return withKeyedLock(this.lockKey, async () => {
      const units = input.entry.units ?? resolvePaidSubmitUnits(input.entry.modality);
      const entry = { ...input.entry, at: input.entry.at ?? this.now(), units };
      return applyReserve(this.state, { ...input, entry });
    });
  }

  async finalize(
    id: string,
    status: Exclude<PaidSubmitReservationStatus, 'reserved'>,
    settlement?: PaidSubmitSettlement
  ): Promise<void> {
    await withKeyedLock(this.lockKey, async () => {
      this.state.entries = this.state.entries.map((entry) =>
        entry.id === id ? applySettlement(entry, status, settlement) : entry
      );
    });
  }

  async snapshot(): Promise<PaidSubmitLedgerFile> {
    return { version: 1, entries: [...this.state.entries] };
  }

  async reset(): Promise<void> {
    await withKeyedLock(this.lockKey, async () => {
      assertNoInFlight(this.state);
      this.state = emptyState();
    });
  }
}

export class FilePaidSubmitLedger implements PaidSubmitLedger {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly lockKey: string;
  private readonly lockPath: string;

  constructor(options: { filePath?: string; now?: () => number; lockKey?: string } = {}) {
    this.filePath = options.filePath ?? getPaidSpendStatePath();
    this.now = options.now ?? (() => Date.now());
    this.lockKey = options.lockKey ?? `paid-submit-cap:${this.filePath}`;
    this.lockPath = `${this.filePath}.lock`;
  }

  private async read(): Promise<PaidSubmitLedgerFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return emptyState();
      }
      throw unavailableLedger();
    }

    let parsed: PaidSubmitLedgerFile;
    try {
      parsed = JSON.parse(raw) as PaidSubmitLedgerFile;
    } catch {
      throw unavailableLedger();
    }

    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw unavailableLedger();
    }

    return { version: 1, entries: parsed.entries };
  }

  private async write(state: PaidSubmitLedgerFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const target = this.filePath;
    const temp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temp, target);
  }

  private async acquireFileLock(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const deadline = Date.now() + FILE_LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        const handle = await fs.open(this.lockPath, 'wx');
        try {
          await handle.writeFile(`${process.pid}:${Date.now()}`, 'utf8');
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw unavailableLedger();
        }
        if (await this.tryReclaimStaleLock()) {
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, FILE_LOCK_RETRY_MS));
      }
    }
    throw unavailableLedger();
  }

  private async tryReclaimStaleLock(): Promise<boolean> {
    let raw: string;
    let mtimeMs: number;
    try {
      raw = await fs.readFile(this.lockPath, 'utf8');
      mtimeMs = (await fs.stat(this.lockPath)).mtimeMs;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }

    const [pidRaw, startedAtRaw] = raw.trim().split(':');
    const ownerPid = Number(pidRaw);
    const startedAt = Number(startedAtRaw);
    const ageMs = Number.isFinite(startedAt)
      ? Date.now() - startedAt
      : Date.now() - mtimeMs;

    if (Number.isInteger(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
      return false;
    }

    if (ageMs < FILE_LOCK_STALE_MS) {
      return false;
    }

    return this.unlinkIfUnchanged(raw);
  }

  private async unlinkIfUnchanged(expected: string): Promise<boolean> {
    try {
      const current = await fs.readFile(this.lockPath, 'utf8');
      if (current !== expected) {
        return false;
      }
      await fs.unlink(this.lockPath);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  private async releaseFileLock(): Promise<void> {
    try {
      await fs.unlink(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw unavailableLedger();
      }
    }
  }

  private mutate<T>(operation: (state: PaidSubmitLedgerFile) => T): Promise<T> {
    return withKeyedLock(this.lockKey, async () => {
      await this.acquireFileLock();
      try {
        const state = await this.read();
        const result = operation(state);
        await this.write(state);
        return result;
      } finally {
        await this.releaseFileLock();
      }
    });
  }

  async reserve(input: {
    entry: PaidSubmitReserveEntry;
    windowHours: number;
    maxSubmits: number;
    maxModalitySubmits: number;
    maxProviderSubmits?: number;
  }): Promise<PaidSubmitLedgerEntry> {
    try {
      return await this.mutate((state) => {
        const units = input.entry.units ?? resolvePaidSubmitUnits(input.entry.modality);
        const entry = { ...input.entry, at: input.entry.at ?? this.now(), units };
        return applyReserve(state, { ...input, entry });
      });
    } catch (error) {
      if (error instanceof PaidSubmitCapError) {
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
      state.entries = state.entries.map((entry) =>
        entry.id === id ? applySettlement(entry, status, settlement) : entry
      );
    });
  }

  async snapshot(): Promise<PaidSubmitLedgerFile> {
    return this.read();
  }

  async reset(): Promise<void> {
    await this.mutate((state) => {
      assertNoInFlight(state);
      state.entries = [];
      return state;
    });
  }
}

let testLedger: PaidSubmitLedger | undefined;
let defaultFileLedger: FilePaidSubmitLedger | undefined;

function resolveLedger(): PaidSubmitLedger {
  if (testLedger) {
    return testLedger;
  }
  defaultFileLedger ??= new FilePaidSubmitLedger();
  return defaultFileLedger;
}

export function setPaidSubmitLedgerForTests(ledger: PaidSubmitLedger | undefined): void {
  testLedger = ledger;
}

export async function resetPaidSubmitLedger(): Promise<void> {
  await resolveLedger().reset();
}

export function resolvePaidSubmitUnits(_modality: PaidSubmitModality): number {
  return 1;
}

export function requireEnabledPaidSubmitCapForRealMode(
  mode: RunMode
): Extract<PaidSubmitCapConfig, { enabled: true }> | undefined {
  if (mode !== 'real') {
    return undefined;
  }

  const config = resolvePaidSubmitCapConfig();
  if (!config.enabled) {
    throw new PaidSubmitCapError(
      'Paid provider spend cap is required for real generation but is disabled or unconfigured.',
      403,
      'paid.spend.cap.invalid'
    );
  }

  return config;
}

export async function assertAndReservePaidSubmit(
  input: PaidSubmitReserveInput
): Promise<PaidSubmitReservation | undefined> {
  const config = requireEnabledPaidSubmitCapForRealMode(input.mode);
  if (!config) {
    return undefined;
  }

  if (!isPaidSubmitModality(input.modality)) {
    throw new PaidSubmitCapError(
      `Paid provider spend cap is enabled but modality ${input.modality} is not configured.`,
      403,
      'paid.spend.cap.invalid'
    );
  }

  const units = resolvePaidSubmitUnits(input.modality);
  if (!Number.isFinite(units) || units <= 0) {
    throw new PaidSubmitCapError(
      `Paid provider spend cap cannot treat unknown ${input.modality} cost as zero.`,
      403,
      'paid.spend.cap.invalid'
    );
  }

  const provider = input.provider?.trim() || undefined;
  const providerToken = provider ? normalizePaidSubmitProviderToken(provider) : '';
  if (provider && !providerToken) {
    throw new PaidSubmitCapError(
      `Paid provider spend cap is enabled but provider ${input.provider} is not configured.`,
      403,
      'paid.spend.cap.invalid'
    );
  }
  const maxProviderSubmits = providerToken ? config.maxByProvider[providerToken] : undefined;
  const reservationId = createId('paid_submit');
  const idempotencyKey = input.idempotencyKey?.trim() || reservationId;

  let mandateReserved: { id: string; reused: boolean } | undefined;
  try {
    mandateReserved = await assertAndReserveMandateSpend({
      projectId: input.projectId,
      sceneId: input.sceneId,
      modality: input.modality,
      provider,
      idempotencyKey,
      estimatedUsd: input.estimatedUsd,
      reservationId
    });
  } catch (error) {
    if (error instanceof MandateBudgetError) {
      throw error;
    }
    throw error;
  }

  if (mandateReserved?.reused) {
    return { id: mandateReserved.id, counted: true, projectId: input.projectId };
  }

  try {
    const reserved = await resolveLedger().reserve({
      entry: {
        id: reservationId,
        modality: input.modality,
        provider,
        projectId: input.projectId,
        sceneId: input.sceneId,
        units
      },
      windowHours: config.windowHours,
      maxSubmits: config.maxSubmits,
      maxModalitySubmits: config.maxByModality[input.modality],
      maxProviderSubmits
    });
    return { id: reserved.id, counted: true, projectId: input.projectId };
  } catch (error) {
    if (mandateReserved) {
      await rollbackMandateSpend(input.projectId, reservationId);
    }
    if (error instanceof PaidSubmitCapError) {
      throw error;
    }
    throw unavailableLedger();
  }
}

export async function finalizePaidSubmit(
  reservation: PaidSubmitReservation | undefined,
  status: Exclude<PaidSubmitReservationStatus, 'reserved'>,
  settlement?: PaidSubmitSettlement
): Promise<void> {
  if (!reservation) {
    return;
  }

  for (let attempt = 0; attempt < FINALIZE_ATTEMPTS; attempt += 1) {
    try {
      await resolveLedger().finalize(reservation.id, status, settlement);
      await finalizeMandateSpend(reservation.projectId, reservation.id, status, settlement);
      return;
    } catch (error) {
      if (error instanceof PaidSubmitCapError && error.code === 'paid.spend.cap.invalid') {
        throw error;
      }
      if (error instanceof MandateBudgetError && error.code === 'mandate.budget.invalid') {
        throw error;
      }
    }
  }
}
