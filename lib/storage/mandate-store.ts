import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_MANDATE_ACTIONS,
  DEFAULT_MANDATE_TTL_MS,
  MAX_MANDATE_TTL_MS,
  MIN_MANDATE_TTL_MS,
  MANDATE_ACTIONS,
  type MandateAction,
  type MandateBudgetSettings,
  type MandateProviderAllowlist,
  type MandateStatus,
  type ProductionMandate
} from '@/lib/types/mandate';
import { createId } from '@/lib/utils/ids';
import { withKeyedLock } from '@/lib/utils/keyed-mutex';
import { getProjectMandatePath } from './storage-paths';

export class MandateStoreError extends Error {
  readonly code:
    | 'MANDATE_NOT_FOUND'
    | 'MANDATE_INVALID'
    | 'MANDATE_EXPIRED'
    | 'MANDATE_REVOKED'
    | 'MANDATE_CONSUMED'
    | 'MANDATE_FAILED'
    | 'MANDATE_BOUND'
    | 'MANDATE_CONFLICT';
  readonly status: number;

  constructor(
    message: string,
    code:
      | 'MANDATE_NOT_FOUND'
      | 'MANDATE_INVALID'
      | 'MANDATE_EXPIRED'
      | 'MANDATE_REVOKED'
      | 'MANDATE_CONSUMED'
      | 'MANDATE_FAILED'
      | 'MANDATE_BOUND'
      | 'MANDATE_CONFLICT',
    status: number
  ) {
    super(message);
    this.name = 'MandateStoreError';
    this.code = code;
    this.status = status;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function mandateLockKey(projectId: string): string {
  return `mandate:${projectId}`;
}

function nowMs(now?: () => number): number {
  return now ? now() : Date.now();
}

function nowIso(now?: () => number): string {
  return new Date(nowMs(now)).toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isMandateAction(value: unknown): value is MandateAction {
  return typeof value === 'string' && (MANDATE_ACTIONS as string[]).includes(value);
}

function isMandateStatus(value: unknown): value is MandateStatus {
  return value === 'active' || value === 'consumed' || value === 'revoked' || value === 'expired' || value === 'failed';
}

function parseStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
  return items.length > 0 ? Array.from(new Set(items)) : undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function parseBudgets(value: unknown): MandateBudgetSettings | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const budgets: MandateBudgetSettings = {
    maxSubmits: parsePositiveInt(value.maxSubmits),
    maxImageSubmits: parsePositiveInt(value.maxImageSubmits),
    maxVideoSubmits: parsePositiveInt(value.maxVideoSubmits),
    maxNarrationSubmits: parsePositiveInt(value.maxNarrationSubmits),
    maxMusicSubmits: parsePositiveInt(value.maxMusicSubmits),
    maxPresenterSubmits: parsePositiveInt(value.maxPresenterSubmits),
    maxCostUsd: typeof value.maxCostUsd === 'number' && Number.isFinite(value.maxCostUsd) && value.maxCostUsd > 0 ? value.maxCostUsd : undefined
  };
  return Object.values(budgets).some((entry) => entry !== undefined) ? budgets : undefined;
}

function parseAllowedProviders(value: unknown): MandateProviderAllowlist | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const allowlist: MandateProviderAllowlist = {
    image: parseStringList(value.image) as MandateProviderAllowlist['image'],
    video: parseStringList(value.video) as MandateProviderAllowlist['video'],
    narration: parseStringList(value.narration) as MandateProviderAllowlist['narration'],
    music: parseStringList(value.music) as MandateProviderAllowlist['music'],
    presenter: parseStringList(value.presenter) as MandateProviderAllowlist['presenter'],
    stock: parseStringList(value.stock) as MandateProviderAllowlist['stock']
  };
  return Object.values(allowlist).some((entry) => entry !== undefined) ? allowlist : undefined;
}

export function parseProductionMandate(value: unknown, projectId: string): ProductionMandate | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const mandateId = asTrimmedString(value.mandateId);
  const storedProjectId = asTrimmedString(value.projectId);
  const issuedBy = asTrimmedString(value.issuedBy);
  const issuedAt = asTrimmedString(value.issuedAt);
  const expiresAt = asTrimmedString(value.expiresAt);
  if (!mandateId || !storedProjectId || storedProjectId !== projectId || !issuedBy || !issuedAt || !expiresAt) {
    return null;
  }
  if (!isMandateStatus(value.status)) {
    return null;
  }

  const allowedActions = Array.isArray(value.allowedActions)
    ? Array.from(new Set(value.allowedActions.filter(isMandateAction)))
    : [];
  if (allowedActions.length === 0) {
    return null;
  }

  return {
    mandateId,
    projectId: storedProjectId,
    issuedBy,
    issuedAt,
    expiresAt,
    status: value.status,
    brief: typeof value.brief === 'string' ? value.brief : '',
    allowedActions,
    allowedProviders: parseAllowedProviders(value.allowedProviders),
    budgets: parseBudgets(value.budgets),
    maxDurationMs: parsePositiveInt(value.maxDurationMs),
    boundRunId: asTrimmedString(value.boundRunId),
    consumedAt: asTrimmedString(value.consumedAt),
    revokedAt: asTrimmedString(value.revokedAt),
    failedAt: asTrimmedString(value.failedAt)
  };
}

export function resolveMandateStatus(mandate: ProductionMandate, atMs = Date.now()): MandateStatus {
  if (mandate.status === 'revoked' || mandate.status === 'failed' || mandate.status === 'expired') {
    return mandate.status;
  }
  const expiresAtMs = Date.parse(mandate.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= atMs) {
    return 'expired';
  }
  if (mandate.maxDurationMs && Date.parse(mandate.issuedAt) + mandate.maxDurationMs <= atMs) {
    return 'expired';
  }
  return mandate.status;
}

