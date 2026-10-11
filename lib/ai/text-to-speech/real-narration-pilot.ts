/**
 * Narrow, fail-closed opt-in for running a single real ElevenLabs narration
 * through the manual scene narration generation path.
 *
 * This is intentionally separate from `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS`:
 * enabling the global real-provider mode would also unlock the unverified
 * OpenAI video adapter as well as the real image and music paths. The pilot only
 * widens real mode for the `narration` modality and additionally requires an
 * explicit confirmation value, so it can never switch on by accident.
 *
 * Gates (all required, default off):
 * - `RUN_REAL_NARRATION_PILOT` must be a truthy value (`1`/`true`/`yes`/`on`).
 * - `CONFIRM_REAL_NARRATION_PILOT` must equal exactly `YES`.
 * - `ELEVENLABS_API_KEY` must be present (existence only; the value is never read).
 */
export interface RealNarrationPilotGate {
  enabled: boolean;
  confirmed: boolean;
  hasApiKey: boolean;
  allowed: boolean;
  reason?: string;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function envFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  return false;
}

export function resolveRealNarrationPilotGate(env: Record<string, string | undefined> = process.env): RealNarrationPilotGate {
  const enabled = envFlag(env.RUN_REAL_NARRATION_PILOT);
  const confirmed = env.CONFIRM_REAL_NARRATION_PILOT === 'YES';
  const hasApiKey = Boolean(env.ELEVENLABS_API_KEY);

  let reason: string | undefined;
  if (!enabled) {
    reason = 'RUN_REAL_NARRATION_PILOT is not enabled.';
  } else if (!confirmed) {
    reason = 'CONFIRM_REAL_NARRATION_PILOT must equal YES.';
  } else if (!hasApiKey) {
    reason = 'ELEVENLABS_API_KEY is not set.';
  }

  return {
    enabled,
    confirmed,
    hasApiKey,
    allowed: enabled && confirmed && hasApiKey,
    reason
  };
}
