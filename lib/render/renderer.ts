import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import type { RenderPlan, RenderPlanScene, RenderPlanStudioOverlay, SceneRenderResult } from '@/lib/types/render';
import { createFFmpegRuntime, type FFmpegRuntime } from './ffmpeg-runtime';
import { ProcessExecutionError, runFfmpeg } from './ffmpeg-executor';
import { parseDurationSeconds, probeMedia, FFprobeError } from './ffprobe';
import { buildSceneFadeFilters, createStillSceneSvg, sceneMotionToZoomPan } from './render-source';
import { buildVideoScaleFilter, DEFAULT_RENDER_FIT } from './fit-policy';
import type { RenderFit } from '@/lib/types/render';
import { createSceneRenderFingerprint } from './render-fingerprint';
import { sceneDurationMatches } from './scene-timing';
import { getSceneRenderTimeoutMs } from './render-timeouts';
import { buildSceneOverlayFilter } from './text-overlay';
import { buildSceneKaraokeFilter } from './karaoke';
import { buildLogoOverlayFilter, resolveLogoGeometry } from './logo-overlay';
import { buildStudioOverlayFilter, createStudioOverlaySvg } from './studio-overlay';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import { buildCompositionSceneArgs, CompositionRenderError } from './scene-composition-compositor';
import { fetchAllowedHttps, OutboundUrlError, STOCK_HOTLINK_ALLOWED_HOSTS } from '@/lib/security/outbound-url';

export type SceneRenderErrorCode = 'INVALID_PLAN' | 'MISSING_ASSET' | 'FFMPEG_UNAVAILABLE' | 'FFMPEG_TIMEOUT' | 'FFMPEG_FAILED' | 'OUTPUT_INVALID' | 'UNSUPPORTED_RENDER';

