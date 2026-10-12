import { OVERLAY_STYLE_LIMITS } from '@/lib/constants';
import type { OverlayPosition, OverlaySpec, OverlayType } from '@/lib/types/scene';

/**
 * Pure (node-free) text-overlay resolution.
 *
 * This module holds the deterministic mapping from an authored `OverlaySpec`
 * plus scene geometry to concrete drawtext values. It is intentionally free of
 * Node built-ins so the browser preview (`components/preview/scene-preview.tsx`)
 * can reuse the exact same defaults, clamping and color handling as the FFmpeg
 * renderer. The FFmpeg-specific pieces (filter string building, temp-file
 * writing) live in `lib/render/text-overlay.ts`.
 */

const DEFAULT_TEXT_COLOR = '0xf8fafc';
export const DEFAULT_OVERLAY_BOX_COLOR = 'black@0.45';
export const DEFAULT_OVERLAY_BORDER_COLOR = '0x000000';
export const DEFAULT_OVERLAY_FADE_IN_SECONDS = 0.4;
export const DEFAULT_OVERLAY_FADE_OUT_SECONDS = 0;

const MIN_FONT_SIZE = OVERLAY_STYLE_LIMITS.MIN_FONT_SIZE;
const MAX_FONT_SIZE = OVERLAY_STYLE_LIMITS.MAX_FONT_SIZE;
const MIN_MARGIN = OVERLAY_STYLE_LIMITS.MIN_MARGIN;
const MAX_MARGIN = OVERLAY_STYLE_LIMITS.MAX_MARGIN;

export interface TextOverlayGeometry {
  width: number;
  height: number;
  duration: number;
}

export interface ResolvedTextOverlay {
  type: OverlayType;
  text: string;
  position: OverlayPosition;
  fontSize: number;
  fontColor: string;
  box: boolean;
  boxColor: string;
  borderWidth: number;
  borderColor: string;
  margin: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  duration: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Whether a value is a color string the drawtext filter accepts. Mirrors the
 * formats handled by `normalizeColor`: `#rgb`/`#rrggbb`, `0xrrggbb`/`0xrrggbbaa`
 * and FFmpeg named colors with an optional `@alpha` suffix.
 */
export function isValidOverlayColor(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) {
    return true;
  }
  if (/^0x[0-9a-fA-F]{6,8}$/.test(trimmed)) {
    return true;
  }
  if (/^[a-zA-Z]+(@[0-9.]+)?$/.test(trimmed)) {
    return true;
  }

  return false;
}

