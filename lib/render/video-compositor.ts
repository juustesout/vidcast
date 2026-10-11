import fs from 'node:fs/promises';
import path from 'node:path';

import { createFFmpegRuntime, type FFmpegRuntime } from './ffmpeg-runtime';
import { ProcessExecutionError, runProcess } from './ffmpeg-executor';
import { parseDurationSeconds, probeMedia } from './ffprobe';
import { getFinalComposeTimeoutMs } from './render-timeouts';
import { formatVolumeFilter } from './audio-mix';
import { resolveMusicFade } from './music-mix';
import type { CompositionPlan } from '@/lib/types/render';

export const COMPOSER_VERSION = 'p8';

// Every scene segment is forced to a stereo layout before concatenation. The
// concat demuxer otherwise adopts the first segment's layout and coerces the
// rest, which can silently downmix stereo to mono and clip. See
// p24-audio-mixing-timing-recon.md section 5.
export const SEGMENT_CHANNEL_LAYOUT_FILTER = 'aformat=channel_layouts=stereo';

// Shared peak limiter applied to the final audio for every composition path
// (with or without background music). `level=false` is required: FFmpeg's
// alimiter defaults to auto-level (`level=true`), which re-scales the signal
// back toward full scale and can still reach 0 dBFS (and even overshoot after
// AAC encoding). See p25.1-music-limiter-followup.md.
export const AUDIO_PEAK_LIMITER_FILTER = 'alimiter=limit=0.95:level=false';

export type VideoCompositionErrorCode = 'FFMPEG_UNAVAILABLE' | 'FFMPEG_TIMEOUT' | 'FFMPEG_FAILED' | 'OUTPUT_INVALID';

export class VideoCompositionError extends Error {
  readonly code: VideoCompositionErrorCode;
  readonly details?: string;

  constructor(message: string, code: VideoCompositionErrorCode, details?: string) {
    super(message);
    this.name = 'VideoCompositionError';
    this.code = code;
    this.details = details;
  }
}

function mapComposeProcessError(error: ProcessExecutionError): VideoCompositionError {
  const details = error.stderr || error.stdout || error.message;
  if (error.reason === 'spawn_error') {
    return new VideoCompositionError('FFmpeg could not be started for video composition.', 'FFMPEG_UNAVAILABLE', details);
  }
  if (error.reason === 'timeout') {
    return new VideoCompositionError('FFmpeg timed out while composing project video.', 'FFMPEG_TIMEOUT', details);
  }
  return new VideoCompositionError('FFmpeg failed while composing project video.', 'FFMPEG_FAILED', details);
}

interface ComposeOptions {
  outputPath: string;
  tempDir: string;
}

function formatDurationValue(seconds: number): string {
  return Number.isFinite(seconds) ? seconds.toFixed(3) : '0';
}

// Policy: produce exactly one audio track per scene segment.
// - If narration exists, narration becomes the scene audio track.
// - Otherwise, preserve embedded scene audio when present.
// - If neither exists, synthesize silence.
export function buildNormalizeArgs(
  inputPath: string,
  outputPath: string,
  plan: CompositionPlan,
  sceneDuration: number,
  options: { narrationAudioPath?: string; inputHasAudio: boolean }
): string[] {
  const duration = formatDurationValue(sceneDuration);
  const baseArgs: string[] = [
    '-y',
    '-i',
    inputPath,
  ];

  let audioFilterInput = '1:a';
  let applyNarrationVolume = false;
  if (options.narrationAudioPath) {
    baseArgs.push('-i', options.narrationAudioPath);
    applyNarrationVolume = true;
  } else if (!options.inputHasAudio) {
    baseArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  } else {
    audioFilterInput = '0:a';
  }

  const audioFilters = [
    `atrim=0:${duration}`,
    `apad=pad_dur=${duration}`,
    'aresample=48000',
    SEGMENT_CHANNEL_LAYOUT_FILTER
  ];
  if (applyNarrationVolume) {
    audioFilters.push(`volume=${formatVolumeFilter(plan.audio?.narrationVolume)}`);
  }

  const filterComplex = `[${audioFilterInput}]${audioFilters.join(',')}[aout]`;

  return [
    ...baseArgs,
    '-vf',
    `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=increase,crop=${plan.width}:${plan.height},fps=${plan.fps},format=yuv420p`,
    '-filter_complex',
    filterComplex,
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-t',
    duration,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    outputPath
  ];
}

export function buildComposeArgs(
  listPath: string,
  outputPath: string,
  plan: CompositionPlan,
  options: { limitAudio?: boolean } = {}
): string[] {
  const args: string[] = [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
  ];

  if (options.limitAudio) {
    args.push('-af', AUDIO_PEAK_LIMITER_FILTER);
  }

  args.push(
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(plan.fps),
    '-movflags',
    '+faststart',
    outputPath
  );

  return args;
}

async function normalizeInput(
  inputPath: string,
  outputPath: string,
  plan: CompositionPlan,
  runtime: FFmpegRuntime,
  sceneDuration: number,
  options: { narrationAudioPath?: string }
): Promise<void> {
  const probe = await probeMedia(inputPath, runtime);
  const inputHasAudio = probe.streams.some((stream) => stream.codec_type === 'audio');
  const args = buildNormalizeArgs(inputPath, outputPath, plan, sceneDuration, {
    narrationAudioPath: options.narrationAudioPath,
    inputHasAudio
  });

  await runProcess(runtime.ffmpegPath, args, { timeoutMs: getFinalComposeTimeoutMs() });
}

