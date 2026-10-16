import fs from 'node:fs/promises';
import path from 'node:path';

import { getStockStateDir, getStockStatePath } from '@/lib/storage/storage-paths';
import type { StockProviderId, StockRateLimitSnapshot, StockSelection } from '@/lib/types/stock';
import { withKeyedLock } from '@/lib/utils/keyed-mutex';

import { STOCK_PROVIDER_CATALOG } from './catalog';

export interface StockQuotaStatus {
  provider: StockProviderId;
  windowSeconds: number;
  windowLimit: number;
  windowCount: number;
  windowRemaining: number;
  monthlyLimit?: number;
  monthlyCount?: number;
  monthlyRemaining?: number;
  resetAt?: number;
  reserve: number;
  // True when at least one request may be made while still respecting the
  // configured safety margin.
  allowed: boolean;
  // Whether the limit/remaining values came from provider headers or local
  // accounting. Surfaced for diagnostics.
  source: 'reported' | 'local';
}

export interface StockStateStore {
  quotaStatus(provider: StockProviderId, options?: { reserve?: number }): Promise<StockQuotaStatus>;
  canRequest(provider: StockProviderId, reserve: number): Promise<boolean>;
  recordRequest(provider: StockProviderId, rateLimit?: StockRateLimitSnapshot): Promise<StockQuotaStatus>;
  // Records an observed 429/quota exhaustion so the router stops calling the
  // provider until the reported reset (or one window) elapses.
  recordRateLimited(provider: StockProviderId, rateLimit?: StockRateLimitSnapshot): Promise<void>;
  getCachedSelection(key: string): Promise<StockSelection | undefined>;
  setCachedSelection(key: string, selection: StockSelection): Promise<void>;
  reset(): Promise<void>;
}

interface ProviderState {
  events: number[];
  reported?: StockRateLimitSnapshot;
  updatedAt?: string;
}

interface StockStateFile {
  version: 1;
  providers: Record<string, ProviderState>;
  cache: Record<string, StockSelection>;
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 20000;

export function resolveStockQuotaReserve(raw?: string): number {
  const value = raw ?? process.env.STOCK_QUOTA_SAFETY_MARGIN;
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 3;
  }
  return parsed;
}

function emptyState(): StockStateFile {
  return { version: 1, providers: {}, cache: {} };
}

function providerState(state: StockStateFile, provider: StockProviderId): ProviderState {
  return state.providers[provider] ?? { events: [] };
}

function pruneEvents(events: number[], now: number): number[] {
  const cutoff = now - MONTH_MS;
  const kept = events.filter((timestamp) => timestamp >= cutoff);
  return kept.length > MAX_EVENTS ? kept.slice(kept.length - MAX_EVENTS) : kept;
}

export function computeQuotaStatus(
  provider: StockProviderId,
  state: ProviderState,
  now: number,
  reserve: number
): StockQuotaStatus {
  const catalog = STOCK_PROVIDER_CATALOG[provider];
  const windowSeconds = catalog.windowSeconds;
  const events = pruneEvents(state.events ?? [], now);

  const windowCount = events.filter((timestamp) => timestamp >= now - windowSeconds * 1000).length;
  const report = state.reported;
  const reportFresh = report !== undefined && (report.resetAt === undefined || report.resetAt > now);

  let windowLimit = catalog.windowLimit;
  let source: 'reported' | 'local' = 'local';

  // A fresh report from the provider always wins over the documented default.
  if (reportFresh && report?.limit !== undefined) {
    windowLimit = report.limit;
    source = 'reported';
  }

  const windowRemaining =
    reportFresh && report?.remaining !== undefined && !catalog.monthlyLimit
      ? Math.max(0, report.remaining)
      : Math.max(0, windowLimit - windowCount);

  let monthlyLimit = catalog.monthlyLimit;
  let monthlyCount: number | undefined;
  let monthlyRemaining: number | undefined;

  if (monthlyLimit !== undefined) {
    monthlyCount = events.filter((timestamp) => timestamp >= now - MONTH_MS).length;
    monthlyRemaining =
      reportFresh && report?.remaining !== undefined
        ? Math.max(0, report.remaining)
        : Math.max(0, monthlyLimit - monthlyCount);
    if (reportFresh && report?.limit !== undefined && report.limit >= monthlyLimit) {
      monthlyLimit = report.limit;
      source = 'reported';
    }
  }

  const allowed =
    windowRemaining > reserve && (monthlyRemaining === undefined || monthlyRemaining > reserve);

  return {
    provider,
    windowSeconds,
    windowLimit,
    windowCount,
    windowRemaining,
    monthlyLimit,
    monthlyCount,
    monthlyRemaining,
    resetAt: reportFresh ? report?.resetAt : undefined,
    reserve,
    allowed,
    source
  };
}

export class InMemoryStockStateStore implements StockStateStore {
  private state: StockStateFile = emptyState();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async quotaStatus(provider: StockProviderId, options?: { reserve?: number }): Promise<StockQuotaStatus> {
    return computeQuotaStatus(provider, providerState(this.state, provider), this.now(), options?.reserve ?? resolveStockQuotaReserve());
  }

  async canRequest(provider: StockProviderId, reserve: number): Promise<boolean> {
    return (await this.quotaStatus(provider, { reserve })).allowed;
  }

