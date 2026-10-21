import fs from 'node:fs/promises';
import path from 'node:path';

import { OVERLAY_STYLE_LIMITS } from '@/lib/constants';
import type { NarrationWordTiming } from '@/lib/types/scene';
import type { RenderPlanScene } from '@/lib/types/render';

export const KARAOKE_ASS_FILENAME = 'karaoke.ass';

const DEFAULT_KARAOKE_FONT = 'DejaVu Sans';
const PRIMARY_COLOUR = '&H0000E6FF';
const SECONDARY_COLOUR = '&H00FFFFFF';
const OUTLINE_COLOUR = '&H00000000';
const BACK_COLOUR = '&H64000000';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function pad(value: number, size: number): string {
  return String(value).padStart(size, '0');
}

export function formatAssTime(seconds: number): string {
  const clamped = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalCentiseconds = Math.round(clamped * 100);
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const secs = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${hours}:${pad(minutes, 2)}:${pad(secs, 2)}.${pad(centiseconds, 2)}`;
}

function escapeAssText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/[\r\n]+/g, ' ');
}

function resolveFontSize(width: number): number {
  return Math.round(clamp(width * 0.045, OVERLAY_STYLE_LIMITS.MIN_FONT_SIZE, OVERLAY_STYLE_LIMITS.MAX_FONT_SIZE));
}

function resolveMarginV(height: number): number {
  return Math.round(clamp(height * 0.08, OVERLAY_STYLE_LIMITS.MIN_MARGIN, OVERLAY_STYLE_LIMITS.MAX_MARGIN));
}

export function visibleKaraokeWords(words: NarrationWordTiming[] | undefined, duration: number): NarrationWordTiming[] {
  if (!Array.isArray(words) || words.length === 0 || !Number.isFinite(duration) || duration <= 0) {
    return [];
  }

  const visible: NarrationWordTiming[] = [];
  for (const word of words) {
    if (typeof word.word !== 'string' || word.word.trim().length === 0) {
      continue;
    }
    if (!Number.isFinite(word.startSeconds) || !Number.isFinite(word.endSeconds)) {
      continue;
    }
    if (word.startSeconds >= duration || word.endSeconds <= word.startSeconds || word.startSeconds < 0) {
      continue;
    }
    visible.push({
      word: word.word,
      startSeconds: word.startSeconds,
      endSeconds: Math.min(word.endSeconds, duration)
    });
  }
  return visible;
}

export function buildKaraokeAss(options: {
  words: NarrationWordTiming[];
  width: number;
  height: number;
  duration: number;
}): string {
  const words = visibleKaraokeWords(options.words, options.duration);
  const fontSize = resolveFontSize(options.width);
  const marginV = resolveMarginV(options.height);
  const events = words.map((word) => {
    const centiseconds = Math.max(1, Math.round((word.endSeconds - word.startSeconds) * 100));
    return `Dialogue: 0,${formatAssTime(word.startSeconds)},${formatAssTime(word.endSeconds)},Karaoke,,0,0,0,,{\\k${centiseconds}}${escapeAssText(word.word)}`;
  });

  return [
    '[Script Info]',
    'Title: Karaoke',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${Math.max(1, Math.round(options.width))}`,
    `PlayResY: ${Math.max(1, Math.round(options.height))}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Karaoke,${DEFAULT_KARAOKE_FONT},${fontSize},${PRIMARY_COLOUR},${SECONDARY_COLOUR},${OUTLINE_COLOUR},${BACK_COLOUR},0,0,0,0,100,100,0,0,1,3,0,2,80,80,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events
  ].join('\n');
}

export async function writeKaraokeAssFile(tempDir: string, contents: string): Promise<string> {
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(path.join(tempDir, KARAOKE_ASS_FILENAME), contents, 'utf8');
  return KARAOKE_ASS_FILENAME;
}

export interface SceneKaraokeFilterOptions {
  width: number;
  height: number;
  duration: number;
  tempDir: string;
  subtitlesEnabled?: boolean;
}

export async function buildSceneKaraokeFilter(
  scene: Pick<RenderPlanScene, 'narration'>,
  options: SceneKaraokeFilterOptions
): Promise<string | undefined> {
  if (options.subtitlesEnabled === false) {
    return undefined;
  }

  const words = visibleKaraokeWords(scene.narration?.alignment?.words, options.duration);
  if (words.length === 0) {
    return undefined;
  }

  const contents = buildKaraokeAss({
    words,
    width: options.width,
    height: options.height,
    duration: options.duration
  });
  const fileName = await writeKaraokeAssFile(options.tempDir, contents);
  return `ass=${fileName}`;
}
