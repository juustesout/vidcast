import type { GraphicStyleSpec } from '@/lib/types/scene';

/**
 * Deterministic palette resolution for the existing graphic templates.
 *
 * This is deliberately a small, opt-in layer: when a field is absent the
 * historical per-template color is used, so projects authored before the style
 * field existed render byte-for-byte with the old SVG markup.
 */

export const DEFAULT_GRAPHIC_TEXT_COLOR = '#f8fafc';
export const DEFAULT_GRAPHIC_SECONDARY_TEXT_COLOR = '#e2e8f0';
export const DEFAULT_GRAPHIC_ACCENT_COLOR = '#f2d17b';
export const DEFAULT_GRAPHIC_STATISTIC_LABEL_COLOR = '#93c5fd';

// AI Dev Forum palette. Brand blue is the background, white is the primary
// text color, and the coral brand color is reserved for accents/decorative
// emphasis. `statisticLabelColor` is a light coral tint so it remains readable
// on the brand-blue background.
export const AI_DEV_FORUM_GRAPHIC_STYLE: GraphicStyleSpec = {
  background: '#0056a7',
  textColor: '#ffffff',
  accentColor: '#ff5a5f',
  statisticLabelColor: '#ffd9da'
};

export interface ResolvedGraphicStyle {
  background: string;
  textColor?: string;
  accentColor?: string;
  statisticLabelColor?: string;
}

export function isValidGraphicColor(value: unknown): value is string {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

function normalizeStyle(style: GraphicStyleSpec | undefined): GraphicStyleSpec | undefined {
  if (!style || typeof style !== 'object') {
    return undefined;
  }

  const normalized: GraphicStyleSpec = {};
  if (isValidGraphicColor(style.background)) {
    normalized.background = style.background.trim();
  }
  if (isValidGraphicColor(style.textColor)) {
    normalized.textColor = style.textColor.trim();
  }
  if (isValidGraphicColor(style.accentColor)) {
    normalized.accentColor = style.accentColor.trim();
  }
  if (isValidGraphicColor(style.statisticLabelColor)) {
    normalized.statisticLabelColor = style.statisticLabelColor.trim();
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function mergeGraphicStyles(
  base: GraphicStyleSpec | undefined,
  override: GraphicStyleSpec | undefined
): GraphicStyleSpec | undefined {
  const merged = { ...(normalizeStyle(base) ?? {}), ...(normalizeStyle(override) ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveGraphicStyle(
  style: GraphicStyleSpec | undefined,
  fallbackBackground: string
): ResolvedGraphicStyle {
  const normalized = normalizeStyle(style);
  return {
    background: normalized?.background ?? fallbackBackground,
    textColor: normalized?.textColor,
    accentColor: normalized?.accentColor,
    statisticLabelColor: normalized?.statisticLabelColor
  };
}