  async recordRequest(provider: StockProviderId, rateLimit?: StockRateLimitSnapshot): Promise<StockQuotaStatus> {
    const now = this.now();
    const current = providerState(this.state, provider);
    const events = pruneEvents([...(current.events ?? []), now], now);
    const reported = rateLimit ? { ...(current.reported ?? {}), ...stripUndefined(rateLimit) } : current.reported;
    this.state.providers[provider] = { events, reported, updatedAt: new Date(now).toISOString() };
    return this.quotaStatus(provider, { reserve: resolveStockQuotaReserve() });
  }

  async recordRateLimited(provider: StockProviderId, rateLimit?: StockRateLimitSnapshot): Promise<void> {
    const now = this.now();
    const current = providerState(this.state, provider);
    this.state.providers[provider] = {
      ...current,
      reported: {
        ...(current.reported ?? {}),
        limit: rateLimit?.limit ?? current.reported?.limit,
        remaining: 0,
        resetAt: rateLimit?.resetAt ?? now + STOCK_PROVIDER_CATALOG[provider].windowSeconds * 1000
      },
      updatedAt: new Date(now).toISOString()
    };
  }

  async getCachedSelection(key: string): Promise<StockSelection | undefined> {
    return this.state.cache[key];
  }

  async setCachedSelection(key: string, selection: StockSelection): Promise<void> {
    this.state.cache[key] = selection;
  }

  async reset(): Promise<void> {
    this.state = emptyState();
  }
}

function stripUndefined(input: StockRateLimitSnapshot): StockRateLimitSnapshot {
  const output: StockRateLimitSnapshot = {};
  if (input.limit !== undefined) output.limit = input.limit;
  if (input.remaining !== undefined) output.remaining = input.remaining;
  if (input.resetAt !== undefined) output.resetAt = input.resetAt;
  if (input.windowSeconds !== undefined) output.windowSeconds = input.windowSeconds;
  return output;
}

export class FileStockStateStore implements StockStateStore {
  private readonly filePath: string;
  private readonly now: () => number;

  constructor(options: { filePath?: string; now?: () => number } = {}) {
    this.filePath = options.filePath ?? getStockStatePath();
    this.now = options.now ?? (() => Date.now());
  }

  private async read(): Promise<StockStateFile> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StockStateFile;
      if (!parsed || parsed.version !== 1) {
        return emptyState();
      }
      return { version: 1, providers: parsed.providers ?? {}, cache: parsed.cache ?? {} };
    } catch {
      return emptyState();
    }
  }

  private async write(state: StockStateFile): Promise<void> {
    const dir = getStockStateDir();
    await fs.mkdir(dir, { recursive: true });
    const target = this.filePath;
    const temp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temp, target);
  }

  private mutate<T>(operation: (state: StockStateFile) => { result: T; changed: boolean }): Promise<T> {
    return withKeyedLock(`stock-state:${this.filePath}`, async () => {
      const state = await this.read();
      const { result, changed } = operation(state);
      if (changed) {
        await this.write(state);
      }
      return result;
    });
  }

  async quotaStatus(provider: StockProviderId, options?: { reserve?: number }): Promise<StockQuotaStatus> {
    const state = await this.read();
    return computeQuotaStatus(provider, providerState(state, provider), this.now(), options?.reserve ?? resolveStockQuotaReserve());
  }

  async canRequest(provider: StockProviderId, reserve: number): Promise<boolean> {
    return (await this.quotaStatus(provider, { reserve })).allowed;
  }

  async recordRequest(provider: StockProviderId, rateLimit?: StockRateLimitSnapshot): Promise<StockQuotaStatus> {
    return this.mutate((state) => {
      const now = this.now();
      const current = providerState(state, provider);
      const events = pruneEvents([...(current.events ?? []), now], now);
      const reported = rateLimit ? { ...(current.reported ?? {}), ...stripUndefined(rateLimit) } : current.reported;
      state.providers[provider] = { events, reported, updatedAt: new Date(now).toISOString() };
      return { result: computeQuotaStatus(provider, state.providers[provider], now, resolveStockQuotaReserve()), changed: true };
    });
  }

  async recordRateLimited(provider: StockProviderId, rateLimit?: StockRateLimitSnapshot): Promise<void> {
    await this.mutate((state) => {
      const now = this.now();
      const current = providerState(state, provider);
      state.providers[provider] = {
        ...current,
        reported: {
          ...(current.reported ?? {}),
          limit: rateLimit?.limit ?? current.reported?.limit,
          remaining: 0,
          resetAt: rateLimit?.resetAt ?? now + STOCK_PROVIDER_CATALOG[provider].windowSeconds * 1000
        },
        updatedAt: new Date(now).toISOString()
      };
      return { result: undefined, changed: true };
    });
  }

  async getCachedSelection(key: string): Promise<StockSelection | undefined> {
    const state = await this.read();
    return state.cache[key];
  }

  async setCachedSelection(key: string, selection: StockSelection): Promise<void> {
    await this.mutate((state) => {
      state.cache[key] = selection;
      return { result: undefined, changed: true };
    });
  }

  async reset(): Promise<void> {
    await this.mutate((state) => {
      state.providers = {};
      state.cache = {};
      return { result: undefined, changed: true };
    });
  }
}

export function defaultStockStateFilePath(): string {
  return getStockStatePath();
}

export const stockStateDirName = path.basename(getStockStateDir());
