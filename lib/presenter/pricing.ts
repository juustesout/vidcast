import {
  resolveHeyGenPresenterEngine,
  resolveHeyGenResolution
} from '@/lib/ai/presenter/heygen-provider';
import type {
  PresenterAvatarType,
  PresenterCostEstimate,
  PresenterEngine,
  PresenterResolution
} from '@/lib/types/presenter';

export const PRESENTER_AVATAR_TYPES: readonly PresenterAvatarType[] = [
  'photo_avatar',
  'studio_avatar',
  'digital_twin',
  'custom_video'
];

export const PRESENTER_RESOLUTIONS: readonly PresenterResolution[] = ['720p', '1080p'];

export type PresenterPricingErrorCode =
  | 'MISSING_PRICING'
  | 'INVALID_PRICING'
  | 'UNKNOWN_RATE'
  | 'UNKNOWN_AVATAR_TYPE'
  | 'MISSING_COST_LIMIT';

export class PresenterPricingError extends Error {
  readonly code: PresenterPricingErrorCode;

  constructor(message: string, code: PresenterPricingErrorCode) {
    super(message);
    this.name = 'PresenterPricingError';
    this.code = code;
  }
}

export interface PresenterRate {
  engine: PresenterEngine;
  avatarType: PresenterAvatarType;
  resolution: PresenterResolution;
  usdPerSecond: number;
}

