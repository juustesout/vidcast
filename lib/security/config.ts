export type SecurityMode = 'local' | 'production';

export class SecurityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityConfigurationError';
  }
}

const LOCAL_DEV_SESSION_SECRET = 'explainer-local-dev-session-secret';
const MIN_SECRET_LENGTH = 32;

export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Resolves the effective security mode.
 *
 * - `production` is always selected when `NODE_ENV === 'production'`, even if
 *   `EXPLAINER_SECURITY_MODE=local` is set, so production safety cannot be
 *   weakened through configuration.
 * - Outside production an explicit `EXPLAINER_SECURITY_MODE` is honored,
 *   otherwise the mode defaults to `local`.
 */
export function getSecurityMode(): SecurityMode {
  if (isProductionEnvironment()) {
    return 'production';
  }

  const explicit = process.env.EXPLAINER_SECURITY_MODE?.trim().toLowerCase();
  if (explicit === 'production' || explicit === 'local') {
    return explicit;
  }

  return 'local';
}

/**
 * Anonymous, self-minted browser sessions are only available in an explicitly
 * local (non-production) mode. Production requires a real identity provider.
 */
export function isAnonymousSessionAllowed(): boolean {
  return !isProductionEnvironment() && getSecurityMode() === 'local';
}

export function getSessionSecret(): string {
  const configured = process.env.EXPLAINER_SESSION_SECRET?.trim();
  const production = isProductionEnvironment();

  if (configured) {
    if (production && (configured === LOCAL_DEV_SESSION_SECRET || configured.length < MIN_SECRET_LENGTH)) {
      throw new SecurityConfigurationError(
        'EXPLAINER_SESSION_SECRET must be a strong random value of at least 32 characters and must not be the development default in production.'
      );
    }
    return configured;
  }

  if (!production) {
    return LOCAL_DEV_SESSION_SECRET;
  }

  throw new SecurityConfigurationError(
    'EXPLAINER_SESSION_SECRET is required in production. Generate a strong random value of at least 32 characters.'
  );
}

export function getServiceToken(): string | null {
  return process.env.EXPLAINER_API_TOKEN?.trim() || null;
}

/**
 * Fail-fast validation intended to run at server startup. In production both a
 * strong session secret and a strong service token are mandatory.
 */
export function assertSecurityConfiguration(): void {
  if (!isProductionEnvironment()) {
    return;
  }

  getSessionSecret();

  const serviceToken = getServiceToken();
  if (!serviceToken || serviceToken.length < MIN_SECRET_LENGTH) {
    throw new SecurityConfigurationError(
      'EXPLAINER_API_TOKEN must be set to a strong value of at least 32 characters in production.'
    );
  }
}