export interface SceneRenderOptions {
  projectId: string;
  sceneId: string;
  renderId: string;
  outputPath: string;
  tempDir: string;
  sceneWidth: number;
  sceneHeight: number;
  sceneFps: number;
  // Scale policy for non-canvas-aspect sources. Defaults to `cover` (the
  // historical center-crop) so existing renders are unchanged.
  fit?: RenderFit;
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
  if (scene.logo?.assetId) {
    ids.push(scene.logo.assetId);
  }
  for (const layer of scene.composition?.layers ?? []) {
    if (layer.assetId) {
      ids.push(layer.assetId);
    }
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

export async function fetchRemoteSourceToFile(url: string, targetDir: string, baseName: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getSceneRenderTimeoutMs());
  let response: Response;
  try {
    response = await fetchAllowedHttps(url, STOCK_HOTLINK_ALLOWED_HOSTS, { signal: controller.signal });
  } catch (error) {
    if (error instanceof OutboundUrlError) {
      throw new SceneRenderError('Remote render source URL is not allowed.', 'MISSING_ASSET', error.message);
    }
    throw new SceneRenderError(
      'Failed to fetch remote render source.',
      'MISSING_ASSET',
      error instanceof Error ? error.message : undefined
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new SceneRenderError(`Remote render source returned HTTP ${response.status}.`, 'MISSING_ASSET');
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const extension = contentType.includes('png')
    ? 'png'
    : contentType.includes('webp')
      ? 'webp'
      : contentType.includes('gif')
        ? 'gif'
        : 'jpg';
  const target = safePathForSvg(targetDir, `${baseName}.${extension}`);
  const arrayBuffer = await response.arrayBuffer();
  await fs.writeFile(target, Buffer.from(arrayBuffer));
  return target;
}

async function resolveSceneSourcePath(plan: RenderPlan, scene: RenderPlanScene, options: SceneRenderOptions): Promise<string> {
  // When a studio frames the scene, still graphics are authored at the size of
  // the visible screen instead of the full canvas. The renderer pads/positions
  // that content inside the studio cutout, so titles and cards are centered in
  // the screen rather than behind the studio frame.
  const contentWidth = plan.studio?.screen.width ?? options.sceneWidth;
  const contentHeight = plan.studio?.screen.height ?? options.sceneHeight;

  if (scene.source.kind === 'blank') {
    return 'color=black';
  }

  if (scene.source.remoteUrl && !scene.source.assetPath) {
    return fetchRemoteSourceToFile(scene.source.remoteUrl, options.tempDir, `${options.sceneId}-${options.renderId}-remote`);
  }

  if (scene.source.kind === 'image' || scene.source.kind === 'video' || (scene.source.kind === 'html' && scene.source.assetPath)) {
    if (!scene.source.assetPath) {
      throw new SceneRenderError('Scene source is missing a resolved asset path.', 'INVALID_PLAN');
    }
    const resolvedAssetPath = path.isAbsolute(scene.source.assetPath)
      ? scene.source.assetPath
      : path.join(getProjectRoot(options.projectId), scene.source.assetPath);
    await assertFileExists(resolvedAssetPath);
    if (path.extname(resolvedAssetPath).toLowerCase() === '.svg') {
      const rasterizedPath = safePathForSvg(options.tempDir, `${options.sceneId}-${options.renderId}-source.png`);
      await rasterizeSvgToPng(resolvedAssetPath, rasterizedPath, contentWidth, contentHeight);
      return rasterizedPath;
    }
    return resolvedAssetPath;
  }

  const svgPath = safePathForSvg(options.tempDir, `${options.sceneId}-${options.renderId}.svg`);
  const background = plan.background?.value ?? '#020617';
  const svg = createStillSceneSvg(scene, contentWidth, contentHeight, background);
  await fs.writeFile(svgPath, svg, 'utf8');
  const rasterizedPath = safePathForSvg(options.tempDir, `${options.sceneId}-${options.renderId}-generated.png`);
  await rasterizeSvgToPng(svgPath, rasterizedPath, contentWidth, contentHeight);
  return rasterizedPath;
}

const DIRECT_LOGO_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

// Logo assets are optional: a missing or unreadable file must never fail the
// underlying scene render. Project validation reports the broken reference;
// the renderer degrades to a logo-free scene. PNG/WebP alpha is preserved, and
// SVG or less common formats are rasterized to a transparent PNG first.
async function resolveSceneLogoPath(scene: RenderPlanScene, options: SceneRenderOptions): Promise<string | undefined> {
  if (!scene.logo?.assetPath) {
    return undefined;
  }

  const absolutePath = path.isAbsolute(scene.logo.assetPath)
    ? scene.logo.assetPath
    : path.join(getProjectRoot(options.projectId), scene.logo.assetPath);

  try {
    await fs.access(absolutePath);
    const metadata = await sharp(absolutePath, { density: 300 }).metadata();
    if (!metadata.width || !metadata.height) {
      return undefined;
    }

    const extension = path.extname(absolutePath).toLowerCase();
    if (DIRECT_LOGO_EXTENSIONS.has(extension)) {
      return absolutePath;
    }

    const rasterizedPath = safePathForSvg(options.tempDir, `${options.sceneId}-${options.renderId}-logo.png`);
    await sharp(absolutePath, { density: 300 })
      .resize({ width: 2048, withoutEnlargement: true })
      .png()
      .toFile(rasterizedPath);
    return rasterizedPath;
  } catch {
    return undefined;
  }
}

function logoInputArgs(logoPath: string, fps: number): string[] {
  return ['-loop', '1', '-framerate', String(fps), '-i', logoPath];
}

async function resolveStudioOverlayPath(plan: RenderPlan, options: SceneRenderOptions): Promise<string | undefined> {
  if (!plan.studio) {
    return undefined;
  }

  const svg = createStudioOverlaySvg(plan.studio, options.sceneWidth, options.sceneHeight);
  const pngPath = safePathForSvg(options.tempDir, `${options.sceneId}-${options.renderId}-studio.png`);
  await sharp(Buffer.from(svg), { density: 300 })
    .resize(options.sceneWidth, options.sceneHeight, { fit: 'fill' })
    .png()
    .toFile(pngPath);
  return pngPath;
}

function buildStudioStillArgs(
  scene: RenderPlanScene,
  options: SceneRenderOptions,
  sourcePath: string,
  overlayFilter: string | undefined,
  logoPath: string | undefined,
  studioPath: string,
  studio: RenderPlanStudioOverlay
): string[] {
  const frameCount = Math.max(1, Math.round(scene.duration * options.sceneFps));
  const contentWidth = studio.screen.width;
  const contentHeight = studio.screen.height;
  const logo = logoPath && scene.logo
    ? {
        path: logoPath,
        geometry: resolveLogoGeometry(scene.logo, options.sceneWidth, options.sceneHeight)
      }
    : undefined;
  const inputArgs = [...logoInputArgs(studioPath, options.sceneFps)];
  const parts: string[] = [];
  let currentLabel: string;

  if (sourcePath === 'color=black') {
    parts.push('[0:v]null[base]');
    currentLabel = 'base';
  } else {
    const zoomPan = sceneMotionToZoomPan(scene, frameCount);
    const fadeFilters = buildSceneFadeFilters(scene.duration);
    const fitFilter = buildVideoScaleFilter(contentWidth, contentHeight, options.fit ?? DEFAULT_RENDER_FIT);
    const padFilter = `pad=${options.sceneWidth}:${options.sceneHeight}:${studio.screen.x}:${studio.screen.y}:color=black`;
    parts.push(`[0:v]${[fitFilter, `zoompan=${zoomPan}:d=${frameCount}:s=${contentWidth}x${contentHeight}:fps=${options.sceneFps}`, ...fadeFilters, padFilter].join(',')}[pre]`);
    currentLabel = 'pre';
  }

  parts.push(buildStudioOverlayFilter('1:v', currentLabel, 'studioout'));
  currentLabel = 'studioout';

  if (overlayFilter) {
    parts.push(`[${currentLabel}]${overlayFilter}[textout]`);
    currentLabel = 'textout';
  }

  if (logo) {
    inputArgs.push(...logoInputArgs(logo.path, options.sceneFps));
    parts.push(buildLogoOverlayFilter(logo.geometry, '2:v', currentLabel, 'logoout'));
    currentLabel = 'logoout';
  }

  parts.push(`[${currentLabel}]format=yuv420p[v]`);

  const outputArgs = ['-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', options.outputPath];

  if (sourcePath === 'color=black') {
    const background = '#020617'.replace('#', '0x');
    return [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${background}:s=${options.sceneWidth}x${options.sceneHeight}:r=${options.sceneFps}`,
      ...inputArgs,
      '-filter_complex',
      parts.join(';'),
      '-t',
      String(scene.duration),
      ...outputArgs
    ];
  }

  return [
    '-y',
    '-loop',
    '1',
    '-i',
    sourcePath,
    ...inputArgs,
    '-frames:v',
    String(frameCount),
    '-filter_complex',
    parts.join(';'),
    ...outputArgs
  ];
}

function buildStudioVideoArgs(
  scene: RenderPlanScene,
  options: SceneRenderOptions,
  sourcePath: string,
  hasAudio: boolean,
  overlayFilter: string | undefined,
  logoPath: string | undefined,
  studioPath: string,
  studio: RenderPlanStudioOverlay
): string[] {
  const contentWidth = studio.screen.width;
  const contentHeight = studio.screen.height;
  const inputDuration = sourceDuration(scene);
  const extraDuration = Math.max(0, scene.duration - inputDuration);
  const fadeFilters = buildSceneFadeFilters(scene.duration);
  const videoFilters = [
    `trim=duration=${scene.duration}`,
    'setpts=PTS-STARTPTS',
    `tpad=stop_mode=clone:stop_duration=${extraDuration}`,
    buildVideoScaleFilter(contentWidth, contentHeight, options.fit ?? DEFAULT_RENDER_FIT),
    ...fadeFilters,
    `fps=${options.sceneFps}`,
    `pad=${options.sceneWidth}:${options.sceneHeight}:${studio.screen.x}:${studio.screen.y}:color=black`
  ];
  const logo = logoPath && scene.logo
    ? {
        path: logoPath,
        geometry: resolveLogoGeometry(scene.logo, options.sceneWidth, options.sceneHeight)
      }
    : undefined;
  const inputArgs = [...logoInputArgs(studioPath, options.sceneFps)];
  const parts = [`[0:v]${videoFilters.join(',')}[pre]`];
  let currentLabel = 'pre';

  parts.push(buildStudioOverlayFilter('1:v', currentLabel, 'studioout'));
  currentLabel = 'studioout';

  if (overlayFilter) {
    parts.push(`[${currentLabel}]${overlayFilter}[textout]`);
    currentLabel = 'textout';
  }

  if (logo) {
    inputArgs.push(...logoInputArgs(logo.path, options.sceneFps));
    parts.push(buildLogoOverlayFilter(logo.geometry, '2:v', currentLabel, 'logoout'));
    currentLabel = 'logoout';
  }

  parts.push(`[${currentLabel}]format=yuv420p[v]`);

  const args = ['-y', '-i', sourcePath, ...inputArgs, '-filter_complex'];

  if (hasAudio) {
    const audioFilters = [
      `atrim=duration=${scene.duration}`,
      'asetpts=PTS-STARTPTS',
      `apad=pad_dur=${extraDuration}`
    ].join(',');
    args.push(`${parts.join(';')};[0:a]${audioFilters}[a]`);
    args.push('-map', '[v]', '-map', '[a]', '-t', String(scene.duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', options.outputPath);
    return args;
  }

  args.push(parts.join(';'));
  args.push('-map', '[v]', '-an', '-t', String(scene.duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', options.outputPath);
  return args;
}

function buildStillArgs(
  scene: RenderPlanScene,
  options: SceneRenderOptions,
  sourcePath: string,
  overlayFilter?: string,
  logoPath?: string,
  studioPath?: string,
  studio?: RenderPlanStudioOverlay
): string[] {
  if (studioPath && studio) {
    return buildStudioStillArgs(scene, options, sourcePath, overlayFilter, logoPath, studioPath, studio);
  }

  const frameCount = Math.max(1, Math.round(scene.duration * options.sceneFps));
  const zoomPan = sceneMotionToZoomPan(scene, frameCount);
  const fadeFilters = buildSceneFadeFilters(scene.duration);
  // Normalize the still source to the canvas using the same scale policy as the
  // video path (cover = center-crop, contain = letterbox). For sources already
  // rasterized to the canvas size this is a no-op; for a mismatched still image
  // it prevents the silent stretch that zoompan would otherwise apply.
  const fitFilter = buildVideoScaleFilter(options.sceneWidth, options.sceneHeight, options.fit ?? DEFAULT_RENDER_FIT);
  const baseFilters = [
    fitFilter,
    `zoompan=${zoomPan}:d=${frameCount}:s=${options.sceneWidth}x${options.sceneHeight}:fps=${options.sceneFps}`,
    ...fadeFilters,
    ...(overlayFilter ? [overlayFilter] : [])
  ];
  const logo = logoPath && scene.logo
    ? {
        path: logoPath,
        geometry: resolveLogoGeometry(scene.logo, options.sceneWidth, options.sceneHeight)
      }
    : undefined;

  if (sourcePath === 'color=black') {
    const background = '#020617'.replace('#', '0x');
    if (logo) {
      const complex = `[0:v]${overlayFilter ?? 'null'}[base];${buildLogoOverlayFilter(logo.geometry, '1:v', 'base', 'logoout')};[logoout]format=yuv420p[v]`;
      return [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${background}:s=${options.sceneWidth}x${options.sceneHeight}:r=${options.sceneFps}`,
        ...logoInputArgs(logo.path, options.sceneFps),
        '-filter_complex',
        complex,
        '-map',
        '[v]',
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

    const args = [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${background}:s=${options.sceneWidth}x${options.sceneHeight}:r=${options.sceneFps}`,
      '-t',
      String(scene.duration)
    ];
    if (overlayFilter) {
      args.push('-vf', overlayFilter);
    }
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', options.outputPath);
    return args;
  }

  if (logo) {
    const complex = `[0:v]${baseFilters.join(',')}[base];${buildLogoOverlayFilter(logo.geometry, '1:v', 'base', 'logoout')};[logoout]format=yuv420p[v]`;
    return [
      '-y',
      '-loop',
      '1',
      '-i',
      sourcePath,
      ...logoInputArgs(logo.path, options.sceneFps),
      '-frames:v',
      String(frameCount),
      '-filter_complex',
      complex,
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      options.outputPath
    ];
  }

  const filterChain = [...baseFilters, 'format=yuv420p'].join(',');
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

function buildVideoArgs(
  scene: RenderPlanScene,
  options: SceneRenderOptions,
  sourcePath: string,
  hasAudio: boolean,
  overlayFilter?: string,
  logoPath?: string,
  studioPath?: string,
  studio?: RenderPlanStudioOverlay
): string[] {
  if (studioPath && studio) {
    return buildStudioVideoArgs(scene, options, sourcePath, hasAudio, overlayFilter, logoPath, studioPath, studio);
  }

  const inputDuration = sourceDuration(scene);
  const extraDuration = Math.max(0, scene.duration - inputDuration);
  const fadeFilters = buildSceneFadeFilters(scene.duration);
  const videoFilters = [
    `trim=duration=${scene.duration}`,
    'setpts=PTS-STARTPTS',
    `tpad=stop_mode=clone:stop_duration=${extraDuration}`,
    buildVideoScaleFilter(options.sceneWidth, options.sceneHeight, options.fit ?? DEFAULT_RENDER_FIT),
    ...fadeFilters,
    `fps=${options.sceneFps}`,
    ...(overlayFilter ? [overlayFilter] : [])
  ];
  const logo = logoPath && scene.logo
    ? {
        path: logoPath,
        geometry: resolveLogoGeometry(scene.logo, options.sceneWidth, options.sceneHeight)
      }
    : undefined;

  if (logo) {
    const videoChain = `[0:v]${videoFilters.join(',')}[base];${buildLogoOverlayFilter(logo.geometry, '1:v', 'base', 'logoout')};[logoout]format=yuv420p[v]`;
    const args = ['-y', '-i', sourcePath, ...logoInputArgs(logo.path, options.sceneFps), '-filter_complex'];

    if (hasAudio) {
      const audioFilters = [
        `atrim=duration=${scene.duration}`,
        'asetpts=PTS-STARTPTS',
        `apad=pad_dur=${extraDuration}`
      ].join(',');
      args.push(`${videoChain};[0:a]${audioFilters}[a]`);
      args.push('-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', options.outputPath);
      return args;
    }

    args.push(videoChain);
    args.push('-map', '[v]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', options.outputPath);
    return args;
  }

  const filterChain = [...videoFilters, 'format=yuv420p'].join(',');
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
    args.push(`[0:v]${filterChain}[v];[0:a]${audioFilters}[a]`);
    args.push('-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', options.outputPath);
    return args;
  }

  args.push(`[0:v]${filterChain}[v]`);
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

function mapSceneProcessError(error: ProcessExecutionError): SceneRenderError {
  const details = error.stderr || error.stdout || error.message;
  if (error.reason === 'spawn_error') {
    return new SceneRenderError('FFmpeg could not be started for scene rendering.', 'FFMPEG_UNAVAILABLE', details);
  }
  if (error.reason === 'timeout') {
    return new SceneRenderError('FFmpeg timed out while rendering the scene.', 'FFMPEG_TIMEOUT', details);
  }
  return new SceneRenderError('FFmpeg failed while rendering the scene.', 'FFMPEG_FAILED', details);
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
    if (error instanceof FFprobeError) {
      const details = error.stderr || error.stdout || error.message;
      if (error.reason === 'spawn_error') {
        throw new SceneRenderError('ffprobe could not be started to validate the rendered output.', 'FFMPEG_UNAVAILABLE', details);
      }
      if (error.reason === 'timeout') {
        throw new SceneRenderError('ffprobe timed out while validating the rendered output.', 'FFMPEG_TIMEOUT', details);
      }
      throw new SceneRenderError('Rendered output could not be validated with ffprobe.', 'OUTPUT_INVALID', details);
    }
    throw error;
  }

  const videoStream = probe.streams.find((stream) => stream.codec_type === 'video');
  if (!videoStream || videoStream.width !== expectedWidth || videoStream.height !== expectedHeight) {
    throw new SceneRenderError('Rendered output dimensions are invalid.', 'OUTPUT_INVALID');
  }

  const formatDuration = parseDurationSeconds(probe.format?.duration);
  const streamDuration = parseDurationSeconds(videoStream.duration);
  const actualDuration = formatDuration ?? streamDuration;
  if (typeof actualDuration !== 'number' || !sceneDurationMatches(actualDuration, expectedDuration, expectedFps)) {
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
    const sourceAssetIds = sceneSourceAssetIds(scene);
    const outputPath = options.outputPath;
    const renderFingerprint = createSceneRenderFingerprint(plan, scene);

    // Everything from scratch-directory creation onward runs inside the
    // try/finally so the per-render temp directory (source rasters, overlay
    // text files) is removed on success and on every failure path.
    await fs.mkdir(options.tempDir, { recursive: true });

    try {
      const logoPath = await resolveSceneLogoPath(scene, options);
      const overlayFilter = await buildSceneOverlayFilter(scene, {
        width: options.sceneWidth,
        height: options.sceneHeight,
        duration: scene.duration,
        tempDir: options.tempDir,
        centerX: scene.composition
          ? undefined
          : plan.studio
            ? plan.studio.screen.x + plan.studio.screen.width / 2
            : undefined
      });
      const karaokeFilter = await buildSceneKaraokeFilter(scene, {
        width: options.sceneWidth,
        height: options.sceneHeight,
        duration: scene.duration,
        tempDir: options.tempDir,
        subtitlesEnabled: plan.subtitlesEnabled
      });
      const combinedOverlayFilter = [overlayFilter, karaokeFilter].filter(Boolean).join(',') || undefined;

      let args: string[];
      if (scene.composition) {
        args = await buildCompositionSceneArgs(plan, scene, options, this.runtime, combinedOverlayFilter, logoPath);
      } else {
        const sourcePath = await resolveSceneSourcePath(plan, scene, options);
        const studioPath = await resolveStudioOverlayPath(plan, options);
        args = sourceIsVideo(scene)
          ? await buildVideoPipeline(scene, options, sourcePath, this.runtime, combinedOverlayFilter, logoPath, studioPath, plan.studio)
          : buildStillArgs(scene, options, sourcePath, combinedOverlayFilter, logoPath, studioPath, plan.studio);
      }

      const command = this.runtime.ffmpegPath;
      await runFfmpeg(command, args, { cwd: options.tempDir, timeoutMs: getSceneRenderTimeoutMs() }, 'scene_render');
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
        throw mapSceneProcessError(error);
      }
      if (error instanceof CompositionRenderError) {
        throw new SceneRenderError(error.message, error.code);
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

async function buildVideoPipeline(
  scene: RenderPlanScene,
  options: SceneRenderOptions,
  sourcePath: string,
  runtime: FFmpegRuntime,
  overlayFilter?: string,
  logoPath?: string,
  studioPath?: string,
  studio?: RenderPlanStudioOverlay
): Promise<string[]> {
  const probe = await probeMedia(sourcePath, runtime);
  const hasAudio = probe.streams.some((stream) => stream.codec_type === 'audio');
  return buildVideoArgs(scene, options, sourcePath, hasAudio, overlayFilter, logoPath, studioPath, studio);
}
