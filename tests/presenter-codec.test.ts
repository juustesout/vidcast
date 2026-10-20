import { describe, expect, it } from 'vitest';

import {
  PRESENTER_VP9_DECODER,
  presenterDecodeInputArgs,
  presenterNeedsAlphaCapableVp9Decoder,
  presenterVp9DecoderName
} from '@/lib/render/presenter-codec';

describe('presenter codec detection', () => {
  it('forces libvpx-vp9 before a VP9 WebM input even when native pix_fmt looks opaque', () => {
    const probe = {
      path: 'clip.webm',
      codecName: 'vp9',
      pixFmt: 'yuv420p',
      formatName: 'matroska,webm',
      alphaMode: '1'
    };
    expect(presenterNeedsAlphaCapableVp9Decoder(probe)).toBe(true);
    expect(presenterVp9DecoderName(probe)).toBe(PRESENTER_VP9_DECODER);
    expect(presenterDecodeInputArgs('clip.webm', probe)).toEqual(['-c:v', 'libvpx-vp9', '-i', 'clip.webm']);
  });

  it('selects libvpx-vp9 from a .webm path when probe metadata is missing', () => {
    expect(presenterDecodeInputArgs('avatar.webm')).toEqual(['-c:v', 'libvpx-vp9', '-i', 'avatar.webm']);
  });

  it('leaves H.264 MP4 on the default decoder', () => {
    const probe = {
      path: 'clip.mp4',
      codecName: 'h264',
      pixFmt: 'yuv420p',
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2'
    };
    expect(presenterNeedsAlphaCapableVp9Decoder(probe)).toBe(false);
    expect(presenterDecodeInputArgs('clip.mp4', probe)).toEqual(['-i', 'clip.mp4']);
  });
});
