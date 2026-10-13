import { describe, expect, it } from 'vitest';

import {
  buildVideoScaleFilter,
  classifyFit,
  DEFAULT_RENDER_FIT,
  describeFitWarning,
  isRenderFit,
  resolveRenderFit
} from '@/lib/render/fit-policy';

const CANVAS_16_9 = { canvasWidth: 1280, canvasHeight: 720 };
const CANVAS_9_16 = { canvasWidth: 720, canvasHeight: 1280 };
const CANVAS_1_1 = { canvasWidth: 1080, canvasHeight: 1080 };

describe('buildVideoScaleFilter', () => {
  it('keeps the historical cover filter byte-for-byte for backward compatibility', () => {
    expect(buildVideoScaleFilter(1280, 720, 'cover')).toBe(
      'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720'
    );
    // Omitting the fit must default to cover.
    expect(buildVideoScaleFilter(1280, 720)).toBe(buildVideoScaleFilter(1280, 720, 'cover'));
  });

  it('builds a letterboxing contain filter that preserves the whole source', () => {
    expect(buildVideoScaleFilter(1280, 720, 'contain')).toBe(
      'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black'
    );
  });
});

describe('classifyFit', () => {
  it('detects a 3:2 source cropped to a 16:9 canvas as information loss under cover', () => {
    const classification = classifyFit({ sourceWidth: 1536, sourceHeight: 1024, ...CANVAS_16_9, fit: 'cover' });

    expect(classification.aspectMismatch).toBe(true);
    expect(classification.cropsInformation).toBe(true);
    expect(classification.padsCanvas).toBe(false);
    // 3:2 (1.5) is narrower than 16:9 (1.777...), so the retained fraction is
    // sourceAspect / canvasAspect = 1.5 / (16/9) = 0.84375.
    expect(classification.retainedAreaFraction).toBeCloseTo(1.5 / (16 / 9), 10);
  });

  it('does not report loss when source and canvas share an aspect ratio', () => {
    const classification = classifyFit({ sourceWidth: 1920, sourceHeight: 1080, ...CANVAS_16_9, fit: 'cover' });

    expect(classification.aspectMismatch).toBe(false);
    expect(classification.cropsInformation).toBe(false);
    expect(classification.padsCanvas).toBe(false);
    expect(classification.retainedAreaFraction).toBe(1);
  });

  it('classifies contain as padding rather than cropping for a mismatched source', () => {
    const classification = classifyFit({ sourceWidth: 1536, sourceHeight: 1024, ...CANVAS_16_9, fit: 'contain' });

    expect(classification.aspectMismatch).toBe(true);
    expect(classification.cropsInformation).toBe(false);
    expect(classification.padsCanvas).toBe(true);
  });

  it('handles wider-than-canvas, taller-than-canvas and square sources exactly', () => {
    // 21:9 ultra-wide onto 16:9 -> taller canvas ratio, source is wider -> crop sides.
    expect(classifyFit({ sourceWidth: 2560, sourceHeight: 1080, ...CANVAS_16_9, fit: 'cover' }).cropsInformation).toBe(true);
    // 9:16 portrait onto 16:9 -> crop top/bottom.
    expect(classifyFit({ sourceWidth: 1080, sourceHeight: 1920, ...CANVAS_16_9, fit: 'cover' }).cropsInformation).toBe(true);
    // Square onto 1:1 -> no loss.
    expect(classifyFit({ sourceWidth: 1000, sourceHeight: 1000, ...CANVAS_1_1, fit: 'cover' }).cropsInformation).toBe(false);
    // Square onto 9:16 -> crop.
    expect(classifyFit({ sourceWidth: 1000, sourceHeight: 1000, ...CANVAS_9_16, fit: 'cover' }).cropsInformation).toBe(true);
  });
});

describe('describeFitWarning', () => {
  it('returns a crop warning for a 3:2 source on a 16:9 canvas', () => {
    const warning = describeFitWarning({
      sourceWidth: 1536,
      sourceHeight: 1024,
      ...CANVAS_16_9,
      fit: 'cover',
      aspectRatio: '16:9'
    });

    expect(warning).toBeDefined();
    expect(warning).toContain('center-cropped');
    expect(warning).toContain('1536x1024');
    expect(warning).toContain('1280x720');
  });

  it('returns no warning when nothing is cropped', () => {
    expect(
      describeFitWarning({ sourceWidth: 1920, sourceHeight: 1080, ...CANVAS_16_9, fit: 'cover' })
    ).toBeUndefined();
    expect(
      describeFitWarning({ sourceWidth: 1536, sourceHeight: 1024, ...CANVAS_16_9, fit: 'contain' })
    ).toBeUndefined();
  });
});

describe('fit validation helpers', () => {
  it('recognizes only cover/contain and defaults safely', () => {
    expect(DEFAULT_RENDER_FIT).toBe('cover');
    expect(isRenderFit('cover')).toBe(true);
    expect(isRenderFit('contain')).toBe(true);
    expect(isRenderFit('stretch')).toBe(false);
    expect(resolveRenderFit('contain')).toBe('contain');
    expect(resolveRenderFit('bogus')).toBe('cover');
    expect(resolveRenderFit(undefined)).toBe('cover');
  });
});
