export interface FFmpegRuntime {
  ffmpegPath: string;
  ffprobePath: string;
}

export function createFFmpegRuntime(env: NodeJS.ProcessEnv = process.env): FFmpegRuntime {
  return {
    ffmpegPath: env.FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH?.trim() || 'ffprobe'
  };
}