export function isMandateLive(mandate: ProductionMandate, atMs = Date.now()): boolean {
  const status = resolveMandateStatus(mandate, atMs);
  return status === 'active' || (status === 'consumed' && Boolean(mandate.boundRunId));
}

export async function readProjectMandate(projectId: string): Promise<ProductionMandate | null> {
  let raw: string;
  try {
    raw = await fs.readFile(getProjectMandatePath(projectId), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  return parseProductionMandate(parsed, projectId);
}

export async function writeProjectMandate(mandate: ProductionMandate): Promise<void> {
  const target = getProjectMandatePath(mandate.projectId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(mandate, null, 2), 'utf8');
}

export async function deleteProjectMandate(projectId: string): Promise<void> {
  await fs.rm(getProjectMandatePath(projectId), { force: true });
}

export interface CreateMandateInput {
  projectId: string;
  issuedBy: string;
  brief?: string;
  allowedActions?: MandateAction[];
  allowedProviders?: MandateProviderAllowlist;
  budgets?: MandateBudgetSettings;
  ttlMs?: number;
  maxDurationMs?: number;
  expiresAt?: string;
}

export async function createProjectMandate(input: CreateMandateInput, now: () => number = Date.now): Promise<ProductionMandate> {
  return withKeyedLock(mandateLockKey(input.projectId), async () => {
    const existing = await readProjectMandate(input.projectId);
    if (existing && resolveMandateStatus(existing, now()) === 'active') {
      throw new MandateStoreError('An active production mandate already exists for this project.', 'MANDATE_CONFLICT', 409);
    }

    const issuedAtMs = now();
    const ttlMs = Math.min(MAX_MANDATE_TTL_MS, Math.max(MIN_MANDATE_TTL_MS, input.ttlMs ?? DEFAULT_MANDATE_TTL_MS));
    const expiresAt = input.expiresAt && Number.isFinite(Date.parse(input.expiresAt))
      ? new Date(input.expiresAt).toISOString()
      : new Date(issuedAtMs + ttlMs).toISOString();
    const allowedActions = (input.allowedActions && input.allowedActions.length > 0 ? input.allowedActions : DEFAULT_MANDATE_ACTIONS)
      .filter(isMandateAction);
    const uniqueActions = Array.from(new Set(allowedActions));
    if (uniqueActions.length === 0) {
      throw new MandateStoreError('A production mandate must allow at least one action.', 'MANDATE_INVALID', 400);
    }

    const mandate: ProductionMandate = {
      mandateId: createId('mandate'),
      projectId: input.projectId,
      issuedBy: input.issuedBy,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt,
      status: 'active',
      brief: input.brief?.trim() ?? '',
      allowedActions: uniqueActions,
      allowedProviders: input.allowedProviders,
      budgets: input.budgets,
      maxDurationMs: input.maxDurationMs
    };
    await writeProjectMandate(mandate);
    return mandate;
  });
}

export async function revokeProjectMandate(projectId: string, now: () => number = Date.now): Promise<ProductionMandate> {
  return withKeyedLock(mandateLockKey(projectId), async () => {
    const existing = await readProjectMandate(projectId);
    if (!existing) {
      throw new MandateStoreError('No production mandate exists for this project.', 'MANDATE_NOT_FOUND', 404);
    }
    const status = resolveMandateStatus(existing, now());
    if (status === 'revoked') {
      return existing;
    }
    const next: ProductionMandate = {
      ...existing,
      status: 'revoked',
      revokedAt: nowIso(now)
    };
    await writeProjectMandate(next);
    return next;
  });
}

export async function requireLiveProjectMandate(projectId: string, now: () => number = Date.now): Promise<ProductionMandate> {
  const mandate = await readProjectMandate(projectId);
  if (!mandate) {
    throw new MandateStoreError('A production mandate is required for this project.', 'MANDATE_NOT_FOUND', 403);
  }
  const status = resolveMandateStatus(mandate, now());
  if (status === 'revoked') {
    throw new MandateStoreError('The production mandate for this project has been revoked.', 'MANDATE_REVOKED', 403);
  }
  if (status === 'expired') {
    throw new MandateStoreError('The production mandate for this project has expired.', 'MANDATE_EXPIRED', 403);
  }
  if (status === 'failed') {
    throw new MandateStoreError('The production mandate for this project has failed.', 'MANDATE_FAILED', 403);
  }
  if (status === 'consumed' && !mandate.boundRunId) {
    throw new MandateStoreError('The production mandate for this project has already been consumed.', 'MANDATE_CONSUMED', 403);
  }
  return { ...mandate, status };
}

export async function bindProjectMandateRun(
  projectId: string,
  runId: string,
  now: () => number = Date.now
): Promise<ProductionMandate> {
  return withKeyedLock(mandateLockKey(projectId), async () => {
    const existing = await requireLiveProjectMandate(projectId, now);
    if (existing.boundRunId && existing.boundRunId !== runId) {
      throw new MandateStoreError('The production mandate is already bound to another run.', 'MANDATE_BOUND', 409);
    }
    if (existing.boundRunId === runId && existing.status === 'consumed') {
      return existing;
    }
    const next: ProductionMandate = {
      ...existing,
      status: 'consumed',
      boundRunId: runId,
      consumedAt: existing.consumedAt ?? nowIso(now)
    };
    await writeProjectMandate(next);
    return next;
  });
}

export function publicMandateView(mandate: ProductionMandate): ProductionMandate {
  return { ...mandate };
}
