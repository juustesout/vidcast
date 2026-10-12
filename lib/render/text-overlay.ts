import fs from 'node:fs/promises';
import path from 'node:path';

import type { OverlayPosition, OverlaySpec, OverlayType } from '@/lib/types/scene';
import type { RenderPlanScene } from '@/lib/types/render';

/**
 * P29.1 phase-1 text overlays.
 *
 * Renders a single text overlay per scene on top of the scene frame using
 * FFmpeg's `drawtext` filter. The visible text is never embedded in the filter
 * graph: it is written to a UTF-8 file next to the render temporaries and
 * referenced with `textfile=`, which removes the classic drawtext escaping
 * footguns (colons, commas, quotes, backslashes, percent signs, newlines).
 *
 * Only operator/AI-provided values that DO reach the filter graph (font names,
 * colors) go through `escapeDrawtextValue`.
 */

export const DEFAULT_OVERLAY_FONT = 'DejaVu Sans';
export const OVERLAY_TEXT_FILENAME = 'overlay-text.txt';

const DEFAULT_TEXT_COLOR = '0xf8fafc';
const DEFAULT_BOX_COLOR = 'black@0.45';
const DEFAULT_BORDER_COLOR = '0x000000';
const DEFAULT_FADE_IN_SECONDS = 0.4;
const DEFAULT_FADE_OUT_SECONDS = 0;
const MIN_FONT_SIZE = 24;
const MAX_FONT_SIZE = 220;
const MIN_MARGIN = 16;
const MAX_MARGIN = 240;

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
  fontName: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Escape a value for use inside an FFmpeg filter graph option. Backslash must
 * be escaped first so later replacements are not double-processed.
 */
export function escapeDrawtextValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/;/g, '\\;')
    .replace(/%/g, '\\%')
    .replace(/ /g, '\\ ');
}

function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') {
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

  if (/^[a-zA-Z]+(@[0-9.]+)?$/.test(trimmed)) {
    return trimmed;
  }

  return undefined;
}

function defaultPositionForType(type: OverlayType): OverlayPosition {
  if (type === 'title') {
    return 'top';
  }
  if (type === 'statistic' || type === 'quote') {
    return 'center';
  }
  return 'bottom';
}

function defaultBoxForType(type: OverlayType): boolean {
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
    boxColor: DEFAULT_BOX_COLOR,
    borderWidth: box ? 0 : 2,
    borderColor: DEFAULT_BORDER_COLOR,
    margin: resolveMargin(geometry.height, style.margin),
    fadeInSeconds: resolveFade(timing.fadeInSeconds, DEFAULT_FADE_IN_SECONDS, geometry.duration),
    fadeOutSeconds: resolveFade(timing.fadeOutSeconds, DEFAULT_FADE_OUT_SECONDS, geometry.duration),
    duration: Math.max(0, geometry.duration),
    fontName: DEFAULT_OVERLAY_FONT
  };
}

function positionExpression(overlay: ResolvedTextOverlay): string {
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

export function buildDrawtextFilter(overlay: ResolvedTextOverlay, textFileName: string): string {
  const parts = [
    `font=${escapeDrawtextValue(overlay.fontName)}`,
    `textfile=${escapeDrawtextValue(textFileName)}`,
    `fontcolor=${overlay.fontColor}`,
    `fontsize=${overlay.fontSize}`,
    'x=(w-text_w)/2',
    `y=${positionExpression(overlay)}`,
    `borderw=${overlay.borderWidth}`,
    `bordercolor=${overlay.borderColor}`,
    'line_spacing=12',
    'expansion=none'
  ];

  if (overlay.box) {
    parts.push('box=1', `boxcolor=${overlay.boxColor}`, 'boxborderw=16');
  }

  const alpha = buildAlphaExpression(overlay.fadeInSeconds, overlay.fadeOutSeconds, overlay.duration);
  if (alpha) {
    // The expression contains commas (filter separators) so it must be quoted;
    // it is numeric-only, so it cannot inject quotes or graph syntax.
    parts.push(`alpha='${alpha}'`);
  }

  return `drawtext=${parts.join(':')}`;
}

/**
 * Write the overlay copy to a UTF-8 file inside the render temp directory and
 * return the file name. Callers pass a basename (not an absolute path) so the
 * value that reaches the filter graph is always a fixed, sanitized string.
 */
export async function writeOverlayTextFile(tempDir: string, text: string): Promise<string> {
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(path.join(tempDir, OVERLAY_TEXT_FILENAME), text, 'utf8');
  return OVERLAY_TEXT_FILENAME;
}

export interface SceneOverlayFilterOptions {
  width: number;
  height: number;
  duration: number;
  tempDir: string;
}

/**
 * Build the drawtext filter stage for a scene, or `undefined` when the scene
 * has no renderable overlay.
 *
 * `text` scenes are skipped on purpose: their entire frame is authored copy via
 * the existing SVG path (`createStillSceneSvg`), where the overlay text is only
 * a legacy fallback, and applying drawtext on top would duplicate it.
 */
export async function buildSceneOverlayFilter(
  scene: Pick<RenderPlanScene, 'source' | 'overlay'>,
  options: SceneOverlayFilterOptions
): Promise<string | undefined> {
  if (scene.source.kind === 'text') {
    return undefined;
  }

  const resolved = resolveTextOverlay(scene.overlay, {
    width: options.width,
    height: options.height,
    duration: options.duration
  });
  if (!resolved) {
    return undefined;
  }

  const textFileName = await writeOverlayTextFile(options.tempDir, resolved.text);
  return buildDrawtextFilter(resolved, textFileName);
}
