/**
 * Bounded, configurable timeouts for the local FFmpeg render pipeline.
 *
 * Defaults preserve the historical behaviour while letting operators raise the
 * limits for long scenes or large compositions through environment variables.
 * Every value is clamped to a safe range so a misconfiguration cannot disable
 * timeouts entirely or set an absurdly long deadline.
 *
 * Environment variables:
 * - `RENDER_SCENE_TIMEOUT_MS`: max wall-clock time for a single scene render
 * - `RENDER_COMPOSE_TIMEOUT_MS`: max wall-clock time per final composition step
 * - `RENDER_PROBE_TIMEOUT_MS`: max wall-clock time for a single ffprobe call
 */
export const DEFAULT_SCENE_RENDER_TIMEOUT_MS = 60_000;
export const DEFAULT_FINAL_COMPOSE_TIMEOUT_MS = 180_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

export const MIN_RENDER_TIMEOUT_MS = 1_000;
export const MAX_RENDER_TIMEOUT_MS = 30 * 60_000;

function parseBoundedTimeout(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.max(parsed, MIN_RENDER_TIMEOUT_MS), MAX_RENDER_TIMEOUT_MS);
}

export function getSceneRenderTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return parseBoundedTimeout(env.RENDER_SCENE_TIMEOUT_MS, DEFAULT_SCENE_RENDER_TIMEOUT_MS);
}

export function getFinalComposeTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return parseBoundedTimeout(env.RENDER_COMPOSE_TIMEOUT_MS, DEFAULT_FINAL_COMPOSE_TIMEOUT_MS);
}

export function getProbeTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return parseBoundedTimeout(env.RENDER_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS);
}
