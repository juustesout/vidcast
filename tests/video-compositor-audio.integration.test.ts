import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { runProcess } from '@/lib/render/ffmpeg-executor';
import { probeMedia, type FFprobeStream } from '@/lib/render/ffprobe';
import { LocalFFmpegVideoCompositor } from '@/lib/render/video-compositor';
import type { CompositionItem, CompositionMusic, CompositionPlan } from '@/lib/types/render';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await runProcess('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

async function makeVideo(filePath: string, seconds: number, withAudio: boolean): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const args = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x223344:s=${WIDTH}x${HEIGHT}:r=${FPS}`
  ];

  if (withAudio) {
    args.push('-f', 'lavfi', '-i', 'aevalsrc=0.9*sin(2*PI*440*t)|0.9*sin(2*PI*440*t):s=48000');
  }

  args.push('-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p');

  if (withAudio) {
    args.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac');
  } else {
    args.push('-an');
  }

  args.push(filePath);
  await runProcess('ffmpeg', args);
}

async function makeNarration(filePath: string, seconds: number, mono: boolean, amplitude = 0.9): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const channel = `${amplitude}*sin(2*PI*660*t)`;
  const source = mono ? channel : `${channel}|${channel}`;
  await runProcess('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=${source}:s=48000:d=${seconds}`,
    '-c:a',
    'pcm_s16le',
    filePath
  ]);
}

async function makeMusic(filePath: string, seconds: number, amplitude = 0.9): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const channel = `${amplitude}*sin(2*PI*220*t)`;
  await runProcess('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=${channel}|${channel}:s=48000:d=${seconds}`,
    '-c:a',
    'pcm_s16le',
    filePath
  ]);
}

interface AudioProbe {
  audioStreams: number;
  videoStreams: number;
  channels?: number;
  sampleRate?: number;
  maxVolumeDb: number;
  samplePeakDb: number;
  clippedSamples: number;
}

// Exact decoded sample peak from the float PCM stream, plus a count of samples
// at/above full scale. Unlike `volumedetect` (0.1 dB rounding), this exposes the
// true sample peak and any actual clipping.
function samplePeak(filePath: string): { samplePeakDb: number; clippedSamples: number } {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', filePath, '-map', '0:a:0', '-f', 'f32le', '-'], {
    maxBuffer: 1 << 28
  });
  const buffer = result.stdout;
  const samples = Math.floor(buffer.length / 4);
  let max = 0;
  let clippedSamples = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = Math.abs(buffer.readFloatLE(index * 4));
    if (value > max) {
      max = value;
    }
    if (value >= 1) {
      clippedSamples += 1;
    }
  }
  return { samplePeakDb: 20 * Math.log10(max || 1e-12), clippedSamples };
}

