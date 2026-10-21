import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildKaraokeAss,
  buildSceneKaraokeFilter,
  formatAssTime,
  KARAOKE_ASS_FILENAME,
  visibleKaraokeWords
} from '@/lib/render/karaoke';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import type { NarrationWordTiming } from '@/lib/types/scene';
import type { RenderPlan, RenderPlanScene } from '@/lib/types/render';

const WORDS: NarrationWordTiming[] = [
  { word: 'Hallo', startSeconds: 0.12, endSeconds: 0.48 },
  { word: 'wereld', startSeconds: 0.52, endSeconds: 1.1 }
];

function scene(words: NarrationWordTiming[] | undefined): RenderPlanScene {
  return {
    sceneId: 'scene-1',
    order: 1,
    duration: 4,
    status: 'renderable',
    source: { kind: 'image', assetPath: '/tmp/still.png', assetType: 'image' },
    motion: { preset: 'none' },
    transition: { type: 'none' },
    overlay: { type: 'none' },
    narration: words
      ? {
          text: 'Hallo wereld',
          alignment: {
            characters: {
              characters: ['H', 'a', 'l', 'l', 'o', ' ', 'w', 'e', 'r', 'e', 'l', 'd'],
              characterStartTimesSeconds: [0.12, 0.16, 0.2, 0.24, 0.28, 0.48, 0.52, 0.6, 0.7, 0.8, 0.9, 1],
              characterEndTimesSeconds: [0.16, 0.2, 0.24, 0.28, 0.48, 0.52, 0.6, 0.7, 0.8, 0.9, 1, 1.1]
            },
            words
          }
        }
      : { text: 'Hallo wereld' },
    referenceIds: [],
    issues: []
  };
}

function plan(words: NarrationWordTiming[] | undefined, subtitlesEnabled = true): RenderPlan {
  return {
    projectId: 'project-karaoke',
    title: 'Karaoke',
    aspectRatio: '16:9',
    fps: 30,
    width: 1280,
    height: 720,
    background: { type: 'color', value: '#020617' },
    ready: true,
    narration: { text: '', segments: [] },
    issues: [],
    scenes: [scene(words)],
    subtitlesEnabled
  };
}

describe('karaoke ASS timing', () => {
  it('formats ASS timestamps with centiseconds', () => {
    expect(formatAssTime(0)).toBe('0:00:00.00');
    expect(formatAssTime(1.1)).toBe('0:00:01.10');
    expect(formatAssTime(61.234)).toBe('0:01:01.23');
  });

  it('writes one dialogue line per word with karaoke highlight duration', () => {
    const ass = buildKaraokeAss({ words: WORDS, width: 1280, height: 720, duration: 4 });
    expect(ass).toContain('Style: Karaoke,DejaVu Sans');
    expect(ass).toContain('Dialogue: 0,0:00:00.12,0:00:00.48,Karaoke,,0,0,0,,{\\k36}Hallo');
    expect(ass).toContain('Dialogue: 0,0:00:00.52,0:00:01.10,Karaoke,,0,0,0,,{\\k58}wereld');
  });

  it('drops words that start after the scene duration', () => {
    expect(visibleKaraokeWords([
      { word: 'in', startSeconds: 0.1, endSeconds: 0.4 },
      { word: 'late', startSeconds: 4.2, endSeconds: 4.5 }
    ], 4).map((word) => word.word)).toEqual(['in']);
  });
});

describe('buildSceneKaraokeFilter', () => {
  it('writes karaoke.ass and returns an ass filter when word timings exist', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'karaoke-filter-'));
    const filter = await buildSceneKaraokeFilter(scene(WORDS), {
      width: 1280,
      height: 720,
      duration: 4,
      tempDir,
      subtitlesEnabled: true
    });
    expect(filter).toBe(`ass=${KARAOKE_ASS_FILENAME}`);
    const written = await fs.readFile(path.join(tempDir, KARAOKE_ASS_FILENAME), 'utf8');
    expect(written).toContain('{\\k36}Hallo');
  });

  it('returns undefined when alignment is missing or subtitles are disabled', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'karaoke-empty-'));
    expect(await buildSceneKaraokeFilter(scene(undefined), {
      width: 1280,
      height: 720,
      duration: 4,
      tempDir
    })).toBeUndefined();
    expect(await buildSceneKaraokeFilter(scene(WORDS), {
      width: 1280,
      height: 720,
      duration: 4,
      tempDir,
      subtitlesEnabled: false
    })).toBeUndefined();
  });
});

describe('karaoke fingerprint', () => {
  it('changes when word timings or the subtitle gate change', () => {
    const withWords = createSceneRenderFingerprint(plan(WORDS), scene(WORDS));
    const withoutWords = createSceneRenderFingerprint(plan(undefined), scene(undefined));
    const disabled = createSceneRenderFingerprint(plan(WORDS, false), scene(WORDS));
    expect(withWords).not.toBe(withoutWords);
    expect(withWords).not.toBe(disabled);
  });
});
