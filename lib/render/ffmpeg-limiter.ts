import {
  getKeyedLimitActiveCount,
  getKeyedLimitQueueLength,
  resetKeyedLimiterForTests,
  withKeyedLimit
} from '@/lib/concurrency/keyed-limiter';

// Local FFmpeg is the dominant memory consumer in the render pipeline: one
// 1080p scene render/normalize peaks around 500 MiB. The semaphore is keyed and
// stored on globalThis by the shared keyed limiter, so every route/module
// instance in this Node.js process uses the same slots.
export const FFMPEG_LIMITER_KEY = 'ffmpeg:local-spawn';
export const FFMPEG_CONCURRENCY_ENV = 'FFMPEG_MAX_CONCURRENCY';
export const DEFAULT_FFMPEG_CONCURRENCY = 1;
// Deliberately conservative hard ceiling. The known 8-GB runtime needs 1; a
// larger host can opt in to more, but an accidental `8` must not come back.
export const MAX_FFMPEG_CONCURRENCY = 4;
// Waiters are bounded as well. The supported runtime has at most two active
// runs and a small number of scenes, so this is an overflow guard, not a
// throughput tuning knob.
export const MAX_FFMPEG_QUEUE = 64;
export const FFMPEG_WAIT_LOG_THRESHOLD_MS = 1_000;

export type FfmpegOperation = 'scene_render' | 'final_compose' | 'presenter_generate';

export function resolveFfmpegConcurrencyLimit(
  raw: string | undefined,
  fallback = DEFAULT_FFMPEG_CONCURRENCY,
  max = MAX_FFMPEG_CONCURRENCY
): number {
  const value = raw?.trim();
  // Strict integer parsing: "2abc", "+2", "2.0" and out-of-range values fall
  // back instead of being partially accepted.
  if (!value || !/^\d+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    return fallback;
  }
  return parsed;
}

export function getFfmpegConcurrencyLimit(env: NodeJS.ProcessEnv = process.env): number {
  return resolveFfmpegConcurrencyLimit(env[FFMPEG_CONCURRENCY_ENV]);
}

export interface FfmpegLimiterStats {
  limit: number;
  active: number;
  queued: number;
}

export function getFfmpegLimiterStats(): FfmpegLimiterStats {
  return {
    limit: getFfmpegConcurrencyLimit(),
    active: getKeyedLimitActiveCount(FFMPEG_LIMITER_KEY),
    queued: getKeyedLimitQueueLength(FFMPEG_LIMITER_KEY)
  };
}

// The actual FFmpeg spawn path. The slot is acquired before the process is
// spawned and released by the keyed limiter's finally block on success,
// rejection, timeout and process failure. A process restart discards this
// process-local state, so a dead process cannot leave a slot held.
export async function withFfmpegSlot<T>(operation: FfmpegOperation, task: () => Promise<T>): Promise<T> {
  const limit = getFfmpegConcurrencyLimit();
  const requestedAt = Date.now();

  return withKeyedLimit(
    FFMPEG_LIMITER_KEY,
    limit,
    async () => {
      const waitedMs = Date.now() - requestedAt;
      if (waitedMs >= FFMPEG_WAIT_LOG_THRESHOLD_MS) {
        const stats = getFfmpegLimiterStats();
        console.info(
          `[ffmpeg-limiter] ${operation} waited ${waitedMs}ms for a slot (limit=${limit}, active=${stats.active}, queued=${stats.queued})`
        );
      }
      return task();
    },
    { maxQueue: MAX_FFMPEG_QUEUE }
  );
}

// Test-only: clears process-global limiter state, mirroring a fresh process.
export function resetFfmpegLimiterForTests(): void {
  resetKeyedLimiterForTests();
}
