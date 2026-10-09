import { FakeImageGenerationProvider } from './fake-provider';
import { OpenAiImageGenerationProvider } from './openai-provider';
import { ImageGenerationProviderError, type ImageGenerationProvider } from './provider';

export type ImageProviderId = 'openai' | 'fake';

export interface ImageGenerationRegistry {
  getProvider(id: string): ImageGenerationProvider;
}

class DefaultImageGenerationRegistry implements ImageGenerationRegistry {
  getProvider(id: string): ImageGenerationProvider {
    if (id === 'openai') {
      return new OpenAiImageGenerationProvider();
    }

    if (id === 'fake') {
      return new FakeImageGenerationProvider();
    }

    throw new ImageGenerationProviderError(`Unknown image generation provider: ${id}`, 400, 'provider.unknown');
  }
}

export function createImageGenerationRegistry(): ImageGenerationRegistry {
  return new DefaultImageGenerationRegistry();
}

export function getImageGenerationConfigurationStatus(): { openaiConfigured: boolean; defaultProvider: string } {
  return {
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    defaultProvider: 'openai'
  };
}
