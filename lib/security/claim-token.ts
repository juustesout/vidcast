import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A claim token is a single-use capability that lets exactly one browser user
 * take ownership of a project a service created. Only its hash is ever stored
 * (see `lib/storage/claim-store.ts`); the raw token is returned once to the
 * service caller that created the project and is never persisted, logged or
 * exposed through project reads.
 */
const CLAIM_TOKEN_BYTES = 32;

const DEFAULT_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateClaimToken(): string {
  return randomBytes(CLAIM_TOKEN_BYTES).toString('base64url');
}

export function hashClaimToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/**
 * Constant-time comparison of a freshly computed token hash against the stored
 * hash. Both values are fixed-length SHA-256 digests, so there is no length
 * branch to leak.
 */
export function claimTokenMatches(tokenHash: string, storedHash: string): boolean {
  const provided = Buffer.from(tokenHash, 'utf8');
  const expected = Buffer.from(storedHash, 'utf8');
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}

export function getClaimTokenTtlMs(): number {
  const parsed = Number.parseInt(process.env.EXPLAINER_CLAIM_TOKEN_TTL_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLAIM_TTL_MS;
}

export function claimExpiresAtFromNow(nowMs = Date.now()): string {
  return new Date(nowMs + getClaimTokenTtlMs()).toISOString();
}

export function isClaimExpired(expiresAt: string | undefined, nowMs = Date.now()): boolean {
  if (!expiresAt) {
    return false;
  }
  const parsed = Date.parse(expiresAt);
  // A malformed expiry is treated as expired (fail-closed).
  return Number.isFinite(parsed) ? parsed <= nowMs : true;
}
