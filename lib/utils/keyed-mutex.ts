/**
 * In-process, per-key async mutex.
 *
 * Operations sharing a key run strictly one at a time, in call order. The lock
 * is scoped to a single Node process: it serializes callers that share the same
 * JS module instance. It is intentionally not a cross-process lock (there is no
 * file or OS lock here).
 */
const tails = new Map<string, Promise<void>>();

export function withKeyedLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();

  const result = previous.then(operation, operation);

  const settled = result.then(
    () => undefined,
    () => undefined
  );

  tails.set(key, settled);
  void settled.then(() => {
    if (tails.get(key) === settled) {
      tails.delete(key);
    }
  });

  return result;
}
