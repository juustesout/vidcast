import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';

// Mirrors the ElevenLabs Music API bounds surfaced in the UI (in seconds).
export const MUSIC_MIN_DURATION_SECONDS = 3;
export const MUSIC_MAX_DURATION_SECONDS = 600;
export const MUSIC_DEFAULT_DURATION_SECONDS = 60;

export interface MusicFormInput {
  prompt: string;
  durationSeconds?: string | number | null;
  instrumental?: boolean;
}

export interface MusicFormPayload {
  prompt: string;
  musicLengthMs: number;
  instrumental: boolean;
}

export interface MusicFormValidation {
  ok: boolean;
  errors: { prompt?: string; duration?: string };
  payload?: MusicFormPayload;
}

// Validates and normalizes the background-music form entirely client-side. The
// server re-validates; this only exists to give immediate, friendly feedback and
// to avoid building a request for obviously invalid input.
export function validateMusicForm(input: MusicFormInput, options: { defaultDurationSeconds?: number } = {}): MusicFormValidation {
  const errors: MusicFormValidation['errors'] = {};

  const prompt = (input.prompt ?? '').trim();
  if (!prompt) {
    errors.prompt = 'Enter a music prompt first.';
  }

  const fallbackSeconds =
    typeof options.defaultDurationSeconds === 'number' &&
    options.defaultDurationSeconds >= MUSIC_MIN_DURATION_SECONDS &&
    options.defaultDurationSeconds <= MUSIC_MAX_DURATION_SECONDS
      ? options.defaultDurationSeconds
      : MUSIC_DEFAULT_DURATION_SECONDS;

  let musicLengthMs = Math.round(fallbackSeconds * 1000);
  const raw = input.durationSeconds;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const seconds = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(seconds)) {
      errors.duration = 'Enter a valid duration in seconds.';
    } else if (seconds < MUSIC_MIN_DURATION_SECONDS) {
      errors.duration = `Duration must be at least ${MUSIC_MIN_DURATION_SECONDS} seconds.`;
    } else if (seconds > MUSIC_MAX_DURATION_SECONDS) {
      errors.duration = `Duration must be at most ${MUSIC_MAX_DURATION_SECONDS} seconds.`;
    } else {
      musicLengthMs = Math.round(seconds * 1000);
    }
  }

  if (errors.prompt || errors.duration) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors,
    payload: {
      prompt,
      musicLengthMs,
      instrumental: input.instrumental ?? true
    }
  };
}

export function resolveSelectedMusicAsset(project: Project): Asset | undefined {
  const assetId = project.music?.assetId;
  if (!assetId) {
    return undefined;
  }
  return project.assets.find((asset) => asset.id === assetId);
}

export function listMusicCandidateAssets(project: Project): Asset[] {
  return project.assets.filter((asset) => asset.type === 'music' || asset.type === 'audio');
}

const MUSIC_ERROR_MESSAGES: Record<string, string> = {
  'music.provider.notConfigured': 'Music generation is not configured on the server. Set ELEVENLABS_API_KEY and try again.',
  'music.alreadyRunning': 'A music generation is already running for this project.',
  'music.alreadyGenerated': 'This project already has generated music. Use "Regenerate music" to replace it.',
  'music.provider.rateLimited': 'The music provider rate limit or quota was reached. No retry was started.',
  'music.provider.auth': 'The music provider could not authorize the request. Check the server credentials.',
  'music.provider.rejected': 'The music provider rejected the request.',
  'music.provider.unsupported': 'The music request was rejected as invalid.',
  'music.provider.failed': 'Music generation failed. No automatic retry was started.',
  'music.invalid': 'The music request was invalid.',
  'music.asset.notFound': 'The selected music asset no longer exists.',
  'music.asset.invalidType': 'The selected asset is not a music or audio asset.',
  'music.project.notFound': 'The project could not be found.'
};

// Maps a failed music API response to a friendly, non-sensitive message. Raw
// response bodies are never shown; known error codes win over server text.
export function describeMusicError(input: { status?: number; code?: string; message?: string }): string {
  if (input.code && MUSIC_ERROR_MESSAGES[input.code]) {
    return MUSIC_ERROR_MESSAGES[input.code];
  }
  if (input.status === 429) {
    return MUSIC_ERROR_MESSAGES['music.provider.rateLimited'];
  }
  if (input.status === 401 || input.status === 403) {
    return MUSIC_ERROR_MESSAGES['music.provider.auth'];
  }
  if (input.status === 409) {
    return 'The request conflicts with the current background music state.';
  }
  if (input.message && input.message.trim()) {
    return input.message;
  }
  return 'Music request failed. No automatic retry was started.';
}

export function formatMusicSeconds(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 'Unknown';
  }
  return `${value.toFixed(2)}s`;
}
