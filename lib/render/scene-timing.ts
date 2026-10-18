import { MAX_SCENE_DURATION_SECONDS, MIN_SCENE_DURATION_SECONDS } from '@/lib/constants';
import type { Asset } from '@/lib/types/asset';
import type { RenderSceneTiming } from '@/lib/types/render';
import type { NarrationSpec } from '@/lib/types/scene';

// A natural pause after the last spoken word. It is only applied when the
// scene has to grow to fit narration; scenes whose authored duration already
// fits are left untouched. Speech is never cut to fit a scene.
export const DEFAULT_NARRATION_END_PADDING_SECONDS = 0.25;

const EPSILON = 1e-9;

// A render must match the resolved timeline closely enough that no narration
// can be cut. One frame plus a small container-metadata allowance is enough.
export const SCENE_DURATION_MATCH_TOLERANCE_SECONDS = 0.15;

export interface SceneTimingInput {
  // The authored scene duration. It remains the creative minimum: automatic
  // fitting only ever extends a scene.
  duration: number;
  // Measured duration of the linked narration audio, when available.
  narrationDuration?: number;
}

export interface SceneTimingOptions {
  endPaddingSeconds?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function resolveOption(value: number | undefined, fallback: number, isValid: (candidate: number) => boolean): number {
  return typeof value === 'number' && Number.isFinite(value) && isValid(value) ? value : fallback;
}

// Returns the largest persisted narration duration from the narration record
// and the linked audio asset. Using one conservative value keeps planning,
// validation and composition on the same timeline even when the two records
// disagree, and prevents cutting speech when either record is stale. Inputs are
// persistent data only, so re-running planning is deterministic.
export function resolveMeasuredNarrationDuration(narration: NarrationSpec | undefined, assets: Asset[]): number | undefined {
  if (!narration?.audioAssetId) {
    return undefined;
  }

  const recordDuration = isPositiveFinite(narration.duration) ? narration.duration : undefined;
  const asset = assets.find((entry) => entry.id === narration.audioAssetId);
  let assetDuration: number | undefined;
  if (
    asset &&
    (asset.type === 'audio' || asset.type === 'music' || asset.type === 'voice') &&
    isPositiveFinite(asset.duration)
  ) {
    assetDuration = asset.duration;
  }

  if (recordDuration === undefined && assetDuration === undefined) {
    return undefined;
  }
  return Math.max(recordDuration ?? 0, assetDuration ?? 0);
}

export function resolveSceneTiming(input: SceneTimingInput, options: SceneTimingOptions = {}): RenderSceneTiming {
  const maxDurationSeconds = resolveOption(
    options.maxDurationSeconds,
    MAX_SCENE_DURATION_SECONDS,
    (candidate) => candidate > 0
  );
  const minDurationSeconds = resolveOption(
    options.minDurationSeconds,
    MIN_SCENE_DURATION_SECONDS,
    (candidate) => candidate > 0 && candidate <= maxDurationSeconds
  );
  const endPaddingSeconds = resolveOption(
    options.endPaddingSeconds,
    DEFAULT_NARRATION_END_PADDING_SECONDS,
    (candidate) => candidate >= 0
  );

  const authoredDuration = isPositiveFinite(input.duration) ? input.duration : minDurationSeconds;
  const narrationDuration = isPositiveFinite(input.narrationDuration) ? input.narrationDuration : undefined;
  // Keep the authored duration whenever narration fits. Padding is only added
  // to scenes that must grow, so a fixed margin can never extend a scene whose
  // narration already fits or push a legal 600 s narration over the limit.
  const narrationRequiredDuration =
    narrationDuration !== undefined && narrationDuration > authoredDuration
      ? narrationDuration + endPaddingSeconds
      : 0;
  const effectiveDuration = Math.max(authoredDuration, narrationRequiredDuration, minDurationSeconds);

  return {
    authoredDuration,
    narrationDuration,
    endPaddingSeconds,
    effectiveDuration,
    adjusted: effectiveDuration > authoredDuration + EPSILON,
    exceedsMax: effectiveDuration > maxDurationSeconds + EPSILON
  };
}

export function sceneDurationMatches(actual: number, expected: number, fps: number): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
    return false;
  }
  const tolerance = Math.max(SCENE_DURATION_MATCH_TOLERANCE_SECONDS, 2 / Math.max(1, fps));
  return Math.abs(actual - expected) <= tolerance;
}

export function formatSceneTiming(timing: RenderSceneTiming): string {
  if (timing.narrationDuration === undefined) {
    return `authored ${timing.authoredDuration.toFixed(2)}s`;
  }
  if (timing.effectiveDuration <= timing.authoredDuration + EPSILON) {
    return `narration ${timing.narrationDuration.toFixed(2)}s fits authored ${timing.authoredDuration.toFixed(2)}s`;
  }
  return [
    `narration ${timing.narrationDuration.toFixed(2)}s`,
    `+ ${timing.endPaddingSeconds.toFixed(2)}s end padding`,
    `-> ${timing.effectiveDuration.toFixed(2)}s`
  ].join(' ');
}
