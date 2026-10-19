import fs from 'node:fs/promises';
import path from 'node:path';

import type { RenderPlanScene } from '@/lib/types/render';
import { buildAlphaExpression, positionExpression, resolveTextOverlay, type ResolvedTextOverlay } from './overlay-resolve';

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
 *
 * The deterministic resolution of authored overlay values (defaults, clamps,
 * color normalization) lives in the pure, node-free `./overlay-resolve` module so
 * the browser preview can share it. The functions below are kept re-exported for
 * API compatibility with earlier callers/tests.
 */

export const DEFAULT_OVERLAY_FONT = 'DejaVu Sans';
export const OVERLAY_TEXT_FILENAME = 'overlay-text.txt';

export {
  buildAlphaExpression,
  defaultBoxForType,
  defaultPositionForType,
  hasRenderableTextOverlay,
  isValidOverlayColor,
  resolveTextOverlay,
  toCssColor
} from './overlay-resolve';
export type { ResolvedTextOverlay, TextOverlayGeometry } from './overlay-resolve';

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

export function buildDrawtextFilter(overlay: ResolvedTextOverlay, textFileName: string, centerX?: number): string {
  const parts = [
    `font=${escapeDrawtextValue(DEFAULT_OVERLAY_FONT)}`,
    `textfile=${escapeDrawtextValue(textFileName)}`,
    `fontcolor=${overlay.fontColor}`,
    `fontsize=${overlay.fontSize}`,
    `x=${typeof centerX === 'number' ? `${Math.round(centerX)}-text_w/2` : '(w-text_w)/2'}`,
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
  // Optional pixel center used when the scene is framed by a studio overlay,
  // so lower-third copy is centered in the visible screen instead of the
  // full canvas. Omitted keeps the historical canvas-centered behavior.
  centerX?: number;
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
  return buildDrawtextFilter(resolved, textFileName, options.centerX);
}
