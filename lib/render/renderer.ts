import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import type { RenderPlan, RenderPlanScene, SceneRenderResult } from '@/lib/types/render';
import { createFFmpegRuntime, type FFmpegRuntime } from './ffmpeg-runtime';
import { ProcessExecutionError, runProcess } from './ffmpeg-executor';
import { parseDurationSeconds, probeMedia, FFprobeError } from './ffprobe';
import { buildSceneFadeFilters, createStillSceneSvg, sceneMotionToZoomPan } from './render-source';
import { createSceneRenderFingerprint } from './render-fingerprint';
import { getProjectRoot } from '@/lib/storage/storage-paths';

export type SceneRenderErrorCode = 'INVALID_PLAN' | 'MISSING_ASSET' | 'FFMPEG_UNAVAILABLE' | 'FFMPEG_FAILED' | 'OUTPUT_INVALID' | 'UNSUPPORTED_RENDER';

export interface SceneRenderOptions {
  projectId: string;
  sceneId: string;
  renderId: string;
  outputPath: string;
  tempDir: string;
  sceneWidth: number;
  sceneHeight: number;
  sceneFps: number;
}

export interface Renderer {
  render(plan: RenderPlan, options?: SceneRenderOptions): Promise<SceneRenderResult>;
}

export class SceneRenderError extends Error {
  readonly code: SceneRenderErrorCode;
  readonly details?: string;

