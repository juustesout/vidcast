import { normalizePresenterProviderKey } from '@/lib/presenter/config';
import type { PresenterProvider } from './provider';
import { FakePresenterProvider } from './fake-provider';
import { HeyGenPresenterProvider } from './heygen-provider';

export interface PresenterProviderRegistry {
  getProvider(providerId: string): PresenterProvider;
}

export function createPresenterProviderRegistry(): PresenterProviderRegistry {
  const mock = new FakePresenterProvider();
  const heygen = new HeyGenPresenterProvider();
  const providers = new Map<string, PresenterProvider>([
    [mock.providerId, mock],
    [heygen.providerId, heygen]
  ]);

  return {
    getProvider(providerId: string): PresenterProvider {
      const key = normalizePresenterProviderKey(providerId);
      const provider = key ? providers.get(key) : undefined;
      if (!provider) {
        throw new Error(`Unknown presenter provider: ${providerId}`);
      }
      return provider;
    }
  };
}

export function getPresenterProviderConfigurationStatus(): Array<{ provider: string; configured: boolean; requiredEnvVar?: string }> {
  return [
    { provider: 'mock', configured: true },
    {
      provider: 'heygen',
      configured: Boolean(process.env.HEYGEN_API_KEY?.trim()),
      requiredEnvVar: 'HEYGEN_API_KEY'
    }
  ];
}