export interface PresenterPricingConfig {
  currency: 'USD';
  billingIncrementSeconds: number;
  roundUpToCents: boolean;
  rates: PresenterRate[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isEngine(value: unknown): value is PresenterEngine {
  return value === 'avatar_iii' || value === 'avatar_iv' || value === 'avatar_v';
}

function isAvatarType(value: unknown): value is PresenterAvatarType {
  return typeof value === 'string' && (PRESENTER_AVATAR_TYPES as readonly string[]).includes(value);
}

function isResolution(value: unknown): value is PresenterResolution {
  return value === '720p' || value === '1080p';
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function parsePresenterPricingConfig(raw: string | undefined): PresenterPricingConfig {
  const text = raw?.trim();
  if (!text) {
    throw new PresenterPricingError(
      'Paid presenter generation requires HEYGEN_PRICING_JSON.',
      'MISSING_PRICING'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PresenterPricingError('HEYGEN_PRICING_JSON is not valid JSON.', 'INVALID_PRICING');
  }

  const object = asRecord(parsed);
  const rawRates = Array.isArray(parsed) ? parsed : object?.rates;
  if (!Array.isArray(rawRates) || rawRates.length === 0) {
    throw new PresenterPricingError(
      'HEYGEN_PRICING_JSON must contain a non-empty rates array.',
      'INVALID_PRICING'
    );
  }

  const billingIncrementSeconds = object?.billingIncrementSeconds === undefined
    ? 1
    : positiveNumber(object.billingIncrementSeconds);
  if (!billingIncrementSeconds || billingIncrementSeconds > 60) {
    throw new PresenterPricingError(
      'HEYGEN_PRICING_JSON billingIncrementSeconds must be greater than 0 and at most 60.',
      'INVALID_PRICING'
    );
  }

  const roundUpToCents = object?.roundUpToCents === undefined ? true : object.roundUpToCents;
  if (typeof roundUpToCents !== 'boolean') {
    throw new PresenterPricingError(
      'HEYGEN_PRICING_JSON roundUpToCents must be a boolean.',
      'INVALID_PRICING'
    );
  }

  const rates: PresenterRate[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of rawRates.entries()) {
    const rate = asRecord(candidate);
    if (!rate || !isEngine(rate.engine) || !isAvatarType(rate.avatarType) || !isResolution(rate.resolution)) {
      throw new PresenterPricingError(
        `HEYGEN_PRICING_JSON rate ${index} must specify a supported engine, avatarType, and resolution.`,
        'INVALID_PRICING'
      );
    }
    const usdPerSecond = positiveNumber(rate.usdPerSecond);
    if (!usdPerSecond) {
      throw new PresenterPricingError(
        `HEYGEN_PRICING_JSON rate ${index} must have a positive usdPerSecond.`,
        'INVALID_PRICING'
      );
    }

    const key = `${rate.engine}|${rate.avatarType}|${rate.resolution}`;
    if (seen.has(key)) {
      throw new PresenterPricingError(
        `HEYGEN_PRICING_JSON contains a duplicate rate for ${key}.`,
        'INVALID_PRICING'
      );
    }
    seen.add(key);
    rates.push({
      engine: rate.engine,
      avatarType: rate.avatarType,
      resolution: rate.resolution,
      usdPerSecond
    });
  }

  return {
    currency: 'USD',
    billingIncrementSeconds,
    roundUpToCents,
    rates
  };
}

export function resolvePresenterAvatarType(env: Record<string, string | undefined> = process.env): PresenterAvatarType {
  const raw = env.HEYGEN_AVATAR_TYPE?.trim().toLowerCase();
  if (!raw) {
    throw new PresenterPricingError(
      'Paid presenter generation requires HEYGEN_AVATAR_TYPE.',
      'UNKNOWN_AVATAR_TYPE'
    );
  }
  if (!isAvatarType(raw)) {
    throw new PresenterPricingError(
      `Unsupported HEYGEN_AVATAR_TYPE: ${raw}. Use ${PRESENTER_AVATAR_TYPES.join(', ')}.`,
      'UNKNOWN_AVATAR_TYPE'
    );
  }
  return raw;
}

function roundUp(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.ceil(value * factor - 1e-9) / factor;
}

export interface PresenterCostEstimateInput {
  height: number;
  seconds: number;
  maxCostUsd: number | undefined;
  engine?: PresenterEngine;
}

export function resolvePresenterCostEstimate(
  input: PresenterCostEstimateInput,
  env: Record<string, string | undefined> = process.env
): PresenterCostEstimate {
  const maxCostUsd = positiveNumber(input.maxCostUsd);
  if (!maxCostUsd) {
    throw new PresenterPricingError(
      'Paid presenter generation requires presenter.maxCostUsd.',
      'MISSING_COST_LIMIT'
    );
  }
  if (!Number.isFinite(input.seconds) || input.seconds <= 0) {
    throw new PresenterPricingError(
      'Presenter cost estimation requires a positive duration.',
      'INVALID_PRICING'
    );
  }

  let engine: PresenterEngine;
  try {
    engine = input.engine ?? resolveHeyGenPresenterEngine(env);
  } catch (error) {
    throw new PresenterPricingError(
      error instanceof Error ? error.message : 'Invalid presenter engine.',
      'INVALID_PRICING'
    );
  }
  const avatarType = resolvePresenterAvatarType(env);
  const resolution = resolveHeyGenResolution(input.height);
  const config = parsePresenterPricingConfig(env.HEYGEN_PRICING_JSON);
  const rate = config.rates.find((entry) =>
    entry.engine === engine &&
    entry.avatarType === avatarType &&
    entry.resolution === resolution
  );

  if (!rate) {
    throw new PresenterPricingError(
      `No configured presenter price for ${engine}/${avatarType}/${resolution}.`,
      'UNKNOWN_RATE'
    );
  }

  const billableSeconds = Math.ceil((input.seconds / config.billingIncrementSeconds) - 1e-9) * config.billingIncrementSeconds;
  const linearUsd = input.seconds * rate.usdPerSecond;
  const rawEstimate = billableSeconds * rate.usdPerSecond;
  const estimatedUsd = config.roundUpToCents ? roundUp(rawEstimate, 2) : rawEstimate;

  return {
    currency: 'USD',
    engine,
    avatarType,
    resolution,
    seconds: input.seconds,
    billableSeconds,
    usdPerSecond: rate.usdPerSecond,
    linearUsd,
    estimatedUsd,
    maxCostUsd
  };
}

export function evaluatePresenterCostLimit(estimate: PresenterCostEstimate): {
  allowed: boolean;
  reason?: string;
} {
  if (estimate.estimatedUsd > estimate.maxCostUsd + 1e-9) {
    return {
      allowed: false,
      reason: `Presenter generation would cost up to $${estimate.estimatedUsd.toFixed(2)} of a $${estimate.maxCostUsd.toFixed(2)} limit.`
    };
  }
  return { allowed: true };
}
