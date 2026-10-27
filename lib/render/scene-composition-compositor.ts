import fs from 'node:fs/promises';
import path from 'node:path';

import type { RenderPlan, RenderPlanCompositionLayer, RenderPlanScene, RenderPlanSceneComposition } from '@/lib/types/render';
import type { SceneCompositionFit, SceneCompositionRect } from '@/lib/types/scene-composition';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import { presenterDecodeInputArgs, probePresenterVideo, type PresenterVideoProbe } from './presenter-codec';
import { isSafeAssetPath, sortCompositionLayers } from './scene-composition';
import { buildLogoOverlayFilter, resolveLogoGeometry } from './logo-overlay';
import { buildSceneFadeFilters } from './render-source';
import type { FFmpegRuntime } from './ffmpeg-runtime';

interface CompositionRenderOptions {
  projectId: string;
  sceneWidth: number;
  sceneHeight: number;
  sceneFps: number;
  outputPath: string;
}

export class CompositionRenderError extends Error {
  readonly code: 'INVALID_PLAN' | 'MISSING_ASSET';

  constructor(message: string, code: 'INVALID_PLAN' | 'MISSING_ASSET') {
    super(message);
    this.name = 'CompositionRenderError';
    this.code = code;
  }
}

export interface CompositionInput {
  index: number;
  layer: RenderPlanCompositionLayer;
  path: string;
}

function formatSeconds(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '0';
}

export function resolveSafeProjectAssetPath(projectId: string, localPath: string): string {
  if (!isSafeAssetPath(localPath)) {
    throw new CompositionRenderError(`Unsafe composition asset path: ${localPath}`, 'INVALID_PLAN');
  }
  const projectRoot = path.resolve(getProjectRoot(projectId));
  const absolutePath = path.resolve(projectRoot, localPath);
  if (absolutePath !== projectRoot && !absolutePath.startsWith(`${projectRoot}${path.sep}`)) {
    throw new CompositionRenderError(`Unsafe composition asset path: ${localPath}`, 'INVALID_PLAN');
  }
  return absolutePath;
}

