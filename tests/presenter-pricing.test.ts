import { describe, expect, it } from 'vitest';

import {
  evaluatePresenterCostLimit,
  evaluatePresenterPaidCostPrecondition,
  parsePresenterPricingConfig,
  PresenterPricingError,
  resolvePresenterCostEstimate
} from '@/lib/presenter/pricing';

const pricing = JSON.stringify({
  billingIncrementSeconds: 1,
  rates: [
    { engine: 'avatar_iii', avatarType: 'photo_avatar', resolution: '1080p', usdPerSecond: 0.0165 }
  ]
});

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    HEYGEN_AVATAR_TYPE: 'photo_avatar',
    HEYGEN_PRESENTER_ENGINE: 'avatar_iii',
    HEYGEN_PRICING_JSON: pricing,
    ...overrides
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('expected pricing failure');
  } catch (error) {
    expect(error).toBeInstanceOf(PresenterPricingError);
    expect((error as PresenterPricingError).code).toBe(code);
  }
}

describe('presenter pricing', () => {
  it('rounds billable time up to the configured increment and cents', () => {
    const estimate = resolvePresenterCostEstimate({
      height: 1080,
      seconds: 3.578776,
      maxCostUsd: 0.5
    }, env());

    expect(estimate).toMatchObject({
      engine: 'avatar_iii',
      avatarType: 'photo_avatar',
      resolution: '1080p',
      seconds: 3.578776,
      billableSeconds: 4,
      usdPerSecond: 0.0165,
      estimatedUsd: 0.07,
      maxCostUsd: 0.5
    });
    expect(estimate.linearUsd).toBeCloseTo(0.0590498, 7);
    expect(evaluatePresenterCostLimit(estimate)).toEqual({ allowed: true });
  });

  it('rejects a missing pricing configuration', () => {
    expectCode(() => parsePresenterPricingConfig(undefined), 'MISSING_PRICING');
    expectCode(() => resolvePresenterCostEstimate({ height: 1080, seconds: 2, maxCostUsd: 1 }, env({
      HEYGEN_PRICING_JSON: ''
    })), 'MISSING_PRICING');
  });

  it('rejects malformed, duplicate, and unknown-resolution rates', () => {
    expectCode(() => parsePresenterPricingConfig('{'), 'INVALID_PRICING');
    expectCode(() => parsePresenterPricingConfig(JSON.stringify({
      rates: [
        { engine: 'avatar_iii', avatarType: 'photo_avatar', resolution: '1080p', usdPerSecond: 0.01 },
        { engine: 'avatar_iii', avatarType: 'photo_avatar', resolution: '1080p', usdPerSecond: 0.02 }
      ]
    })), 'INVALID_PRICING');
    expectCode(() => resolvePresenterCostEstimate({ height: 1080, seconds: 2, maxCostUsd: 1 }, env({
      HEYGEN_PRICING_JSON: JSON.stringify({
        rates: [
          { engine: 'avatar_iii', avatarType: 'photo_avatar', resolution: '720p', usdPerSecond: 0.01 }
        ]
      })
    })), 'UNKNOWN_RATE');
  });

  it('rejects an unknown avatar type and a missing cost limit', () => {
    expectCode(() => resolvePresenterCostEstimate({ height: 1080, seconds: 2, maxCostUsd: 1 }, env({
      HEYGEN_AVATAR_TYPE: 'not-a-real-type'
    })), 'UNKNOWN_AVATAR_TYPE');
    expectCode(
      () => resolvePresenterCostEstimate({ height: 1080, seconds: 2, maxCostUsd: undefined }, env()),
      'MISSING_COST_LIMIT'
    );
  });

  it('reports a USD overrun', () => {
    const estimate = resolvePresenterCostEstimate({ height: 1080, seconds: 3.6, maxCostUsd: 0.05 }, env());
    expect(estimate.estimatedUsd).toBe(0.07);
    expect(evaluatePresenterCostLimit(estimate)).toMatchObject({ allowed: false });
  });

  it('exposes the pricing error type', () => {
    try {
      parsePresenterPricingConfig('');
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(PresenterPricingError);
    }
  });

  it('fail-closes paid generation for missing, invalid, negative, and insufficient USD limits', () => {
    const missing = evaluatePresenterPaidCostPrecondition({ height: 1080, seconds: 2, maxCostUsd: undefined }, env());
    expect(missing).toMatchObject({ allowed: false, code: 'MISSING_COST_LIMIT' });

    const negative = evaluatePresenterPaidCostPrecondition({ height: 1080, seconds: 2, maxCostUsd: -1 }, env());
    expect(negative).toMatchObject({ allowed: false, code: 'MISSING_COST_LIMIT' });

    const zero = evaluatePresenterPaidCostPrecondition({ height: 1080, seconds: 2, maxCostUsd: 0 }, env());
    expect(zero).toMatchObject({ allowed: false, code: 'MISSING_COST_LIMIT' });

    const missingPricing = evaluatePresenterPaidCostPrecondition(
      { height: 1080, seconds: 2, maxCostUsd: 1 },
      env({ HEYGEN_PRICING_JSON: undefined })
    );
    expect(missingPricing).toMatchObject({ allowed: false, code: 'MISSING_PRICING' });

    const invalidPricing = evaluatePresenterPaidCostPrecondition(
      { height: 1080, seconds: 2, maxCostUsd: 1 },
      env({ HEYGEN_PRICING_JSON: '{' })
    );
    expect(invalidPricing).toMatchObject({ allowed: false, code: 'INVALID_PRICING' });

    const overrun = evaluatePresenterPaidCostPrecondition({ height: 1080, seconds: 3.6, maxCostUsd: 0.05 }, env());
    expect(overrun).toMatchObject({ allowed: false, code: 'BUDGET_EXCEEDED' });

    const allowed = evaluatePresenterPaidCostPrecondition({ height: 1080, seconds: 2, maxCostUsd: 1 }, env());
    expect(allowed.allowed).toBe(true);
  });
});
