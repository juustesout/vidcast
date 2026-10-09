import { createFFmpegRuntime, type FFmpegRuntime } from './ffmpeg-runtime';
import { ProcessExecutionError, runProcess } from './ffmpeg-executor';

export interface FFprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
}

export interface FFprobeFormat {
  duration?: string;
  size?: string;
  format_name?: string;
}

export interface FFprobeResult {
  streams: FFprobeStream[];
  format?: FFprobeFormat;
}

export class FFprobeError extends Error {
  readonly stderr: string;
  readonly stdout: string;

  constructor(message: string, stdout: string, stderr: string) {
    super(message);
    this.name = 'FFprobeError';
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export async function probeMedia(filePath: string, runtime: FFmpegRuntime = createFFmpegRuntime()): Promise<FFprobeResult> {
  try {
    const result = await runProcess(runtime.ffprobePath, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      filePath
    ]);

    return JSON.parse(result.stdout || '{}') as FFprobeResult;
  } catch (error) {
    if (error instanceof ProcessExecutionError) {
      throw new FFprobeError('ffprobe failed to inspect rendered media.', error.stdout, error.stderr);
    }
    throw error;
  }
}

export function parseDurationSeconds(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
