// Process-global, provider-keyed concurrency limiter.
//
// Provider APIs impose their own simultaneous-request ceilings (for example
// ElevenLabs allows at most 3 concurrent text-to-speech requests). A run may fan
// out narration across many scenes, and the server may execute several runs at
// once, so a per-call or per-run limiter is not enough: the ceiling is a property
// of the provider and must be shared by every caller in the process.
//
// The semaphore state is stored on `globalThis` so it is shared across separate
// Next.js route/module instances (which each get their own module state in dev),
// exactly like the stock candidate cache. It is a simple FIFO counting semaphore:
// a released slot is handed directly to the next waiter instead of being
// decremented and re-acquired, which avoids starvation and races.

interface KeyedLimiterState {
  active: Map<string, number>;
  queues: Map<string, Array<() => void>>;
}

const KEYED_LIMITER_GLOBAL_KEY = '__explainerKeyedLimiter__';

function limiterState(): KeyedLimiterState {
  const globalRef = globalThis as typeof globalThis & {
    [KEYED_LIMITER_GLOBAL_KEY]?: KeyedLimiterState;
  };
  globalRef[KEYED_LIMITER_GLOBAL_KEY] ??= {
    active: new Map<string, number>(),
    queues: new Map<string, Array<() => void>>()
  };
  return globalRef[KEYED_LIMITER_GLOBAL_KEY];
}

export function resolveProviderConcurrencyLimit(raw: string | undefined, fallback: number, max = 32): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(max, parsed);
}

// Runs `task` while holding one of `limit` slots for `key`. Slots are released
// even when the task throws. `limit` values below 1 are treated as 1.
export async function withKeyedLimit<T>(key: string, limit: number, task: () => Promise<T>): Promise<T> {
  const state = limiterState();
  const safeLimit = Math.max(1, Math.floor(limit) || 1);

  const active = state.active.get(key) ?? 0;
  if (active >= safeLimit) {
    await new Promise<void>((resolve) => {
      const queue = state.queues.get(key) ?? [];
      queue.push(resolve);
      state.queues.set(key, queue);
    });
    // A slot was transferred to this waiter by the releaser; `active` is
    // unchanged, so there is nothing to increment here.
  } else {
    state.active.set(key, active + 1);
  }

  try {
    return await task();
  } finally {
    const queue = state.queues.get(key);
    const next = queue?.shift();
    if (next) {
      if (queue && queue.length === 0) {
        state.queues.delete(key);
      }
      // Hand the slot to the next waiter without decrementing `active`.
      next();
    } else {
      const remaining = (state.active.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        state.active.delete(key);
      } else {
        state.active.set(key, remaining);
      }
    }
  }
}

// Test-only: clears all in-flight counts and waiters.
export function resetKeyedLimiterForTests(): void {
  const globalRef = globalThis as typeof globalThis & {
    [KEYED_LIMITER_GLOBAL_KEY]?: KeyedLimiterState;
  };
  delete globalRef[KEYED_LIMITER_GLOBAL_KEY];
}
