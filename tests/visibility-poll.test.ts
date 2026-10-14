import { describe, expect, it, vi } from 'vitest';

import { isHidden, resumedFromHidden, subscribeToVisibility, type VisibilityTarget } from '@/lib/client/visibility-poll';

type FakeTarget = VisibilityTarget & {
  trigger: (state: string) => void;
  listenerCount: () => number;
};

function createTarget(initialState = 'visible'): FakeTarget {
  const listeners = new Set<() => void>();

  const target: FakeTarget = {
    visibilityState: initialState,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
    trigger: (state) => {
      target.visibilityState = state;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    listenerCount: () => listeners.size
  };

  return target;
}

describe('polling visibility helpers', () => {
  it('detects the hidden document state', () => {
    expect(isHidden('hidden')).toBe(true);
    expect(isHidden('visible')).toBe(false);
    expect(isHidden(undefined)).toBe(false);
  });

  it('reports only a hidden to visible transition as a resume', () => {
    expect(resumedFromHidden(true, false)).toBe(true);
    expect(resumedFromHidden(false, true)).toBe(false);
    expect(resumedFromHidden(true, true)).toBe(false);
    expect(resumedFromHidden(false, false)).toBe(false);
  });
});

describe('subscribeToVisibility', () => {
  it('notifies with the derived hidden flag and unsubscribes cleanly', () => {
    const target = createTarget('visible');
    const handler = vi.fn();

    const unsubscribe = subscribeToVisibility(handler, target);
    expect(target.listenerCount()).toBe(1);

    target.trigger('hidden');
    expect(handler).toHaveBeenLastCalledWith(true);

    target.trigger('visible');
    expect(handler).toHaveBeenLastCalledWith(false);

    unsubscribe();
    expect(target.listenerCount()).toBe(0);

    target.trigger('hidden');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when no document target is available', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToVisibility(handler, null);

    expect(() => unsubscribe()).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});