  constructor(message: string, code: SceneRenderErrorCode, details?: string) {
    super(message);
    this.name = 'SceneRenderError';
    this.code = code;
    this.details = details;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function sceneSourceAssetIds(scene: RenderPlanScene): string[] {
  const ids: string[] = [];
  if (scene.source.assetId) {
    ids.push(scene.source.assetId);
  }
  return ids;
}

function safeDuration(duration: number): number {
  return Number.isFinite(duration) && duration > 0 ? duration : 1;
}

function safePathForSvg(tempDir: string, name: string): string {
  return path.join(tempDir, name.replace(/[^a-zA-Z0-9._-]+/g, '_'));
}

async function rasterizeSvgToPng(svgPath: string, outputPath: string, width: number, height: number): Promise<void> {
  try {
    await sharp(svgPath, { density: 300 })
      .resize(width, height, { fit: 'cover' })
      .png()
      .toFile(outputPath);
  } catch (error) {
    const details = error instanceof Error ? error.message : 'Unknown SVG rasterization failure.';
    throw new SceneRenderError('Failed to prepare SVG source asset for rendering.', 'INVALID_PLAN', details);
  }
}

async function assertFileExists(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    throw new SceneRenderError(`Missing render input file: ${filePath}`, 'MISSING_ASSET');
  }
}

function sourceIsVideo(scene: RenderPlanScene): boolean {
  return scene.source.kind === 'video' || scene.source.assetType === 'video';
}

function sourceDuration(scene: RenderPlanScene): number {
  return safeDuration(scene.source.duration ?? scene.duration);
}

function parseFraction(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const [numerator, denominator] = value.split('/').map((entry) => Number.parseFloat(entry));
  if (!Number.isFinite(numerator)) {
    return undefined;
  }
  if (!denominator || !Number.isFinite(denominator)) {
    return numerator;
  }
  if (denominator === 0) {
    return undefined;
  }
  return numerator / denominator;
}

async function resolveSceneSourcePath(plan: RenderPlan, scene: RenderPlanScene, options: SceneRenderOptions): Promise<string> {
  if (scene.source.kind === 'blank') {
    return 'color=black';
  }

  if (scene.source.kind === 'image' || scene.source.kind === 'video') {
    if (!scene.source.assetPath) {
      throw new SceneRenderError('Scene source is missing a resolved asset path.', 'INVALID_PLAN');
    }
    const resolvedAssetPath = path.isAbsolute(scene.source.assetPath)
      ? scene.source.assetPath
      : path.join(getProjectRoot(options.projectId), scene.source.assetPath);
    await assertFileExists(resolvedAssetPath);
    if (path.extname(resolvedAssetPath).toLowerCase() === '.svg') {
      const rasterizedPath = safePathForSvg(options.tempDir, `${options.sceneId}-${options.renderId}-source.png`);
      await rasterizeSvgToPng(resolvedAssetPath, rasterizedPath, options.sceneWidth, options.sceneHeight);
      return rasterizedPath;
    }
    return resolvedAssetPath;
  }

  const svgPath = safePathForSvg(options.tempDir, `${options.sceneId}-${options.renderId}.svg`);
  const background = plan.background?.value ?? '#020617';
  const svg = createStillSceneSvg(scene, options.sceneWidth, options.sceneHeight, background);
  await fs.writeFile(svgPath, svg, 'utf8');
  const rasterizedPath = safePathForSvg(options.tempDir, `${options.sceneId}-${options.renderId}-generated.png`);
  await rasterizeSvgToPng(svgPath, rasterizedPath, options.sceneWidth, options.sceneHeight);
  return rasterizedPath;
}

function buildStillArgs(scene: RenderPlanScene, options: SceneRenderOptions, sourcePath: string): string[] {
  const frameCount = Math.max(1, Math.round(scene.duration * options.sceneFps));
  const zoomPan = sceneMotionToZoomPan(scene, frameCount);
  const fadeFilters = buildSceneFadeFilters(scene.duration);
  const filterChain = [
    `zoompan=${zoomPan}:d=${frameCount}:s=${options.sceneWidth}x${options.sceneHeight}:fps=${options.sceneFps}`,
    ...fadeFilters,
    'format=yuv420p'
  ].join(',');

  if (sourcePath === 'color=black') {
    return [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${(scene.source.kind === 'blank' ? '#020617' : '#020617').replace('#', '0x')}:s=${options.sceneWidth}x${options.sceneHeight}:r=${options.sceneFps}`,
      '-t',
      String(scene.duration),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      options.outputPath
    ];
  }

  return [
    '-y',
    '-loop',
    '1',
    '-i',
    sourcePath,
    '-frames:v',
    String(frameCount),
    '-vf',
    filterChain,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    options.outputPath
  ];
}

function buildVideoArgs(scene: RenderPlanScene, options: SceneRenderOptions, sourcePath: string, hasAudio: boolean): string[] {
  const inputDuration = sourceDuration(scene);
  const extraDuration = Math.max(0, scene.duration - inputDuration);
  const fadeFilters = buildSceneFadeFilters(scene.duration);
  const videoFilters = [
    `trim=duration=${scene.duration}`,
    'setpts=PTS-STARTPTS',
    `tpad=stop_mode=clone:stop_duration=${extraDuration}`,
    `scale=${options.sceneWidth}:${options.sceneHeight}:force_original_aspect_ratio=increase`,
    `crop=${options.sceneWidth}:${options.sceneHeight}`,
    ...fadeFilters,
    `fps=${options.sceneFps}`,
    'format=yuv420p'
  ].join(',');

  const args = [
    '-y',
    '-i',
    sourcePath,
    '-filter_complex'
  ];

  if (hasAudio) {
    const audioFilters = [
      `atrim=duration=${scene.duration}`,
      'asetpts=PTS-STARTPTS',
      `apad=pad_dur=${extraDuration}`
    ].join(',');
    args.push(`[0:v]${videoFilters}[v];[0:a]${audioFilters}[a]`);
    args.push('-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', options.outputPath);
    return args;
  }

  args.push(`[0:v]${videoFilters}[v]`);
  args.push('-map', '[v]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', options.outputPath);
  return args;
}

function validatePlan(plan: RenderPlan): RenderPlanScene {
  if (!plan.ready) {
    throw new SceneRenderError('Render plan is not ready.', 'INVALID_PLAN');
  }
  if (plan.scenes.length !== 1) {
    throw new SceneRenderError('P5 renderer expects exactly one scene per render call.', 'INVALID_PLAN');
  }

  const scene = plan.scenes[0];
  if (scene.status !== 'renderable') {
    throw new SceneRenderError(`Scene ${scene.sceneId} is not renderable.`, 'INVALID_PLAN');
  }
  return scene;
}

async function validateOutputFile(outputPath: string, expectedWidth: number, expectedHeight: number, expectedFps: number, expectedDuration: number, runtime: FFmpegRuntime): Promise<{ filesize: number; duration: number }> {
  const stat = await fs.stat(outputPath).catch(() => null);
  if (!stat || stat.size <= 0) {
    throw new SceneRenderError('Rendered output file is missing or empty.', 'OUTPUT_INVALID');
  }

  let probe;
  try {
    probe = await probeMedia(outputPath, runtime);
  } catch (error) {
    const details = error instanceof FFprobeError ? error.stderr || error.stdout : undefined;
    throw new SceneRenderError('Rendered output could not be validated with ffprobe.', 'OUTPUT_INVALID', details);
  }

  const videoStream = probe.streams.find((stream) => stream.codec_type === 'video');
  if (!videoStream || videoStream.width !== expectedWidth || videoStream.height !== expectedHeight) {
    throw new SceneRenderError('Rendered output dimensions are invalid.', 'OUTPUT_INVALID');
  }

  const formatDuration = parseDurationSeconds(probe.format?.duration);
  const streamDuration = parseDurationSeconds(videoStream.duration);
  const actualDuration = formatDuration ?? streamDuration;
  if (typeof actualDuration !== 'number' || Math.abs(actualDuration - expectedDuration) > Math.max(0.25, 1 / Math.max(1, expectedFps))) {
    throw new SceneRenderError('Rendered output duration is invalid.', 'OUTPUT_INVALID');
  }

  const actualFps = parseFraction(videoStream.avg_frame_rate) ?? parseFraction(videoStream.r_frame_rate);
  if (typeof actualFps === 'number' && Math.abs(actualFps - expectedFps) > 0.5) {
    throw new SceneRenderError('Rendered output FPS is invalid.', 'OUTPUT_INVALID');
  }

  const codecName = videoStream.codec_name ?? '';
  const formatName = probe.format?.format_name ?? '';
  if (codecName !== 'h264' || !formatName.includes('mp4')) {
    throw new SceneRenderError('Rendered output container or codec is not the expected MP4/H.264 baseline.', 'OUTPUT_INVALID');
  }

  return {
    filesize: stat.size,
    duration: actualDuration
  };
}

export class LocalFFmpegRenderer implements Renderer {
  private readonly runtime: FFmpegRuntime;

  constructor(runtime: FFmpegRuntime = createFFmpegRuntime()) {
    this.runtime = runtime;
  }

  async render(plan: RenderPlan, options?: SceneRenderOptions) {
    const scene = validatePlan(plan);
    if (!options) {
      throw new SceneRenderError('Render options are required.', 'INVALID_PLAN');
    }

    const startedAt = nowIso();
    await fs.mkdir(options.tempDir, { recursive: true });
    const sourcePath = await resolveSceneSourcePath(plan, scene, options);

    const sourceAssetIds = sceneSourceAssetIds(scene);
    const outputPath = options.outputPath;
    const renderFingerprint = createSceneRenderFingerprint(plan, scene);

    const args = sourceIsVideo(scene)
      ? await buildVideoPipeline(scene, options, sourcePath, this.runtime)
      : buildStillArgs(scene, options, sourcePath);

    try {
      const command = this.runtime.ffmpegPath;
      await runProcess(command, args, { cwd: options.tempDir, timeoutMs: 60_000 });
      const validated = await validateOutputFile(outputPath, options.sceneWidth, options.sceneHeight, options.sceneFps, scene.duration, this.runtime);

      return {
        renderId: options.renderId,
        sceneId: options.sceneId,
        outputPath,
        createdAt: startedAt,
        width: options.sceneWidth,
        height: options.sceneHeight,
        fps: options.sceneFps,
        duration: validated.duration,
        filesize: validated.filesize,
        mimeType: 'video/mp4' as const,
        renderer: 'ffmpeg' as const,
        status: 'completed' as const,
        sourceAssetIds,
        renderFingerprint
      };
    } catch (error) {
      if (error instanceof ProcessExecutionError) {
        throw new SceneRenderError('FFmpeg failed while rendering the scene.', error.exitCode === undefined ? 'FFMPEG_UNAVAILABLE' : 'FFMPEG_FAILED', error.stderr || error.stdout || error.message);
      }
      if (error instanceof SceneRenderError) {
        throw error;
      }
      throw new SceneRenderError('Unexpected render failure.', 'FFMPEG_FAILED');
    } finally {
      await fs.rm(options.tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function buildVideoPipeline(scene: RenderPlanScene, options: SceneRenderOptions, sourcePath: string, runtime: FFmpegRuntime): Promise<string[]> {
  const probe = await probeMedia(sourcePath, runtime);
  const hasAudio = probe.streams.some((stream) => stream.codec_type === 'audio');
  return buildVideoArgs(scene, options, sourcePath, hasAudio);
}
