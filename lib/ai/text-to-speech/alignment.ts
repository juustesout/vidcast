import type { NarrationAlignment, NarrationCharacterAlignment, NarrationWordTiming } from '@/lib/types/scene';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asStringArray(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    return Array.from(value);
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const characters: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return undefined;
    }
    characters.push(entry);
  }
  return characters;
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const numbers: number[] = [];
  for (const entry of value) {
    if (!isFiniteNumber(entry)) {
      return undefined;
    }
    numbers.push(entry);
  }
  return numbers;
}

export function parseCharacterAlignment(value: unknown): NarrationCharacterAlignment | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const payload = value as Record<string, unknown>;
  if (payload.characters && typeof payload.characters === 'object' && !Array.isArray(payload.characters)) {
    return parseCharacterAlignment(payload.characters);
  }

  const characters = asStringArray(payload.characters);
  const characterStartTimesSeconds = asNumberArray(
    payload.characterStartTimesSeconds ?? payload.character_start_times_seconds
  );
  const characterEndTimesSeconds = asNumberArray(
    payload.characterEndTimesSeconds ?? payload.character_end_times_seconds
  );

  if (!characters || !characterStartTimesSeconds || !characterEndTimesSeconds) {
    return undefined;
  }

  return {
    characters,
    characterStartTimesSeconds,
    characterEndTimesSeconds
  };
}

export function isValidCharacterAlignment(alignment: NarrationCharacterAlignment | undefined): alignment is NarrationCharacterAlignment {
  if (!alignment) {
    return false;
  }

  const { characters, characterStartTimesSeconds, characterEndTimesSeconds } = alignment;
  if (characters.length === 0) {
    return false;
  }
  if (characters.length !== characterStartTimesSeconds.length) {
    return false;
  }
  if (characters.length !== characterEndTimesSeconds.length) {
    return false;
  }

  let previousStart = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < characters.length; index += 1) {
    const start = characterStartTimesSeconds[index];
    const end = characterEndTimesSeconds[index];
    if (start < 0 || end < 0 || end < start || start < previousStart) {
      return false;
    }
    previousStart = start;
  }

  return true;
}

export function characterAlignmentToWordTimings(alignment: NarrationCharacterAlignment): NarrationWordTiming[] {
  if (!isValidCharacterAlignment(alignment)) {
    return [];
  }

  const words: NarrationWordTiming[] = [];
  let current: { chars: string[]; startSeconds: number; endSeconds: number } | undefined;

  const flush = () => {
    if (!current) {
      return;
    }
    const word = current.chars.join('');
    if (word.length > 0) {
      words.push({
        word,
        startSeconds: current.startSeconds,
        endSeconds: current.endSeconds
      });
    }
    current = undefined;
  };

  for (let index = 0; index < alignment.characters.length; index += 1) {
    const character = alignment.characters[index];
    if (character.length === 0 || /^\s+$/.test(character)) {
      flush();
      continue;
    }

    const startSeconds = alignment.characterStartTimesSeconds[index];
    const endSeconds = alignment.characterEndTimesSeconds[index];
    if (!current) {
      current = { chars: [character], startSeconds, endSeconds };
    } else {
      current.chars.push(character);
      current.endSeconds = endSeconds;
    }
  }

  flush();
  return words;
}

export function buildPersistedNarrationAlignment(value: unknown): NarrationAlignment | undefined {
  const characters = parseCharacterAlignment(value);
  if (!isValidCharacterAlignment(characters)) {
    return undefined;
  }

  const words = characterAlignmentToWordTimings(characters);
  if (words.length === 0) {
    return undefined;
  }

  return { characters, words };
}
