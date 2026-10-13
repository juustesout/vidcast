import type { AspectRatio, RenderFit } from '@/lib/types/render';

// Explicit scale policy for mapping a source image/clip onto the project canvas.
//
//  - `cover`   : scale up to fill the canvas, then center-crop the overflow
//                (image information outside the canvas is discarded);
//  - `contain` : scale down to fit inside the canvas, then letterbox/pad the
//                remainder (the full source frame is preserved).
//
// `cover` is the historical default and is kept for backward compatibility: the
// generated FFmpeg filter is byte-for-byte the previous
// `scale=W:H:force_original_aspect_ratio=increase,crop=W:H`.
export const DEFAULT_RENDER_FIT: RenderFit = 'cover';

export const RENDER_FITS: RenderFit[] = ['cover', 'contain'];

export function isRenderFit(value: unknown): value is RenderFit {
  return value === 'cover' || value === 'contain';
}

export function resolveRenderFit(value: unknown, fallback: RenderFit = DEFAULT_RENDER_FIT): RenderFit {
  return isRenderFit(value) ? value : fallback;
}

// Builds the shared scale(+crop|pad) filter chain used by both the single-scene
// renderer and the final compositor so the policy is applied consistently.
export function buildVideoScaleFilter(width: number, height: number, fit: RenderFit = DEFAULT_RENDER_FIT): string {
  if (fit === 'contain') {
    // `decrease` guarantees the whole source fits; `pad` centers it on a black
    // canvas so no source pixels are lost.
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
  }

  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
}

export interface FitClassification {
  fit: RenderFit;
  // The source and canvas aspect ratios as width/height ratios (>0).
  sourceAspect: number;
  canvasAspect: number;
  // True when the source is not the exact canvas aspect ratio.
  aspectMismatch: boolean;
  // True when cover discards source pixels (aspect mismatch under `cover`).
  cropsInformation: boolean;
  // True when contain adds letterbox/pillarbox padding (aspect mismatch under `contain`).
  padsCanvas: boolean;
  // Fraction (0..1] of the source frame area that remains visible after the fit.
  retainedAreaFraction: number;
}

// Pure geometry classification. Uses cross-multiplication so integer pixel sizes
// never suffer float rounding (for example 3:2 -> 16:9 is detected exactly).
export function classifyFit(input: {
  sourceWidth: number;
  sourceHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  fit?: RenderFit;
}): FitClassification {
  const fit = input.fit ?? DEFAULT_RENDER_FIT;
  const { sourceWidth, sourceHeight, canvasWidth, canvasHeight } = input;

  const sourceAspect = sourceWidth / sourceHeight;
  const canvasAspect = canvasWidth / canvasHeight;

  // sourceWidth/sourceHeight > canvasWidth/canvasHeight
  const sourceIsWider = sourceWidth * canvasHeight > canvasWidth * sourceHeight;
  const sourceIsTaller = sourceWidth * canvasHeight < canvasWidth * sourceHeight;
  const aspectMismatch = sourceIsWider || sourceIsTaller;

  const retainedAreaFraction = !aspectMismatch
    ? 1
    : sourceIsWider
      ? canvasAspect / sourceAspect
      : sourceAspect / canvasAspect;

  return {
    fit,
    sourceAspect,
    canvasAspect,
    aspectMismatch,
    cropsInformation: fit === 'cover' && aspectMismatch,
    padsCanvas: fit === 'contain' && aspectMismatch,
    retainedAreaFraction
  };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

// Returns a human-readable warning when the chosen fit discards source image
// information, or `undefined` when nothing is lost. Intended for the existing
// validation/production reporting surfaces (RenderPlan issues).
export function describeFitWarning(input: {
  sourceWidth: number;
  sourceHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  fit?: RenderFit;
  aspectRatio?: AspectRatio;
}): string | undefined {
  const classification = classifyFit(input);
  if (!classification.cropsInformation) {
    return undefined;
  }

  const label = input.aspectRatio ? `${input.aspectRatio} ` : '';
  return (
    `Source ${input.sourceWidth}x${input.sourceHeight} will be center-cropped to the ` +
    `${label}canvas ${input.canvasWidth}x${input.canvasHeight} (about ${formatPercent(classification.retainedAreaFraction)} ` +
    `of the frame is kept); part of the source image is discarded.`
  );
}
