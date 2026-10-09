import fs from 'node:fs/promises';
import path from 'node:path';

import { projectStore } from '@/lib/storage/project-store';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import { deriveNarrationFreshness } from '@/lib/generation/narration-freshness';
import type { CompositionArtifact, CompositionPlan, CompositionResult, CompositionTransition, Project } from '@/lib/types/render';
import { createId } from '@/lib/utils/ids';
import { createCompositionPaths, ensureCompositionDirectories } from './composition-artifacts';
import { normalizeAudioMix } from './audio-mix';
import {
  MUSIC_FADE_IN_SECONDS,
  MUSIC_FADE_OUT_SECONDS,
  deriveMusicSignature,
  isMusicAsset,
  resolveSelectedMusicAsset
} from './music-mix';
import { COMPOSER_VERSION, LocalFFmpegVideoCompositor, VideoCompositionError } from './video-compositor';
import { sceneRenderService } from './scene-render-service';
import { deriveCompositionReadiness } from './render-status';
import { resolveRenderPlan } from './scene-resolver';

const activeCompositionLocks = new Set<string>();

export class CompositionServiceError extends Error {
  readonly code:
    | 'PROJECT_NOT_FOUND'
    | 'SCENE_MISSING'
    | 'SCENE_RENDER_MISSING'
    | 'RENDER_FILE_MISSING'
    | 'INCOMPATIBLE_RENDER'
    | 'COMPOSITION_FAILED'
    | 'FFMPEG_UNAVAILABLE';
  readonly details?: string;