function normalizeColor(value: unknown): string | undefined {
  if (!isValidOverlayColor(value)) {
    return undefined;
  }

  const trimmed = value.trim();
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
  if (hex) {
    const digits = hex[1];
    const expanded = digits.length === 3 ? digits.split('').map((entry) => entry + entry).join('') : digits;
    return `0x${expanded.toLowerCase()}`;
  }

  if (/^0x[0-9a-fA-F]{6,8}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  return trimmed;
}

export function defaultPositionForType(type: OverlayType): OverlayPosition {
  if (type === 'title') {
    return 'top';
  }
  if (type === 'statistic' || type === 'quote') {
    return 'center';
  }
  return 'bottom';
}

export function defaultBoxForType(type: OverlayType): boolean {
  return type === 'title' || type === 'callout' || type === 'statistic';
}

function fontScaleForType(type: OverlayType): number {
  switch (type) {
    case 'title':
      return 0.055;
    case 'statistic':
      return 0.08;
    case 'quote':
    case 'subtitle':
      return 0.045;
    default:
      return 0.04;
  }
}

function resolveFontSize(type: OverlayType, width: number, requested: unknown): number {
  if (isFiniteNumber(requested) && requested > 0) {
    return Math.round(clamp(requested, MIN_FONT_SIZE, MAX_FONT_SIZE));
  }
  return Math.round(clamp(width * fontScaleForType(type), MIN_FONT_SIZE, MAX_FONT_SIZE));
}

function resolveMargin(height: number, requested: unknown): number {
  if (isFiniteNumber(requested) && requested > 0) {
    return Math.round(clamp(requested, MIN_MARGIN, MAX_MARGIN));
  }
  return Math.round(clamp(height * 0.08, MIN_MARGIN, MAX_MARGIN));
}

function resolveFade(value: unknown, fallback: number, duration: number): number {
  if (!isFiniteNumber(value) || value < 0) {
    return clamp(fallback, 0, Math.max(0, duration));
  }
  return clamp(value, 0, Math.max(0, duration));
}

export function hasRenderableTextOverlay(overlay: OverlaySpec | undefined): boolean {
  if (!overlay || overlay.type === 'none') {
    return false;
  }
  return typeof overlay.text === 'string' && overlay.text.trim().length > 0;
}

export function resolveTextOverlay(overlay: OverlaySpec | undefined, geometry: TextOverlayGeometry): ResolvedTextOverlay | null {
  if (!hasRenderableTextOverlay(overlay)) {
    return null;
  }

  const source = overlay as OverlaySpec;
  const text = (source.text ?? '').trim();
  const type = source.type;
  const style = source.style ?? {};
  const timing = source.timing ?? {};

  const position = source.position ?? defaultPositionForType(type);
  const box = typeof style.box === 'boolean' ? style.box : defaultBoxForType(type);

  return {
    type,
    text,
    position,
    fontSize: resolveFontSize(type, geometry.width, style.fontSize),
    fontColor: normalizeColor(style.color) ?? DEFAULT_TEXT_COLOR,
    box,
    boxColor: DEFAULT_OVERLAY_BOX_COLOR,
    borderWidth: box ? 0 : 2,
    borderColor: DEFAULT_OVERLAY_BORDER_COLOR,
    margin: resolveMargin(geometry.height, style.margin),
    fadeInSeconds: resolveFade(timing.fadeInSeconds, DEFAULT_OVERLAY_FADE_IN_SECONDS, geometry.duration),
    fadeOutSeconds: resolveFade(timing.fadeOutSeconds, DEFAULT_OVERLAY_FADE_OUT_SECONDS, geometry.duration),
    duration: Math.max(0, geometry.duration)
  };
}

export function positionExpression(overlay: Pick<ResolvedTextOverlay, 'position' | 'margin'>): string {
  switch (overlay.position) {
    case 'top':
      return String(overlay.margin);
    case 'center':
      return '(h-text_h)/2';
    case 'bottom':
    default:
      return `h-text_h-${overlay.margin}`;
  }
}

export function buildAlphaExpression(fadeInSeconds: number, fadeOutSeconds: number, duration: number): string | undefined {
  const durationValue = Math.max(0, duration);
  const fadeIn = clamp(fadeInSeconds, 0, durationValue);
  const fadeOut = clamp(fadeOutSeconds, 0, durationValue);

  if (fadeIn <= 0 && fadeOut <= 0) {
    return undefined;
  }

  const format = (value: number) => value.toFixed(3);

  if (fadeOut <= 0) {
    return `if(lt(t,${format(fadeIn)}),t/${format(fadeIn)},1)`;
  }

  const fadeOutStart = Math.max(fadeIn, durationValue - fadeOut);
  if (fadeIn <= 0) {
    return `if(gt(t,${format(fadeOutStart)}),(${format(durationValue)}-t)/${format(fadeOut)},1)`;
  }

  return `if(lt(t,${format(fadeIn)}),t/${format(fadeIn)},if(gt(t,${format(fadeOutStart)}),(${format(durationValue)}-t)/${format(fadeOut)},1))`;
}

/**
 * Convert a resolved drawtext color to a CSS color for the browser preview.
 * FFmpeg hex colors are written as `0xrrggbb[aa]`; everything else (named colors
 * and `@alpha`) is passed through unchanged.
 */
export function toCssColor(color: string): string {
  const hex = /^0x([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(color);
  if (hex) {
    return `#${hex[1].toLowerCase()}`;
  }
  return color;
}