export function buildLayerScaleFilter(rect: SceneCompositionRect, fit: SceneCompositionFit, withAlpha: boolean): string {
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (fit === 'contain') {
    const padColor = withAlpha ? '0x00000000' : 'black';
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`;
  }
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
}

function enabledLayers(composition: RenderPlanSceneComposition): RenderPlanCompositionLayer[] {
  return sortCompositionLayers(composition.layers).filter((layer) => layer.enabled !== false && Boolean(layer.assetPath));
}

export function lastFilterLabel(filters: string[]): string {
  const last = filters[filters.length - 1] ?? '';
  const match = last.match(/\[([^\]]+)\]$/);
  return match?.[1] ?? 'base0';
}

export function buildCompositionLayerFilters(options: {
  layers: CompositionInput[];
  fps: number;
  duration: number;
  presenterClipDuration?: number;
  presenterStartOffsetSeconds?: number;
  fadeFilters?: string[];
  overlayFilter?: string;
}): string[] {
  const filters: string[] = ['[0:v]format=rgba[base0]'];
  let baseLabel = 'base0';

  options.layers.forEach((input, order) => {
    const layer = input.layer;
    const inputLabel = `${input.index}:v`;
    const preparedLabel = `l${order}`;
    const nextLabel = `base${order + 1}`;
    const withAlpha = layer.type !== 'image';
    const clipFilters: string[] = ['format=rgba'];
    const timedVideo = layer.type === 'overlay' || (layer.type === 'image' && layer.mediaKind === 'video');
    const overlayStart = timedVideo ? Math.max(0, layer.startSeconds ?? 0) : 0;

    if (timedVideo) {
      const playDuration = Math.max(0.001, layer.durationSeconds ?? options.duration);
      const sourceDuration = Math.min(playDuration, Math.max(0.001, options.duration - overlayStart));
      clipFilters.push(`trim=duration=${formatSeconds(sourceDuration)}`);
    } else if (layer.mediaKind === 'video' || layer.type === 'presenter') {
      const offset = Math.max(0, options.presenterStartOffsetSeconds ?? 0);
      const clipDuration = options.presenterClipDuration ?? options.duration;
      const available = Math.max(0.001, clipDuration - offset);
      const sourceDuration = Math.min(options.duration, available);
      const pad = Math.max(0, options.duration - sourceDuration);
      clipFilters.push(`trim=start=${formatSeconds(offset)}:duration=${formatSeconds(sourceDuration)}`);
      if (pad > 0.001) {
        clipFilters.push(`tpad=stop_mode=clone:stop_duration=${formatSeconds(pad)}`);
      }
    }

    clipFilters.push(buildLayerScaleFilter(layer.rect, layer.fit, withAlpha));
    clipFilters.push('setsar=1');
    clipFilters.push('format=rgba');
    clipFilters.push(`fps=${options.fps}`);
    clipFilters.push(overlayStart > 0.001
      ? `setpts=PTS-STARTPTS+${formatSeconds(overlayStart)}/TB`
      : 'setpts=PTS-STARTPTS');

    filters.push(`[${inputLabel}]${clipFilters.join(',')}[${preparedLabel}]`);
    const overlay = timedVideo
      ? `x=${Math.round(layer.rect.x)}:y=${Math.round(layer.rect.y)}:eof_action=pass:repeatlast=0:format=auto:alpha=straight`
      : layer.type === 'presenter'
        ? `x=${Math.round(layer.rect.x)}:y=${Math.round(layer.rect.y)}:eof_action=pass:format=auto:alpha=straight`
        : `x=${Math.round(layer.rect.x)}:y=${Math.round(layer.rect.y)}:shortest=1:format=auto:alpha=straight`;
    filters.push(`[${baseLabel}][${preparedLabel}]overlay=${overlay}[${nextLabel}]`);
    baseLabel = nextLabel;
  });

  if (options.fadeFilters && options.fadeFilters.length > 0) {
    const fadeLabel = 'faded';
    filters.push(`[${baseLabel}]${options.fadeFilters.join(',')}[${fadeLabel}]`);
    baseLabel = fadeLabel;
  }

  if (options.overlayFilter) {
    const textLabel = 'text';
    filters.push(`[${baseLabel}]${options.overlayFilter}[${textLabel}]`);
  }

  return filters;
}

async function assertReadableFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    throw new CompositionRenderError(`Missing composition asset file: ${filePath}`, 'MISSING_ASSET');
  }
}

export async function buildCompositionSceneArgs(
  _plan: RenderPlan,
  scene: RenderPlanScene,
  options: CompositionRenderOptions,
  runtime: FFmpegRuntime,
  overlayFilter?: string,
  logoPath?: string
): Promise<string[]> {
  const composition = scene.composition;
  if (!composition) {
    throw new CompositionRenderError('Composition render requested without a resolved composition.', 'INVALID_PLAN');
  }

  const canvas = composition.canvas;
  const layers = enabledLayers(composition);
  const inputs: CompositionInput[] = [];
  const args: string[] = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x000000:s=${canvas.width}x${canvas.height}:r=${options.sceneFps}:d=${scene.duration}`
  ];

  let nextIndex = 1;
  for (const layer of layers) {
    if (!layer.assetPath) {
      continue;
    }
    const absolutePath = path.isAbsolute(layer.assetPath)
      ? layer.assetPath
      : resolveSafeProjectAssetPath(options.projectId, layer.assetPath);
    await assertReadableFile(absolutePath);

    let decodeArgs: string[];
    if (layer.type === 'overlay' && layer.mediaKind !== 'video') {
      const hold = Math.max(0.001, layer.durationSeconds ?? scene.duration);
      decodeArgs = ['-loop', '1', '-framerate', String(options.sceneFps), '-t', String(hold), '-i', absolutePath];
    } else if (layer.type === 'presenter' || layer.type === 'overlay' || layer.mediaKind === 'video') {
      let probe: PresenterVideoProbe | undefined;
      try {
        probe = await probePresenterVideo(absolutePath, runtime);
      } catch {
        probe = { path: absolutePath };
      }
      decodeArgs = presenterDecodeInputArgs(absolutePath, probe);
    } else {
      decodeArgs = ['-loop', '1', '-framerate', String(options.sceneFps), '-t', String(scene.duration), '-i', absolutePath];
    }

    args.push(...decodeArgs);
    inputs.push({ index: nextIndex, layer, path: absolutePath });
    nextIndex += 1;
  }

  const logo = logoPath && scene.logo
    ? {
        path: logoPath,
        geometry: resolveLogoGeometry(scene.logo, options.sceneWidth, options.sceneHeight),
        index: nextIndex
      }
    : undefined;
  if (logo) {
    args.push('-loop', '1', '-framerate', String(options.sceneFps), '-i', logo.path);
  }

  const filters = buildCompositionLayerFilters({
    layers: inputs,
    fps: options.sceneFps,
    duration: scene.duration,
    presenterClipDuration: composition.presenterClipDuration,
    presenterStartOffsetSeconds: composition.presenterStartOffsetSeconds,
    fadeFilters: buildSceneFadeFilters(scene.duration, scene.transition),
    overlayFilter
  });

  let current = lastFilterLabel(filters);
  if (logo) {
    filters.push(buildLogoOverlayFilter(logo.geometry, `${logo.index}:v`, current, 'logoout'));
    current = 'logoout';
  }

  const flatten = current === 'v' ? [] : [`[${current}]format=yuv420p[v]`];
  if (canvas.width !== options.sceneWidth || canvas.height !== options.sceneHeight) {
    flatten[0] = `[${current}]scale=${options.sceneWidth}:${options.sceneHeight}:force_original_aspect_ratio=decrease,pad=${options.sceneWidth}:${options.sceneHeight}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p[v]`;
  }
  filters.push(...flatten);

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[v]',
    '-an',
    '-t',
    String(scene.duration),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(options.sceneFps),
    '-movflags',
    '+faststart',
    options.outputPath
  );

  return args;
}
