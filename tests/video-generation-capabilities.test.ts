import { describe, expect, it } from 'vitest';

import {
  classifyVideoGenerationMode,
  resolveVideoGenerationCapabilityContract
} from '@/lib/ai/video-generation/capabilities';
import { FalVideoGenerationProvider } from '@/lib/ai/video-generation/fal-provider';
import { FakeVideoGenerationProvider } from '@/lib/ai/video-generation/fake-provider';
import type {
  VideoGenerationCapabilities,
  VideoGenerationProvider,
  VideoReferenceInput
} from '@/lib/ai/video-generation/provider';

function frame(role: 'start_frame' | 'end_frame'): VideoReferenceInput {
  return { id: role, mimeType: 'image/png', data: Buffer.from('frame'), role };
}

function plainReference(): VideoReferenceInput {
  return { id: 'style', mimeType: 'image/png', data: Buffer.from('style'), role: 'reference' };
}

function stubProvider(capabilities: VideoGenerationCapabilities): VideoGenerationProvider {
  return {
    providerId: 'stub',
    getCapabilities: () => capabilities,
    submit: async () => ({ providerJobId: 'job', status: 'queued' }),
    getStatus: async () => ({ status: 'queued' }),
    download: async () => ({ mimeType: 'video/mp4', data: Buffer.from('') })
  };
}

const BASE_CAPABILITIES: VideoGenerationCapabilities = {
  supportsTextToVideo: true,
  supportsImageToVideo: true,
  supportsReferences: true,
  maxReferences: 8,
  supportedAspectRatios: ['16:9', '1:1', '9:16'],
  supportsCancellation: true
};

describe('video generation capability contract', () => {
  it('classifies text, keyframe and plain-reference requests', () => {
    expect(classifyVideoGenerationMode(undefined)).toBe('text_to_video');
    expect(classifyVideoGenerationMode([])).toBe('text_to_video');
    expect(classifyVideoGenerationMode([plainReference()])).toBe('reference_guided');
    expect(classifyVideoGenerationMode([frame('start_frame')])).toBe('image_to_video');
    expect(classifyVideoGenerationMode([plainReference(), frame('end_frame')])).toBe('image_to_video');
  });

  it('accepts every mode the provider advertises', () => {
    const provider = new FakeVideoGenerationProvider();

    expect(resolveVideoGenerationCapabilityContract(provider, {}).mode).toBe('text_to_video');
    expect(resolveVideoGenerationCapabilityContract(provider, { references: [plainReference()] }).mode).toBe(
      'reference_guided'
    );
    expect(resolveVideoGenerationCapabilityContract(provider, { references: [frame('start_frame')] }).mode).toBe(
      'image_to_video'
    );
  });

  it('rejects a mode the provider does not advertise before any submit', () => {
    const textOnly = stubProvider({ ...BASE_CAPABILITIES, supportsImageToVideo: false });
    expect(() =>
      resolveVideoGenerationCapabilityContract(textOnly, { references: [frame('start_frame')] })
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED', status: 422 }));

    const imageOnly = stubProvider({ ...BASE_CAPABILITIES, supportsTextToVideo: false });
    expect(() => resolveVideoGenerationCapabilityContract(imageOnly, {})).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED' })
    );

    const noReferences = stubProvider({ ...BASE_CAPABILITIES, supportsReferences: false, supportsImageToVideo: false });
    expect(() =>
      resolveVideoGenerationCapabilityContract(noReferences, { references: [plainReference()] })
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED' }));
  });

  it('enforces reference count, keyframe-only providers and declared aspect/duration enums', () => {
    const oneReference = stubProvider({ ...BASE_CAPABILITIES, maxReferences: 1 });
    expect(() =>
      resolveVideoGenerationCapabilityContract(oneReference, {
        references: [plainReference(), plainReference()]
      })
    ).toThrowError(expect.objectContaining({ code: 'REFERENCE_ERROR' }));

    const frameOnly = stubProvider({ ...BASE_CAPABILITIES, supportsReferences: false });
    expect(() =>
      resolveVideoGenerationCapabilityContract(frameOnly, {
        references: [frame('start_frame'), plainReference()]
      })
    ).toThrowError(expect.objectContaining({ code: 'REFERENCE_ERROR' }));

    const limited = stubProvider({
      ...BASE_CAPABILITIES,
      supportedAspectRatios: ['16:9'],
      supportedDurationsSeconds: [5]
    });
    expect(() =>
      resolveVideoGenerationCapabilityContract(limited, { aspectRatio: '9:16' })
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED' }));
    expect(() =>
      resolveVideoGenerationCapabilityContract(limited, { durationSeconds: 7 })
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED' }));
    expect(() =>
      resolveVideoGenerationCapabilityContract(limited, { durationSeconds: 0 })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('uses model-aware FAL capabilities so text/image endpoints expose different modes', () => {
    const text = new FalVideoGenerationProvider({
      apiKey: 'test-key',
      endpoint: 'minimax/h3-max-turbo/text-to-video'
    });
    expect(
      resolveVideoGenerationCapabilityContract(text, {
        model: 'minimax/h3-max-turbo/text-to-video'
      }).mode
    ).toBe('text_to_video');
    expect(() =>
      resolveVideoGenerationCapabilityContract(text, {
        model: 'minimax/h3-max-turbo/text-to-video',
        references: [frame('start_frame')]
      })
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED' }));

    const image = new FalVideoGenerationProvider({
      apiKey: 'test-key',
      endpoint: 'minimax/h3-max-turbo/image-to-video'
    });
    expect(() =>
      resolveVideoGenerationCapabilityContract(image, {
        model: 'minimax/h3-max-turbo/image-to-video'
      })
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED' }));
    expect(
      resolveVideoGenerationCapabilityContract(image, {
        model: 'minimax/h3-max-turbo/image-to-video',
        references: [frame('start_frame')]
      }).mode
    ).toBe('image_to_video');
  });

  it('rejects malformed or mode-incompatible FAL model ids before a request', () => {
    const provider = new FalVideoGenerationProvider({
      apiKey: 'test-key',
      endpoint: 'minimax/h3-max-turbo/text-to-video'
    });

    expect(() =>
      resolveVideoGenerationCapabilityContract(provider, { model: 'https://evil.example/video' })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));

    expect(() =>
      resolveVideoGenerationCapabilityContract(provider, {
        model: 'minimax/h3-max-turbo/image-to-video',
        references: [plainReference()]
      })
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED' }));
  });
});
