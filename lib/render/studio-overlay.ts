import type { RenderPlanStudioOverlay } from '@/lib/types/render';
import type { StudioOverlaySpec } from '@/lib/types/scene';
import { isValidGraphicColor } from './graphic-style';

/**
 * Pure geometry and SVG construction for the reusable news-studio set.
 *
 * The studio is a transparent-cutout frame: the scene source (stock photo,
 * generated image or graphic card) shows through `screen`, while the navy set,
 * brand bar, lower-third plate and desk band cover the rest of the canvas. The
 * layer is intentionally independent of the news item, so every scene shares
 * one studio while its content remains replaceable.
 */

export const DEFAULT_STUDIO_SCREEN = {
  x: 0.05,
  y: 0.09,
  width: 0.64,
  height: 0.64
} as const;

export const DEFAULT_STUDIO_BRAND = 'AI DEV FORUM';
export const DEFAULT_STUDIO_PROGRAM = 'NEWS';
export const DEFAULT_STUDIO_ACCENT = '#ff5a5f';

export const STUDIO_SCREEN_LIMITS = {
  MIN_SIZE: 0.1,
  MAX_RADIUS: 400
} as const;

const STUDIO_BACKGROUND_START = '#07121f';
const STUDIO_BACKGROUND_END = '#0a1b2d';
const STUDIO_PANEL = '#0c2034';
const STUDIO_BORDER = '#16324a';
const STUDIO_BLUE = '#0056a7';
const STUDIO_TEXT = '#ffffff';
const STUDIO_MUTED = '#9fb4d4';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function unit(value: unknown, fallback: number): number {
  return finite(value) ? clamp(value, 0, 1) : fallback;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function label(value: unknown, fallback: string, maxLength: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return (trimmed || fallback).slice(0, maxLength);
}

export function resolveStudioOverlay(
  studio: StudioOverlaySpec | undefined,
  width: number,
  height: number
): RenderPlanStudioOverlay | undefined {
  if (!studio || typeof studio !== 'object') {
    return undefined;
  }

  const safeWidth = Math.max(2, Math.round(width));
  const safeHeight = Math.max(2, Math.round(height));
  const screen = studio.screen ?? {};
  const screenWidth = Math.max(
    Math.round(safeWidth * STUDIO_SCREEN_LIMITS.MIN_SIZE),
    Math.round(safeWidth * unit(screen.width, DEFAULT_STUDIO_SCREEN.width))
  );
  const screenHeight = Math.max(
    Math.round(safeHeight * STUDIO_SCREEN_LIMITS.MIN_SIZE),
    Math.round(safeHeight * unit(screen.height, DEFAULT_STUDIO_SCREEN.height))
  );
  const x = Math.min(
    Math.round(safeWidth * unit(screen.x, DEFAULT_STUDIO_SCREEN.x)),
    Math.max(0, safeWidth - 2)
  );
  const y = Math.min(
    Math.round(safeHeight * unit(screen.y, DEFAULT_STUDIO_SCREEN.y)),
    Math.max(0, safeHeight - 2)
  );
  const clampedWidth = Math.min(screenWidth, safeWidth - x);
  const clampedHeight = Math.min(screenHeight, safeHeight - y);
  const defaultRadius = Math.round(Math.min(clampedWidth, clampedHeight) * 0.012);
  const radius = Math.round(
    finite(screen.radius)
      ? clamp(screen.radius, 0, Math.min(STUDIO_SCREEN_LIMITS.MAX_RADIUS, Math.min(clampedWidth, clampedHeight) / 4))
      : defaultRadius
  );

  return {
    brand: label(studio.brand, DEFAULT_STUDIO_BRAND, 40),
    program: label(studio.program, DEFAULT_STUDIO_PROGRAM, 24),
    accentColor: isValidGraphicColor(studio.accentColor) ? studio.accentColor.trim() : DEFAULT_STUDIO_ACCENT,
    screen: {
      x,
      y,
      width: Math.max(2, clampedWidth),
      height: Math.max(2, clampedHeight),
      radius
    }
  };
}

export function createStudioOverlaySvg(
  studio: RenderPlanStudioOverlay,
  width: number,
  height: number
): string {
  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  const s = studio.screen;
  const brandSize = Math.max(18, Math.round(h * 0.028));
  const smallSize = Math.max(12, Math.round(h * 0.014));
  const brandBaseline = Math.round(Math.max(brandSize * 1.2, s.y * 0.56 + brandSize * 0.35));
  const glowInset = Math.max(6, Math.round(h * 0.012));
  const plateY = Math.round(s.y + s.height + h * 0.025);
  const plateHeight = Math.max(
    Math.round(h * 0.08),
    Math.min(Math.round(h * 0.17), Math.round(h * 0.955 - plateY))
  );
  const deskY = Math.round(h * 0.955);
  const brand = escapeXml(studio.brand);
  const program = escapeXml(studio.program);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="studio-bg" x1="0" y1="0" x2="0.75" y2="1">
      <stop offset="0%" stop-color="${STUDIO_BACKGROUND_START}" />
      <stop offset="100%" stop-color="${STUDIO_BACKGROUND_END}" />
    </linearGradient>
    <radialGradient id="studio-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${STUDIO_BLUE}" stop-opacity="0.30" />
      <stop offset="100%" stop-color="${STUDIO_BLUE}" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="studio-desk" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0a1a2a" />
      <stop offset="100%" stop-color="#03070c" />
    </linearGradient>
    <mask id="studio-screen-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">
      <rect width="${w}" height="${h}" fill="#ffffff" />
      <rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.radius}" fill="#000000" />
    </mask>
  </defs>

  <g mask="url(#studio-screen-cut)">
    <rect width="${w}" height="${h}" fill="url(#studio-bg)" />
    <circle cx="${Math.round(w * 0.16)}" cy="${Math.round(h * 0.18)}" r="${Math.round(h * 0.42)}" fill="url(#studio-glow)" />
    <rect x="${s.x - glowInset * 2}" y="${s.y - glowInset * 2}" width="${s.width + glowInset * 4}" height="${s.height + glowInset * 4}" rx="${s.radius + glowInset * 2}" fill="${STUDIO_PANEL}" opacity="0.72" />
    <path d="M0 ${Math.round(h * 0.74)} L${w} ${Math.round(h * 0.22)}" stroke="${STUDIO_BLUE}" stroke-width="2" opacity="0.10" />
    <path d="M0 ${Math.round(h * 0.82)} L${w} ${Math.round(h * 0.34)}" stroke="${STUDIO_MUTED}" stroke-width="1" opacity="0.06" />
    <rect x="${s.x - glowInset * 3}" y="${Math.round(s.y + s.height * 0.12)}" width="4" height="${Math.round(s.height * 0.34)}" rx="2" fill="${studio.accentColor}" opacity="0.70" />
    <rect x="0" y="${deskY}" width="${w}" height="${h - deskY}" fill="url(#studio-desk)" />
    <rect x="0" y="${deskY}" width="${w}" height="3" fill="${STUDIO_BLUE}" opacity="0.45" />
    <rect x="0" y="${deskY + 3}" width="${w}" height="1" fill="#ffffff" opacity="0.06" />
  </g>

  <rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.radius}" fill="none" stroke="${STUDIO_BORDER}" stroke-width="10" />
  <rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.radius}" fill="none" stroke="${STUDIO_BLUE}" stroke-width="3" opacity="0.90" />

  <circle cx="${s.x + Math.round(brandSize * 0.18)}" cy="${brandBaseline - Math.round(brandSize * 0.32)}" r="${Math.max(3, Math.round(brandSize * 0.18))}" fill="${studio.accentColor}" />
  <text x="${s.x + Math.round(brandSize * 0.55)}" y="${brandBaseline}" fill="${STUDIO_TEXT}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${brandSize}" font-weight="700" letter-spacing="${Math.max(1, Math.round(brandSize * 0.08))}">${brand}</text>
  <text x="${s.x + s.width}" y="${brandBaseline}" text-anchor="end" fill="${STUDIO_MUTED}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${smallSize}" font-weight="600" letter-spacing="${Math.max(1, Math.round(smallSize * 0.18))}">${program}</text>

  <rect x="${s.x}" y="${plateY}" width="${s.width}" height="${plateHeight}" rx="${Math.round(h * 0.012)}" fill="#0a1a2a" opacity="0.72" />
  <rect x="${s.x}" y="${plateY}" width="${Math.max(4, Math.round(w * 0.004))}" height="${plateHeight}" rx="3" fill="${studio.accentColor}" />
</svg>`;
}

export function buildStudioOverlayFilter(
  inputLabel: string,
  baseLabel: string,
  outputLabel: string
): string {
  return `[${inputLabel}]format=rgba[studio];[${baseLabel}][studio]overlay=0:0[${outputLabel}]`;
}
