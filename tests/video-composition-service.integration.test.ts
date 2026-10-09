import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runProcess } from '@/lib/render/ffmpeg-executor';
import { videoCompositionService } from '@/lib/render/video-composition-service';
import { projectStore } from '@/lib/storage/project-store';
import { getProjectRendersRoot, getProjectRoot } from '@/lib/storage/storage-paths';

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await runProcess('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

async function createClip(filePath: string, color: string, durationSeconds: number, width: number, height: number, fps: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await runProcess('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${width}x${height}:r=${fps}`,
    '-t',
    String(durationSeconds),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    filePath
  ]);
}

async function createTone(filePath: string, frequency: number, durationSeconds: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await runProcess('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:sample_rate=48000`,
    '-t',
    String(durationSeconds),
    '-c:a',
    'aac',
    filePath
  ]);
}

describe('video composition service integration', () => {
  const createdProjectIds: string[] = [];

  afterEach(async () => {
    for (const id of createdProjectIds) {
      await fs.rm(getProjectRoot(id), { recursive: true, force: true });
    }
  });

  it('composes multiple scene renders into one final mp4', async () => {
    if (!(await ffmpegAvailable())) {
      return;
    }

    const project = await projectStore.createProject({ title: 'Compose Integration', durationTarget: 6, fps: 30 });
    createdProjectIds.push(project.id);

    const now = new Date().toISOString();
    const targetWidth = project.renderSettings.width;
    const targetHeight = project.renderSettings.height;
    const targetFps = project.renderSettings.fps;

    const sceneOne = {
      ...project.scenes[0],
      id: 'scene-1',
      order: 1,
      duration: 1,
      type: 'blank' as const,
      visual: { kind: 'blank' as const },
      narration: {
        text: 'Scene one narration',
        audioAssetId: 'audio-1',
        status: 'generated' as const
      },
      renders: [
        {
          renderId: 'render-1',
          outputPath: 'renders/scene-1-render.mp4',
          createdAt: now,
          width: targetWidth,
          height: targetHeight,
          fps: targetFps,
          duration: 1,
          filesize: 0,
          mimeType: 'video/mp4' as const,
          renderer: 'ffmpeg' as const,
          status: 'completed' as const
        }
      ]
    };

    const sceneTwo = {
      ...project.scenes[0],
      id: 'scene-2',
      order: 2,
      duration: 1,
      type: 'blank' as const,
      visual: { kind: 'blank' as const },
      narration: {
        text: 'Scene two narration',
        audioAssetId: 'audio-2',
        status: 'generated' as const
      },
      renders: [
        {
          renderId: 'render-2',
          outputPath: 'renders/scene-2-render.mp4',
          createdAt: now,
          width: targetWidth,
          height: targetHeight,
          fps: targetFps,
          duration: 1,
          filesize: 0,
          mimeType: 'video/mp4' as const,
          renderer: 'ffmpeg' as const,
          status: 'completed' as const
        }
      ]
    };

    project.scenes = [sceneOne, sceneTwo];
    project.assets.push(
      {
        id: 'audio-1',
        type: 'audio',
        status: 'available',
        provenance: 'generated',
        filename: 'scene-1-narration.m4a',
        localPath: 'assets/scene-1-narration.m4a',
        mimeType: 'audio/mp4',
        duration: 1,
        filesize: 0,
        metadata: {},
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'audio-2',
        type: 'audio',
        status: 'available',
        provenance: 'generated',
        filename: 'scene-2-narration.m4a',
        localPath: 'assets/scene-2-narration.m4a',
        mimeType: 'audio/mp4',
        duration: 1,
        filesize: 0,
        metadata: {},
        createdAt: now,
        updatedAt: now
      }
    );
    await projectStore.updateProject(project);

    const rendersRoot = getProjectRendersRoot(project.id);
    const assetsRoot = path.join(getProjectRoot(project.id), 'assets');
    await createClip(path.join(rendersRoot, 'scene-1-render.mp4'), '0x334155', 1, targetWidth, targetHeight, targetFps);
    await createClip(path.join(rendersRoot, 'scene-2-render.mp4'), '0x0f172a', 1, targetWidth, targetHeight, targetFps);
    await createTone(path.join(assetsRoot, 'scene-1-narration.m4a'), 550, 1);
    await createTone(path.join(assetsRoot, 'scene-2-narration.m4a'), 770, 1);

    const result = await videoCompositionService.composeProject(project.id);
    expect(result.plan.items).toHaveLength(2);
    expect(result.artifact.sceneIds).toEqual(['scene-1', 'scene-2']);
    expect(result.artifact.outputPath.startsWith('renders/compositions/final-')).toBe(true);

    const finalPath = path.join(getProjectRoot(project.id), result.artifact.outputPath);
    const stat = await fs.stat(finalPath);
    expect(stat.size).toBeGreaterThan(0);

    const persisted = await projectStore.getProject(project.id);
    expect((persisted?.compositions ?? []).length).toBeGreaterThan(0);
  }, 180000);
});