async function probeAudio(filePath: string): Promise<AudioProbe> {
  const probe = await probeMedia(filePath);
  const audioStreams = probe.streams.filter((stream) => stream.codec_type === 'audio');
  const firstAudio = audioStreams[0] as (FFprobeStream & { channels?: number; sample_rate?: string }) | undefined;

  const measured = await runProcess('ffmpeg', ['-hide_banner', '-i', filePath, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-']);
  const match = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(measured.stderr);
  const peak = samplePeak(filePath);

  return {
    audioStreams: audioStreams.length,
    videoStreams: probe.streams.filter((stream) => stream.codec_type === 'video').length,
    channels: firstAudio?.channels,
    sampleRate: firstAudio?.sample_rate ? Number(firstAudio.sample_rate) : undefined,
    maxVolumeDb: match ? Number(match[1]) : Number.NaN,
    samplePeakDb: peak.samplePeakDb,
    clippedSamples: peak.clippedSamples
  };
}

// Full decode to EOF: rejects (throws) if the container/streams cannot be decoded.
async function decodeFully(filePath: string): Promise<void> {
  await runProcess('ffmpeg', ['-v', 'error', '-i', filePath, '-f', 'null', '-']);
}

function item(sceneOrder: number, renderPath: string, duration: number, narrationAudioPath?: string): CompositionItem {
  return {
    sceneId: `scene-${sceneOrder}`,
    sceneOrder,
    renderId: `render-${sceneOrder}`,
    renderPath,
    duration,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    narrationAudioPath,
    narrationAudioDuration: narrationAudioPath ? duration : undefined
  };
}

function makePlan(items: CompositionItem[], options: { narrationVolume?: number; music?: CompositionMusic } = {}): CompositionPlan {
  const totalDuration = items.reduce((sum, entry) => sum + entry.duration, 0);
  return {
    projectId: 'p25-audio',
    items,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    totalDuration,
    transition: { type: 'none' },
    audio: {
      narrationVolume: options.narrationVolume ?? 1,
      musicVolume: 0.35,
      effectsVolume: 0.2
    },
    music: options.music
  };
}

describe('video compositor audio safety integration', () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not clip when a loud narration is limited without background music', async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p25-audio-'));
    createdDirs.push(dir);
    const renderPath = path.join(dir, 'render-nosnd.mp4');
    const narrationPath = path.join(dir, 'narration-stereo.wav');
    const outputPath = path.join(dir, 'out.mp4');
    await makeVideo(renderPath, 1.5, false);
    await makeNarration(narrationPath, 1.5, false);

    const compositor = new LocalFFmpegVideoCompositor();
    await compositor.compose(makePlan([item(1, renderPath, 1.5, narrationPath)], { narrationVolume: 4 }), {
      outputPath,
      tempDir: path.join(dir, 'tmp')
    });

    const probe = await probeAudio(outputPath);
    expect(probe.videoStreams).toBe(1);
    expect(probe.audioStreams).toBe(1);
    expect(probe.channels).toBe(2);
    expect(probe.sampleRate).toBe(48000);
    expect(probe.maxVolumeDb).toBeLessThanOrEqual(-0.1);
    expect(probe.samplePeakDb).toBeLessThan(0);
    expect(probe.clippedSamples).toBe(0);
    await decodeFully(outputPath);
  }, 120000);

  it('produces consistent stereo when concatenating a mono narration segment with a stereo embedded segment', async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p25-audio-'));
    createdDirs.push(dir);
    const narrationRender = path.join(dir, 'render-nosnd.mp4');
    const embeddedRender = path.join(dir, 'render-withsnd.mp4');
    const narrationPath = path.join(dir, 'narration-mono.wav');
    const outputPath = path.join(dir, 'out.mp4');
    await makeVideo(narrationRender, 1.5, false);
    await makeVideo(embeddedRender, 1.5, true);
    await makeNarration(narrationPath, 1.5, true);

    const compositor = new LocalFFmpegVideoCompositor();
    await compositor.compose(makePlan([item(1, narrationRender, 1.5, narrationPath), item(2, embeddedRender, 1.5)]), {
      outputPath,
      tempDir: path.join(dir, 'tmp')
    });

    const probe = await probeAudio(outputPath);
    expect(probe.videoStreams).toBe(1);
    expect(probe.audioStreams).toBe(1);
    expect(probe.channels).toBe(2);
    expect(probe.maxVolumeDb).toBeLessThan(0);
    expect(probe.samplePeakDb).toBeLessThan(0);
    await decodeFully(outputPath);
  }, 120000);

  // P25.1: the music mix previously used `alimiter=limit=0.95` with FFmpeg's
  // default auto-level (`level=true`), which re-scaled near-full-scale mixes back
  // to 0 dBFS. This adversarial near-full-scale narration+music fixture must now
  // stay below full scale.
  it('keeps a single safe stereo track when narration is combined with background music', async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p25-audio-'));
    createdDirs.push(dir);
    const renderPath = path.join(dir, 'render-nosnd.mp4');
    const narrationPath = path.join(dir, 'narration-stereo.wav');
    const musicPath = path.join(dir, 'music.wav');
    const outputPath = path.join(dir, 'out.mp4');
    await makeVideo(renderPath, 1.5, false);
    await makeNarration(narrationPath, 1.5, false);
    await makeMusic(musicPath, 1);

    const compositor = new LocalFFmpegVideoCompositor();
    await compositor.compose(makePlan([item(1, renderPath, 1.5, narrationPath)], { music: { path: musicPath, duration: 1 } }), {
      outputPath,
      tempDir: path.join(dir, 'tmp')
    });

    const probe = await probeAudio(outputPath);
    expect(probe.videoStreams).toBe(1);
    expect(probe.audioStreams).toBe(1);
    expect(probe.channels).toBe(2);
    expect(probe.sampleRate).toBe(48000);
    expect(probe.maxVolumeDb).toBeLessThan(0);
    expect(probe.samplePeakDb).toBeLessThan(0);
    expect(probe.clippedSamples).toBe(0);
    await decodeFully(outputPath);
  }, 120000);

  it('keeps a safe mix for an adversarially loud narration plus music', async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p25-audio-'));
    createdDirs.push(dir);
    const renderPath = path.join(dir, 'render-nosnd.mp4');
    const narrationPath = path.join(dir, 'narration-stereo.wav');
    const musicPath = path.join(dir, 'music.wav');
    const outputPath = path.join(dir, 'out.mp4');
    await makeVideo(renderPath, 1.5, false);
    await makeNarration(narrationPath, 1.5, false);
    await makeMusic(musicPath, 1);

    const compositor = new LocalFFmpegVideoCompositor();
    await compositor.compose(
      makePlan([item(1, renderPath, 1.5, narrationPath)], { narrationVolume: 4, music: { path: musicPath, duration: 1 } }),
      { outputPath, tempDir: path.join(dir, 'tmp') }
    );

    const probe = await probeAudio(outputPath);
    expect(probe.videoStreams).toBe(1);
    expect(probe.audioStreams).toBe(1);
    expect(probe.channels).toBe(2);
    expect(probe.maxVolumeDb).toBeLessThan(0);
    expect(probe.samplePeakDb).toBeLessThan(0);
    expect(probe.clippedSamples).toBe(0);
    await decodeFully(outputPath);
  }, 120000);
});
