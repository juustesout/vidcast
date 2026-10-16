import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  FileStockStateStore,
  InMemoryStockStateStore,
  resolveStockQuotaReserve
} from '@/lib/ai/stock/stock-state-store';

describe('stock quota store', () => {
  it('exposes the documented default window when nothing has been reported', async () => {
    const store = new InMemoryStockStateStore({ now: () => 0 });
    const status = await store.quotaStatus('unsplash', { reserve: 3 });
    expect(status.windowSeconds).toBe(3600);
    expect(status.windowLimit).toBe(50);
    expect(status.windowRemaining).toBe(50);
    expect(status.source).toBe('local');
    expect(status.allowed).toBe(true);
  });

  it('counts requests and stops once inside the safety reserve', async () => {
    let now = 0;
    const store = new InMemoryStockStateStore({ now: () => now });
    for (let index = 0; index < 48; index += 1) {
      await store.recordRequest('unsplash');
      now += 1000;
    }
    const status = await store.quotaStatus('unsplash', { reserve: 3 });
    expect(status.windowCount).toBe(48);
    expect(status.windowRemaining).toBe(2);
    expect(status.allowed).toBe(false);
  });

  it('rolls the hourly window forward', async () => {
    let now = 0;
    const store = new InMemoryStockStateStore({ now: () => now });
    for (let index = 0; index < 10; index += 1) {
      await store.recordRequest('unsplash');
    }
    now += 3600 * 1000 + 1;
    const status = await store.quotaStatus('unsplash', { reserve: 3 });
    expect(status.windowCount).toBe(0);
  });

  it('prefers provider-reported remaining for providers without a monthly cap', async () => {
    const store = new InMemoryStockStateStore({ now: () => 0 });
    await store.recordRequest('unsplash', { limit: 50, remaining: 5, resetAt: 100000 });
    const status = await store.quotaStatus('unsplash', { reserve: 3 });
    expect(status.source).toBe('reported');
    expect(status.windowRemaining).toBe(5);
    expect(status.allowed).toBe(true);
  });

  it('applies a separate monthly cap for Pexels', async () => {
    const store = new InMemoryStockStateStore({ now: () => 0 });
    await store.recordRequest('pexels', { limit: 20000, remaining: 19999, resetAt: 5000 });
    const status = await store.quotaStatus('pexels', { reserve: 3 });
    expect(status.monthlyLimit).toBe(20000);
    expect(status.monthlyRemaining).toBe(19999);
    expect(status.allowed).toBe(true);
  });

  it('uses a 60s window for Pixabay', async () => {
    const store = new InMemoryStockStateStore({ now: () => 0 });
    const status = await store.quotaStatus('pixabay', { reserve: 0 });
    expect(status.windowSeconds).toBe(60);
    expect(status.windowLimit).toBe(100);
  });

  it('records a 429 as exhausted until the reported reset', async () => {
    let now = 0;
    const store = new InMemoryStockStateStore({ now: () => now });
    await store.recordRateLimited('pixabay', { resetAt: 60000 });
    expect((await store.quotaStatus('pixabay', { reserve: 0 })).allowed).toBe(false);
    now = 60001;
    expect((await store.quotaStatus('pixabay', { reserve: 0 })).allowed).toBe(true);
  });

  it('persists quota state across store instances', async () => {
    const filePath = path.join(os.tmpdir(), `stock-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const first = new FileStockStateStore({ filePath, now: () => 1000 });
    await first.recordRequest('pexels');
    const second = new FileStockStateStore({ filePath, now: () => 1000 });
    const status = await second.quotaStatus('pexels', { reserve: 0 });
    expect(status.windowCount).toBe(1);
  });

  it('resolveStockQuotaReserve falls back to 3', () => {
    expect(resolveStockQuotaReserve(undefined)).toBe(3);
    expect(resolveStockQuotaReserve('10')).toBe(10);
    expect(resolveStockQuotaReserve('nonsense')).toBe(3);
  });
});
