import { describe, expect, it } from 'vitest';

import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';

describe('FFmpeg runtime', () => {
  it('uses explicit environment overrides when present', () => {
    const runtime = createFFmpegRuntime({ FFMPEG_PATH: 'custom-ffmpeg', FFPROBE_PATH: 'custom-ffprobe', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    expect(runtime.ffmpegPath).toBe('custom-ffmpeg');
    expect(runtime.ffprobePath).toBe('custom-ffprobe');
  });
});
