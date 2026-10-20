import path from 'node:path';

import { createFFmpegRuntime, type FFmpegRuntime } from './ffmpeg-runtime';
import { runProcess } from './ffmpeg-executor';
import { getProbeTimeoutMs } from './render-timeouts';

export const PRESENTER_VP9_DECODER = 'libvpx-vp9';

export interface PresenterVideoProbe {
  path?: string;
  codecName?: string;
  pixFmt?: string;
  formatName?: string;
  alphaMode?: string;
}

function lower(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function presenterVp9DecoderName(probe: PresenterVideoProbe): 'libvpx-vp9' | 'libvpx' | undefined {
  const codec = lower(probe.codecName);
  if (codec === 'vp8') {
    return 'libvpx';
  }
  if (codec === 'vp9') {
    return PRESENTER_VP9_DECODER;
  }
  if (codec && codec !== 'vp8' && codec !== 'vp9') {
    return undefined;
  }
  if (presenterNeedsAlphaCapableVp9Decoder(probe)) {
    return PRESENTER_VP9_DECODER;
  }
  return undefined;
}

export function presenterNeedsAlphaCapableVp9Decoder(probe: PresenterVideoProbe): boolean {
  const codec = lower(probe.codecName);
  const format = lower(probe.formatName);
  const ext = path.extname(probe.path ?? '').toLowerCase();
  const alphaMode = lower(probe.alphaMode);

  if (codec === 'h264' || codec === 'hevc' || codec === 'av1') {
    return false;
  }
  if (codec === 'vp9' || codec === 'vp8') {
    return true;
  }
  if (alphaMode === '1' || alphaMode === 'true') {
    return true;
  }
  if (ext === '.webm' || format.includes('webm')) {
    return true;
  }
  return false;
}

export function presenterDecodeInputArgs(clipPath: string, probe?: PresenterVideoProbe): string[] {
  const decoder = presenterVp9DecoderName({ ...probe, path: probe?.path ?? clipPath });
  if (decoder) {
    return ['-c:v', decoder, '-i', clipPath];
  }
  return ['-i', clipPath];
}

export async function probePresenterVideo(
  filePath: string,
  runtime: FFmpegRuntime = createFFmpegRuntime()
): Promise<PresenterVideoProbe> {
  const result = await runProcess(
    runtime.ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
    { timeoutMs: getProbeTimeoutMs() }
  );
  const parsed = JSON.parse(result.stdout || '{}') as {
    streams?: Array<Record<string, unknown>>;
    format?: { format_name?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video') ?? {};
  const tags = video.tags && typeof video.tags === 'object' ? video.tags as Record<string, unknown> : {};
  const alphaMode = typeof tags.alpha_mode === 'string'
    ? tags.alpha_mode
    : typeof tags.ALPHA_MODE === 'string'
      ? tags.ALPHA_MODE
      : undefined;

  return {
    path: filePath,
    codecName: typeof video.codec_name === 'string' ? video.codec_name : undefined,
    pixFmt: typeof video.pix_fmt === 'string' ? video.pix_fmt : undefined,
    formatName: parsed.format?.format_name,
    alphaMode
  };
}
