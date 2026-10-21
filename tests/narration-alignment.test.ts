import { describe, expect, it } from 'vitest';

import {
  buildPersistedNarrationAlignment,
  characterAlignmentToWordTimings,
  isValidCharacterAlignment,
  parseCharacterAlignment
} from '@/lib/ai/text-to-speech/alignment';

const HELLO = {
  characters: ['H', 'e', 'l', 'l', 'o', ' ', 'w', 'e', 'r', 'e', 'l', 'd'],
  character_start_times_seconds: [0, 0.04, 0.08, 0.12, 0.16, 0.22, 0.26, 0.32, 0.38, 0.44, 0.5, 0.56],
  character_end_times_seconds: [0.04, 0.08, 0.12, 0.16, 0.22, 0.26, 0.32, 0.38, 0.44, 0.5, 0.56, 0.7]
};

describe('character alignment parsing', () => {
  it('accepts camelCase and snake_case character timestamps', () => {
    const snake = parseCharacterAlignment(HELLO);
    const camel = parseCharacterAlignment({
      characters: HELLO.characters,
      characterStartTimesSeconds: HELLO.character_start_times_seconds,
      characterEndTimesSeconds: HELLO.character_end_times_seconds
    });

    expect(snake?.characters).toEqual(HELLO.characters);
    expect(camel).toEqual(snake);
  });

  it('rejects missing, empty, or length-mismatched arrays', () => {
    expect(parseCharacterAlignment(null)).toBeUndefined();
    expect(isValidCharacterAlignment(parseCharacterAlignment({
      characters: [],
      character_start_times_seconds: [],
      character_end_times_seconds: []
    }))).toBe(false);
    expect(isValidCharacterAlignment(parseCharacterAlignment({
      characters: ['a', 'b'],
      character_start_times_seconds: [0],
      character_end_times_seconds: [0.1, 0.2]
    }))).toBe(false);
  });

  it('rejects negative, inverted, or non-monotonic times', () => {
    expect(isValidCharacterAlignment(parseCharacterAlignment({
      characters: ['a', 'b'],
      character_start_times_seconds: [-0.1, 0.1],
      character_end_times_seconds: [0.1, 0.2]
    }))).toBe(false);
    expect(isValidCharacterAlignment(parseCharacterAlignment({
      characters: ['a', 'b'],
      character_start_times_seconds: [0.2, 0.1],
      character_end_times_seconds: [0.3, 0.4]
    }))).toBe(false);
    expect(isValidCharacterAlignment(parseCharacterAlignment({
      characters: ['a'],
      character_start_times_seconds: [0.4],
      character_end_times_seconds: [0.2]
    }))).toBe(false);
  });
});

describe('character to word conversion', () => {
  it('groups characters into words using whitespace, without inventing extra words', () => {
    const alignment = parseCharacterAlignment(HELLO);
    expect(alignment).toBeDefined();
    const words = characterAlignmentToWordTimings(alignment!);
    expect(words.map((entry) => entry.word)).toEqual(['Hello', 'wereld']);
    expect(words[0].startSeconds).toBe(0);
    expect(words[0].endSeconds).toBe(0.22);
    expect(words[1].startSeconds).toBe(0.26);
    expect(words[1].endSeconds).toBe(0.7);
  });

  it('returns no words for invalid alignment instead of estimating', () => {
    expect(characterAlignmentToWordTimings({
      characters: ['a', 'b'],
      characterStartTimesSeconds: [0.3, 0.1],
      characterEndTimesSeconds: [0.4, 0.5]
    })).toEqual([]);
    expect(buildPersistedNarrationAlignment(null)).toBeUndefined();
    expect(buildPersistedNarrationAlignment({
      characters: [' '],
      character_start_times_seconds: [0],
      character_end_times_seconds: [0.1]
    })).toBeUndefined();
  });
});
