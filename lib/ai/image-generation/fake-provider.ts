import { createHash } from 'node:crypto';
import sharp from 'sharp';

import type { ImageGenerationProvider, ImageGenerationRequest, ImageGenerationResult } from './provider';

export class FakeImageGenerationProvider implements ImageGenerationProvider {
  readonly providerId = 'fake';

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const hash = createHash('sha1').update(request.prompt).digest('hex').slice(0, 10);
    const width = 1280;
    const height = 720;
    const red = Number.parseInt(hash.slice(0, 2), 16);
    const green = Number.parseInt(hash.slice(2, 4), 16);
    const blue = Number.parseInt(hash.slice(4, 6), 16);

    // Generate deterministic valid PNG bytes that FFmpeg can decode reliably.
    const bytes = await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: red, g: green, b: blue }
      }
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    return {
      provider: this.providerId,
      model: request.model || 'fake-model',
      mimeType: 'image/png',
      data: bytes,
      width,
      height,
      providerRequestId: `fake-${hash}`,
      metadata: {
        deterministicHash: hash,
        referenceCount: request.referenceImages?.length ?? 0
      }
    };
  }
}
