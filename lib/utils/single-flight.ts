/**
 * Runs an async operation at most once at a time. A second call while the first
 * is still in flight is ignored (returns `undefined`) instead of starting a
 * duplicate request. Used to prevent double submissions of paid music
 * generation actions.
 */
export interface SingleFlight {
  readonly active: boolean;
  run<T>(operation: () => Promise<T>): Promise<T | undefined>;
}

export function createSingleFlight(): SingleFlight {
  let active = false;

  return {
    get active() {
      return active;
    },
    async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
      if (active) {
        return undefined;
      }

      active = true;
      try {
        return await operation();
      } finally {
        active = false;
      }
    }
  };
}