export function buildMusicMixArgs(
  concatVideoPath: string,
  musicPath: string,
  outputPath: string,
  plan: CompositionPlan
): string[] {
  const total = formatDurationValue(plan.totalDuration);
  const fade = resolveMusicFade(plan.totalDuration);
  const musicVolume = formatVolumeFilter(plan.audio?.musicVolume);

  const musicFilters = [`volume=${musicVolume}`, `atrim=0:${total}`];
  if (fade.inSeconds > 0) {
    musicFilters.push(`afade=t=in:st=0:d=${formatDurationValue(fade.inSeconds)}`);
  }
  if (fade.outSeconds > 0) {
    musicFilters.push(`afade=t=out:st=${formatDurationValue(fade.outStartSeconds)}:d=${formatDurationValue(fade.outSeconds)}`);
  }

  const filterComplex = [
    `[1:a]${musicFilters.join(',')}[music]`,
    `[0:a][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${AUDIO_PEAK_LIMITER_FILTER}[aout]`
  ].join(';');

  return [
    '-y',
    '-i',
    concatVideoPath,
    '-stream_loop',
    '-1',
    '-i',
    musicPath,
    '-filter_complex',
    filterComplex,
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-t',
    total,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    outputPath
  ];
}

async function mixMusic(concatVideoPath: string, musicPath: string, outputPath: string, plan: CompositionPlan, runtime: FFmpegRuntime): Promise<void> {
  const args = buildMusicMixArgs(concatVideoPath, musicPath, outputPath, plan);
  await runProcess(runtime.ffmpegPath, args, { timeoutMs: getFinalComposeTimeoutMs() });
}

async function composeConcat(normalizedPaths: string[], outputPath: string, plan: CompositionPlan, tempDir: string, runtime: FFmpegRuntime): Promise<void> {
  const listPath = path.join(tempDir, 'concat-list.txt');
  const listContent = normalizedPaths.map((entry) => `file '${entry.replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(listPath, `${listContent}\n`, 'utf8');

  const args = buildComposeArgs(listPath, outputPath, plan, { limitAudio: !plan.music });

  await runProcess(runtime.ffmpegPath, args, { timeoutMs: getFinalComposeTimeoutMs() });
}

async function validateOutput(outputPath: string, plan: CompositionPlan, runtime: FFmpegRuntime): Promise<{ filesize: number; duration: number }> {
  const stat = await fs.stat(outputPath).catch(() => null);
  if (!stat || stat.size <= 0) {
    throw new VideoCompositionError('Composed output is missing or empty.', 'OUTPUT_INVALID');
  }

  const probe = await probeMedia(outputPath, runtime);
  const videoStream = probe.streams.find((stream) => stream.codec_type === 'video');
  if (!videoStream || videoStream.width !== plan.width || videoStream.height !== plan.height) {
    throw new VideoCompositionError('Composed output dimensions are invalid.', 'OUTPUT_INVALID');
  }

  const audioStream = probe.streams.find((stream) => stream.codec_type === 'audio');
  if (!audioStream) {
    throw new VideoCompositionError('Composed output is missing an audio stream.', 'OUTPUT_INVALID');
  }

  const duration = parseDurationSeconds(probe.format?.duration) ?? parseDurationSeconds(videoStream.duration);
  if (typeof duration !== 'number' || Math.abs(duration - plan.totalDuration) > Math.max(0.35, 1 / Math.max(1, plan.fps))) {
    throw new VideoCompositionError('Composed output duration is invalid.', 'OUTPUT_INVALID');
  }

  const formatName = probe.format?.format_name ?? '';
  if (!formatName.includes('mp4')) {
    throw new VideoCompositionError('Composed output is not an MP4 container.', 'OUTPUT_INVALID');
  }

  return {
    filesize: stat.size,
    duration
  };
}

export class LocalFFmpegVideoCompositor {
  private readonly runtime: FFmpegRuntime;

  constructor(runtime: FFmpegRuntime = createFFmpegRuntime()) {
    this.runtime = runtime;
  }

  async compose(plan: CompositionPlan, options: ComposeOptions): Promise<{ filesize: number; duration: number }> {
    await fs.mkdir(options.tempDir, { recursive: true });

    try {
      const normalizedPaths: string[] = [];
      for (let index = 0; index < plan.items.length; index += 1) {
        const item = plan.items[index];
        const normalizedPath = path.join(options.tempDir, `normalized-${String(index + 1).padStart(3, '0')}.mp4`);
        await normalizeInput(item.renderPath, normalizedPath, plan, this.runtime, item.duration, {
          narrationAudioPath: item.narrationAudioPath
        });
        normalizedPaths.push(normalizedPath);
      }

      const concatOutputPath = plan.music ? path.join(options.tempDir, 'concatenated.mp4') : options.outputPath;
      await composeConcat(normalizedPaths, concatOutputPath, plan, options.tempDir, this.runtime);

      if (plan.music) {
        await mixMusic(concatOutputPath, plan.music.path, options.outputPath, plan, this.runtime);
      }

      return await validateOutput(options.outputPath, plan, this.runtime);
    } catch (error) {
      if (error instanceof VideoCompositionError) {
        throw error;
      }
      if (error instanceof ProcessExecutionError) {
        throw mapComposeProcessError(error);
      }
      throw error;
    } finally {
      await fs.rm(options.tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
