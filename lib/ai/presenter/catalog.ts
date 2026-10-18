import type { PresenterProviderKey } from '@/lib/types/presenter';

export const REAL_PRESENTER_PROVIDER_KEYS: PresenterProviderKey[] = ['heygen'];

export function isRealPresenterProviderKey(value: unknown): value is 'heygen' {
  return value === 'heygen';
}

export function presenterProviderCredentialEnvVar(provider: string | undefined): string | undefined {
  return provider === 'heygen' ? 'HEYGEN_API_KEY' : undefined;
}
