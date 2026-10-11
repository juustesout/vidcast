import { mediaMetadataReader } from '@/lib/media/metadata-reader';
import type { TextToSpeechFormat } from '@/lib/ai/text-to-speech/provider';

/**
 * Validates generated narration bytes before they are registered as a
 * successfully generated scene asset. A paid provider can return an empty body,
 * a truncated/HTML error page, or a container that does not match what its
 * headers claimed; none of those may be persisted and reported as success.
 */
export type DetectedAudioFormat = 'wav' | 'mp3' | 'm4a' | 'ogg' | 'flac';

export type AudioIntegrityErrorCode = 'empty' | 'unknown' | 'undecodable' | 'formatMismatch';

export class AudioIntegrityError extends Error {
  readonly code: AudioIntegrityErrorCode;

  constructor(message: string, code: AudioIntegrityErrorCode) {
    super(message);
    this.name = 'AudioIntegrityError';
    this.code = code;
  }
}

const MIME_BY_FORMAT: Record<DetectedAudioFormat, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac'
};

function hasAsciiAt(data: Buffer, offset: number, value: string): boolean {
  return data.length >= offset + value.length && data.toString('ascii', offset, offset + value.length) === value;
}

// Container sniffing by magic bytes. This is deliberately independent of the
// transport Content-Type / MIME hints, which a provider (or proxy) may set
// incorrectly.
export function sniffAudioFormat(data: Buffer): DetectedAudioFormat | undefined {
  if (hasAsciiAt(data, 0, 'RIFF') && hasAsciiAt(data, 8, 'WAVE')) {
    return 'wav';
  }
  if (hasAsciiAt(data, 0, 'fLaC')) {
    return 'flac';
  }
  if (hasAsciiAt(data, 0, 'OggS')) {
    return 'ogg';
  }
  if (hasAsciiAt(data, 0, 'ID3')) {
    return 'mp3';
  }
  if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) {
    return 'mp3';
  }
  if (hasAsciiAt(data, 4, 'ftyp')) {
    return 'm4a';
  }
  return undefined;
}

export interface AudioIntegrityResult {
  format: TextToSpeechFormat;
  mimeType: string;
  duration: number;
  filesize: number;
}

export async function validateGeneratedAudio(
  data: Buffer,
  options: { reportedFormat?: TextToSpeechFormat } = {}
): Promise<AudioIntegrityResult> {
  if (data.byteLength === 0) {
    throw new AudioIntegrityError('Provider returned empty audio.', 'empty');
  }

  const format = sniffAudioFormat(data);
  if (!format) {
    throw new AudioIntegrityError('Provider returned audio in an unrecognized or corrupt container.', 'unknown');
  }

  if (format !== 'wav' && format !== 'mp3' && format !== 'm4a') {
    throw new AudioIntegrityError(`Provider returned audio in an unsupported container (${format}).`, 'unknown');
  }

  if (options.reportedFormat && format !== options.reportedFormat) {
    throw new AudioIntegrityError(
      `Provider reported ${options.reportedFormat} audio but the returned bytes are ${format}.`,
      'formatMismatch'
    );
  }

  const mimeType = MIME_BY_FORMAT[format];
  const metadata = await mediaMetadataReader.read(data, `narration.${format}`, mimeType, 'audio');
  const duration = metadata.duration;

  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    throw new AudioIntegrityError('Provider returned audio that could not be decoded to a positive duration.', 'undecodable');
  }

  return {
    format,
    mimeType,
    duration,
    filesize: data.byteLength
  };
}
