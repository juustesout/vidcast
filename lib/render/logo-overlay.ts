import { LOGO_OVERLAY_LIMITS } from '@/lib/constants';
import type { LogoOverlayPosition, LogoOverlaySpec } from '@/lib/types/scene';

/**
 * Pure logo-overlay geometry and FFmpeg filter construction.
 *
 * The layer is intentionally independent of the scene source: it is applied
 * after stock/image/graphic content and after the existing text overlay, so a
 * single image can be reused by any number of scenes. Keeping the geometry in a
 * node-free module makes the defaults and clamping testable without FFmpeg.
 */

export const DEFAULT_LOGO_POSITION: LogoOverlayPosition = 'bottom_right';
export const DEFAULT_LOGO_SCALE = 0.15;
export const DEFAULT_LOGO_MARGIN_RATIO = 0.045;

export interface ResolvedLogoGeometry {
  position: LogoOverlayPosition;
  width: number;
  margin: number;
  opacity: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isLogoOverlayPosition(value: unknown): value is LogoOverlayPosition {
  return value === 'top_left' || value === 'top_right' || value === 'bottom_left' || value === 'bottom_right';
}

export function resolveLogoGeometry(
  logo: Pick<LogoOverlaySpec, 'position' | 'scale' | 'maxWidth' | 'margin' | 'opacity'>,
  canvasWidth: number,
  canvasHeight: number
): ResolvedLogoGeometry {
  const safeCanvasWidth = Math.max(2, Math.round(canvasWidth));
  const safeCanvasHeight = Math.max(2, Math.round(canvasHeight));
  const scale = isFiniteNumber(logo.scale)
    ? clamp(logo.scale, LOGO_OVERLAY_LIMITS.MIN_SCALE, LOGO_OVERLAY_LIMITS.MAX_SCALE)
    : DEFAULT_LOGO_SCALE;
  const maxWidth = isFiniteNumber(logo.maxWidth)
    ? clamp(logo.maxWidth, LOGO_OVERLAY_LIMITS.MIN_MAX_WIDTH, LOGO_OVERLAY_LIMITS.MAX_MAX_WIDTH)
    : safeCanvasWidth;
  const width = Math.max(2, Math.round(Math.min(safeCanvasWidth * scale, maxWidth, safeCanvasWidth)));
  const defaultMargin = Math.round(Math.min(safeCanvasWidth, safeCanvasHeight) * DEFAULT_LOGO_MARGIN_RATIO);
  const margin = isFiniteNumber(logo.margin)
    ? Math.round(clamp(logo.margin, LOGO_OVERLAY_LIMITS.MIN_MARGIN, LOGO_OVERLAY_LIMITS.MAX_MARGIN))
    : defaultMargin;
  const opacity = isFiniteNumber(logo.opacity)
    ? clamp(logo.opacity, LOGO_OVERLAY_LIMITS.MIN_OPACITY, LOGO_OVERLAY_LIMITS.MAX_OPACITY)
    : 1;

  return {
    position: isLogoOverlayPosition(logo.position) ? logo.position : DEFAULT_LOGO_POSITION,
    width,
    margin,
    opacity
  };
}

export function logoOverlayPosition(geometry: Pick<ResolvedLogoGeometry, 'position' | 'margin'>): { x: string; y: string } {
  switch (geometry.position) {
    case 'top_left':
      return { x: String(geometry.margin), y: String(geometry.margin) };
    case 'top_right':
      return { x: `W-w-${geometry.margin}`, y: String(geometry.margin) };
    case 'bottom_left':
      return { x: String(geometry.margin), y: `H-h-${geometry.margin}` };
    case 'bottom_right':
    default:
      return { x: `W-w-${geometry.margin}`, y: `H-h-${geometry.margin}` };
  }
}

/**
 * Build the scale/alpha and overlay filter stages for a logo input. The caller
 * supplies the already-prepared image path as a separate FFmpeg input. The
 * `shortest=1` option is required because the logo input is looped: without it
 * the overlay would outlive a finite video source.
 */
export function buildLogoOverlayFilter(
  geometry: ResolvedLogoGeometry,
  inputLabel: string,
  baseLabel: string,
  outputLabel: string
): string {
  const alpha = geometry.opacity < 1 ? `,colorchannelmixer=aa=${geometry.opacity.toFixed(3)}` : '';
  const logoChain = `[${inputLabel}]scale=w=${geometry.width}:h=-2:flags=lanczos,format=rgba${alpha}[logo]`;
  const { x, y } = logoOverlayPosition(geometry);
  return `${logoChain};[${baseLabel}][logo]overlay=x=${x}:y=${y}:shortest=1[${outputLabel}]`;
}
