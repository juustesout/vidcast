import { afterEach, describe, expect, it } from 'vitest';

import {
  claimExpiresAtFromNow,
  claimTokenMatches,
  generateClaimToken,
  hashClaimToken,
  isClaimExpired
} from '@/lib/security/claim-token';

const ORIGINAL_TTL = process.env.EXPLAINER_CLAIM_TOKEN_TTL_MS;

afterEach(() => {
  if (ORIGINAL_TTL === undefined) {
    delete process.env.EXPLAINER_CLAIM_TOKEN_TTL_MS;
  } else {
    process.env.EXPLAINER_CLAIM_TOKEN_TTL_MS = ORIGINAL_TTL;
  }
});

describe('claim token primitives', () => {
  it('generates high-entropy, unique, URL-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateClaimToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token.length).toBeGreaterThanOrEqual(40);
    }
  });

  it('hashes deterministically and never leaks the raw token', () => {
    const token = generateClaimToken();
    const hash = hashClaimToken(token);
    expect(hash).toBe(hashClaimToken(token));
    expect(hash).not.toContain(token);
  });

  it('matches only the exact token hash', () => {
    const token = generateClaimToken();
    const stored = hashClaimToken(token);
    expect(claimTokenMatches(hashClaimToken(token), stored)).toBe(true);
    expect(claimTokenMatches(hashClaimToken(generateClaimToken()), stored)).toBe(false);
    expect(claimTokenMatches(hashClaimToken(`${token}x`), stored)).toBe(false);
  });

  it('treats a malformed or past expiry as expired', () => {
    expect(isClaimExpired(undefined)).toBe(false);
    expect(isClaimExpired('not-a-date')).toBe(true);
    expect(isClaimExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
    expect(isClaimExpired(new Date(Date.now() + 60_000).toISOString())).toBe(false);
  });

  it('honours the configured TTL', () => {
    process.env.EXPLAINER_CLAIM_TOKEN_TTL_MS = '1000';
    const before = Date.now();
    const expiresAt = Date.parse(claimExpiresAtFromNow());
    expect(expiresAt).toBeGreaterThanOrEqual(before + 900);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 1100);
  });

  it('falls back to the default TTL for invalid configuration', () => {
    process.env.EXPLAINER_CLAIM_TOKEN_TTL_MS = 'not-a-number';
    const expiresAt = Date.parse(claimExpiresAtFromNow());
    expect(expiresAt).toBeGreaterThan(Date.now() + 24 * 60 * 60 * 1000);
  });
});