  constructor(
    message: string,
    code:
      | 'PROJECT_NOT_FOUND'
      | 'SCENE_MISSING'
      | 'SCENE_RENDER_MISSING'
      | 'RENDER_FILE_MISSING'
      | 'INCOMPATIBLE_RENDER'
      | 'COMPOSITION_FAILED'
      | 'FFMPEG_UNAVAILABLE',
    details?: string
  ) {
    super(message);
    this.name = 'CompositionServiceError';
    this.code = code;
    this.details = details;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function asRelativeProjectPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

async function assertRenderFile(project: Project, relativePath: string): Promise<string> {
  const projectRoot = getProjectRoot(project.id);
  const absolutePath = path.resolve(projectRoot, relativePath);
  if (!absolutePath.startsWith(path.resolve(projectRoot))) {
    throw new CompositionServiceError(`Render path is unsafe: ${relativePath}`, 'INCOMPATIBLE_RENDER');
  }

  try {
    await fs.access(absolutePath);
  } catch {
    throw new CompositionServiceError(`Render file is missing on disk: ${relativePath}`, 'RENDER_FILE_MISSING');
  }

  return absolutePath;
}

async function assertAssetFile(project: Project, relativePath: string): Promise<string> {
  const projectRoot = getProjectRoot(project.id);
  const absolutePath = path.resolve(projectRoot, relativePath);
  if (!absolutePath.startsWith(path.resolve(projectRoot))) {
    throw new CompositionServiceError(`Asset path is unsafe: ${relativePath}`, 'INCOMPATIBLE_RENDER');
  }

  try {
    await fs.access(absolutePath);
  } catch {
    throw new CompositionServiceError(`Asset file is missing on disk: ${relativePath}`, 'RENDER_FILE_MISSING');
  }

  return absolutePath;
}

function resolveLatestCompletedRender(scene: Project['scenes'][number]) {
  const render = (scene.renders ?? []).find((entry) => entry.status === 'completed');
  if (!render) {
    throw new CompositionServiceError(`Scene ${scene.id} has no completed render.`, 'SCENE_RENDER_MISSING');
  }
  return render;
}

async function resolveNarrationAudioPath(project: Project, scene: Project['scenes'][number]): Promise<{ path: string; duration?: number } | undefined> {
  const narration = scene.narration;
  if (!narration?.audioAssetId) {
    return undefined;
  }

  const asset = project.assets.find((entry) => entry.id === narration.audioAssetId);
  if (!asset) {
    throw new CompositionServiceError(`Scene ${scene.id} narration asset ${narration.audioAssetId} does not exist.`, 'INCOMPATIBLE_RENDER');
  }

  const isAudio = asset.type === 'audio' || asset.type === 'music' || asset.type === 'voice';
  if (!isAudio || !asset.localPath) {
    throw new CompositionServiceError(`Scene ${scene.id} narration asset is not a valid local audio source.`, 'INCOMPATIBLE_RENDER');
  }

  if (typeof asset.duration === 'number' && asset.duration > scene.duration + 0.01) {
    throw new CompositionServiceError(`Scene ${scene.id} narration duration exceeds scene duration.`, 'INCOMPATIBLE_RENDER');
  }

  const relativePath = asRelativeProjectPath(asset.localPath);
  return {
    path: await assertAssetFile(project, relativePath),
    duration: asset.duration
  };
}

// A missing or invalid selected track must never fail an otherwise valid
// render: the composition degrades to no background music. The project
// validation report surfaces the broken reference separately.
async function resolveProjectMusic(project: Project): Promise<CompositionPlan['music']> {
  const selectedAssetId = project.music?.assetId;
  if (!selectedAssetId) {
    return undefined;
  }

  const asset = project.assets.find((entry) => entry.id === selectedAssetId);
  if (!asset || !isMusicAsset(asset) || !asset.localPath) {
    return undefined;
  }

  const relativePath = asRelativeProjectPath(asset.localPath);
  try {
    return {
      path: await assertAssetFile(project, relativePath),
      duration: asset.duration
    };
  } catch (error) {
    if (error instanceof CompositionServiceError) {
      return undefined;
    }
    throw error;
  }
}

export async function resolveCompositionPlan(project: Project, transition: CompositionTransition): Promise<CompositionPlan> {
  const orderedScenes = project.scenes.slice().sort((left, right) => left.order - right.order);

  if (orderedScenes.length === 0) {
    throw new CompositionServiceError('Project has no scenes to compose.', 'SCENE_MISSING');
  }

  const items: CompositionPlan['items'] = [];

  for (const scene of orderedScenes) {
    const render = resolveLatestCompletedRender(scene);
    const relativeOutputPath = asRelativeProjectPath(render.outputPath);
    const absolutePath = await assertRenderFile(project, relativeOutputPath);

    if (render.width !== project.renderSettings.width || render.height !== project.renderSettings.height) {
      throw new CompositionServiceError(`Scene ${scene.id} render dimensions are incompatible with project settings.`, 'INCOMPATIBLE_RENDER');
    }

    const narrationAudio = await resolveNarrationAudioPath(project, scene);

    items.push({
      sceneId: scene.id,
      sceneOrder: scene.order,
      renderId: render.renderId,
      renderPath: absolutePath,
      duration: render.duration,
      width: render.width,
      height: render.height,
      fps: render.fps,
      narrationAudioPath: narrationAudio?.path,
      narrationAudioDuration: narrationAudio?.duration
    });
  }

  const music = await resolveProjectMusic(project);

  return {
    projectId: project.id,
    items,
    width: project.renderSettings.width,
    height: project.renderSettings.height,
    fps: project.renderSettings.fps,
    totalDuration: items.reduce((sum, item) => sum + item.duration, 0),
    transition,
    audio: normalizeAudioMix(project.renderSettings.audio),
    music
  };
}

function buildCompositionArtifact(projectId: string, compositionId: string, relativeOutputPath: string, plan: CompositionPlan, project: Project, filesize: number, duration: number): CompositionArtifact {
  const audioMix = normalizeAudioMix(plan.audio);
  const selectedMusic = resolveSelectedMusicAsset(project);

  return {
    compositionId,
    projectId,
    outputPath: relativeOutputPath,
    createdAt: nowIso(),
    sceneIds: plan.items.map((item) => item.sceneId),
    inputFingerprint: {
      version: 'p10.1',
      audioMix,
      music: plan.music && selectedMusic
        ? {
            assetId: selectedMusic.id,
            musicVolume: audioMix.musicVolume,
            fadeInSeconds: MUSIC_FADE_IN_SECONDS,
            fadeOutSeconds: MUSIC_FADE_OUT_SECONDS,
            musicSignature: deriveMusicSignature(project)
          }
        : undefined,
      scenes: plan.items.map((item) => {
        const scene = project.scenes.find((entry) => entry.id === item.sceneId);
        const freshness = scene ? deriveNarrationFreshness(project, scene) : undefined;
        return {
          sceneId: item.sceneId,
          renderId: item.renderId,
          narrationSignature: freshness?.narrationSignature ?? ''
        };
      })
    },
    duration,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    renderer: 'ffmpeg',
    version: COMPOSER_VERSION,
    filesize,
    mimeType: 'video/mp4',
    transition: plan.transition
  };
}

export class VideoCompositionService {
  private readonly compositor = new LocalFFmpegVideoCompositor();

  private async ensureSceneRenders(project: Project): Promise<Project> {
    let workingProject = project;
    let readiness = deriveCompositionReadiness(workingProject, resolveRenderPlan(workingProject));

    if (readiness.blockingSceneIds.length > 0) {
      throw new CompositionServiceError('Project has scenes with blocking validation issues.', 'INCOMPATIBLE_RENDER');
    }

    for (const sceneId of [...readiness.needsSceneRenderIds, ...readiness.staleSceneIds]) {
      await sceneRenderService.renderScene(workingProject.id, sceneId);
      const refreshed = await projectStore.getProject(workingProject.id);
      if (!refreshed) {
        throw new CompositionServiceError(`Project ${workingProject.id} disappeared during scene rendering.`, 'PROJECT_NOT_FOUND');
      }
      workingProject = refreshed;
      readiness = deriveCompositionReadiness(workingProject, resolveRenderPlan(workingProject));
      if (readiness.blockingSceneIds.length > 0) {
        throw new CompositionServiceError('Project became invalid during pre-compose rendering.', 'INCOMPATIBLE_RENDER');
      }
    }

    return workingProject;
  }

  async composeProject(projectId: string, options: { transition?: CompositionTransition } = {}): Promise<CompositionResult> {
    if (activeCompositionLocks.has(projectId)) {
      throw new CompositionServiceError('Composition is already running for this project.', 'COMPOSITION_FAILED');
    }

    activeCompositionLocks.add(projectId);

    try {
      const project = await projectStore.getProject(projectId);
      if (!project) {
        throw new CompositionServiceError(`Project ${projectId} not found.`, 'PROJECT_NOT_FOUND');
      }

      const preparedProject = await this.ensureSceneRenders(project);

      const transition: CompositionTransition = options.transition ?? { type: 'none' };
      const plan = await resolveCompositionPlan(preparedProject, transition);

      const compositionId = createId('composition');
      const paths = createCompositionPaths(projectId, compositionId);
      await ensureCompositionDirectories(projectId);

      let composed;
      try {
        composed = await this.compositor.compose(plan, {
          outputPath: paths.outputPath,
          tempDir: paths.tempRoot
        });
      } catch (error) {
        if (error instanceof VideoCompositionError) {
          throw new CompositionServiceError(error.message, error.code === 'FFMPEG_UNAVAILABLE' ? 'FFMPEG_UNAVAILABLE' : 'COMPOSITION_FAILED', error.details);
        }
        throw error;
      }

      const artifact = buildCompositionArtifact(projectId, compositionId, paths.relativeOutputPath, plan, preparedProject, composed.filesize, composed.duration);

      const refreshed = await projectStore.getProject(projectId);
      if (!refreshed) {
        throw new CompositionServiceError(`Project ${projectId} disappeared during composition.`, 'PROJECT_NOT_FOUND');
      }

      refreshed.compositions = [artifact, ...(refreshed.compositions ?? [])];
      await projectStore.updateProject(refreshed);

      await fs.writeFile(paths.metadataPath, JSON.stringify(artifact, null, 2), 'utf8');

      return {
        plan,
        artifact
      };
    } finally {
      activeCompositionLocks.delete(projectId);
    }
  }
}

export const videoCompositionService = new VideoCompositionService();
