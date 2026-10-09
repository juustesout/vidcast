import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveCompositionPlan, CompositionServiceError } from '@/lib/render/video-composition-service';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import type { Project } from '@/lib/types/render';

function createProject(projectId: string): Project {
  const now = new Date().toISOString();
  return {
    id: projectId,
    title: 'Composition Plan Test',
    description: 'desc',
    durationTarget: 10,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1280,
      height: 720,
      background: { type: 'color', value: '#020617' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    assets: [],
    references: [],
    compositions: [],
    scenes: [
      {
        id: 'scene-2',
        order: 2,
        duration: 2,
        type: 'blank',
        visual: { kind: 'blank' },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: '',
        renders: []
      },
      {
        id: 'scene-1',
        order: 1,
        duration: 1,
        type: 'blank',
        visual: { kind: 'blank' },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: '',
        renders: []
      }
    ]
  };
}

async function writeRenderFile(projectId: string, relativePath: string): Promise<void> {
  const full = path.join(getProjectRoot(projectId), relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, 'ok', 'utf8');
}

async function writeAssetFile(projectId: string, relativePath: string): Promise<void> {
  const full = path.join(getProjectRoot(projectId), relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, 'ok', 'utf8');
}

function attachCompletedRenders(project: Project): void {
  project.scenes[0].renders = [
    {
      renderId: 'render-2',
      outputPath: 'renders/scene-2.mp4',
      createdAt: new Date().toISOString(),
      width: 1280,
      height: 720,
      fps: 30,
      duration: 2,
      filesize: 100,
      mimeType: 'video/mp4',
      renderer: 'ffmpeg',
      status: 'completed'
    }
  ];
  project.scenes[1].renders = [
    {
      renderId: 'render-1',
      outputPath: 'renders/scene-1.mp4',
      createdAt: new Date().toISOString(),
      width: 1280,
      height: 720,
      fps: 30,
      duration: 1,
      filesize: 100,
      mimeType: 'video/mp4',
      renderer: 'ffmpeg',
      status: 'completed'
    }
  ];
}

afterEach(async () => {
  await fs.rm(getProjectRoot('project-composition-plan-test'), { recursive: true, force: true });
});

describe('composition plan resolver', () => {
  it('orders scenes and propagates project settings', async () => {
    const project = createProject('project-composition-plan-test');

    project.scenes[0].renders = [
      {
        renderId: 'render-2',
        outputPath: 'renders/scene-2.mp4',
        createdAt: new Date().toISOString(),
        width: 1280,
        height: 720,
        fps: 30,
        duration: 2,
        filesize: 100,
        mimeType: 'video/mp4',
        renderer: 'ffmpeg',
        status: 'completed'
      }
    ];

    project.scenes[1].renders = [
      {
        renderId: 'render-1',
        outputPath: 'renders/scene-1.mp4',
        createdAt: new Date().toISOString(),
        width: 1280,
        height: 720,
        fps: 30,
        duration: 1,
        filesize: 100,
        mimeType: 'video/mp4',
        renderer: 'ffmpeg',
        status: 'completed'
      }
    ];

    await writeRenderFile(project.id, 'renders/scene-1.mp4');
    await writeRenderFile(project.id, 'renders/scene-2.mp4');

    const plan = await resolveCompositionPlan(project, { type: 'none' });
    expect(plan.items.map((item) => item.sceneId)).toEqual(['scene-1', 'scene-2']);
    expect(plan.width).toBe(1280);
    expect(plan.height).toBe(720);
    expect(plan.fps).toBe(30);
    expect(plan.totalDuration).toBe(3);
    expect(plan.audio).toEqual({ narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 });
  });

  it('normalizes audio mix volumes carried onto the composition plan', async () => {
    const project = createProject('project-composition-plan-test');
    project.renderSettings.audio = {
      narrationVolume: -5,
      musicVolume: 12,
      effectsVolume: Number.NaN
    };

    attachCompletedRenders(project);

    await writeRenderFile(project.id, 'renders/scene-1.mp4');
    await writeRenderFile(project.id, 'renders/scene-2.mp4');

    const plan = await resolveCompositionPlan(project, { type: 'none' });
    expect(plan.audio).toEqual({ narrationVolume: 0, musicVolume: 4, effectsVolume: 0.2 });
  });

  it('fails when a scene render is missing', async () => {
    const project = createProject('project-composition-plan-test');
    project.scenes[0].renders = [];
    project.scenes[1].renders = [];

    await expect(resolveCompositionPlan(project, { type: 'none' })).rejects.toMatchObject({ code: 'SCENE_RENDER_MISSING' });
  });

  it('fails when render file is missing on disk', async () => {
    const project = createProject('project-composition-plan-test');
    project.scenes[0].renders = [
      {
        renderId: 'render-2',
        outputPath: 'renders/scene-2.mp4',
        createdAt: new Date().toISOString(),
        width: 1280,
        height: 720,
        fps: 30,
        duration: 2,
        filesize: 100,
        mimeType: 'video/mp4',
        renderer: 'ffmpeg',
        status: 'completed'
      }
    ];

    project.scenes[1].renders = [
      {
        renderId: 'render-1',
        outputPath: 'renders/scene-1.mp4',
        createdAt: new Date().toISOString(),
        width: 1280,
        height: 720,
        fps: 30,
        duration: 1,
        filesize: 100,
        mimeType: 'video/mp4',
        renderer: 'ffmpeg',
        status: 'completed'
      }
    ];

    await writeRenderFile(project.id, 'renders/scene-1.mp4');

    await expect(resolveCompositionPlan(project, { type: 'none' })).rejects.toMatchObject({ code: 'RENDER_FILE_MISSING' });
  });

  it('fails on unsafe traversal path', async () => {
    const project = createProject('project-composition-plan-test');
    project.scenes[0].renders = [
      {
        renderId: 'render-2',
        outputPath: '../outside.mp4',
        createdAt: new Date().toISOString(),
        width: 1280,
        height: 720,
        fps: 30,
        duration: 2,
        filesize: 100,
        mimeType: 'video/mp4',
        renderer: 'ffmpeg',
        status: 'completed'
      }
    ];
    project.scenes[1].renders = [
      {
        renderId: 'render-1',
        outputPath: 'renders/scene-1.mp4',
        createdAt: new Date().toISOString(),
        width: 1280,
        height: 720,
        fps: 30,
        duration: 1,
        filesize: 100,
        mimeType: 'video/mp4',
        renderer: 'ffmpeg',
        status: 'completed'
      }
    ];

    await writeRenderFile(project.id, 'renders/scene-1.mp4');

    await expect(resolveCompositionPlan(project, { type: 'none' })).rejects.toMatchObject({ code: 'INCOMPATIBLE_RENDER' });
  });

  it('fails on incompatible render dimensions', async () => {
    const project = createProject('project-composition-plan-test');
    project.scenes[0].renders = [
      {
        renderId: 'render-2',
        outputPath: 'renders/scene-2.mp4',
        createdAt: new Date().toISOString(),
        width: 640,
        height: 360,
        fps: 30,
        duration: 2,
        filesize: 100,
        mimeType: 'video/mp4',
        renderer: 'ffmpeg',
        status: 'completed'
      }
    ];

    project.scenes[1].renders = [
      {
        renderId: 'render-1',
        outputPath: 'renders/scene-1.mp4',
        createdAt: new Date().toISOString(),
        width: 1280,
        height: 720,
        fps: 30,
        duration: 1,
        filesize: 100,
        mimeType: 'video/mp4',
        renderer: 'ffmpeg',
        status: 'completed'
      }
    ];

    await writeRenderFile(project.id, 'renders/scene-1.mp4');
    await writeRenderFile(project.id, 'renders/scene-2.mp4');

    await expect(resolveCompositionPlan(project, { type: 'none' })).rejects.toMatchObject({ code: 'INCOMPATIBLE_RENDER' });
  });

  it('resolves narration audio per scene when linked', async () => {
    const project = createProject('project-composition-plan-test');
    project.assets.push({
      id: 'audio-1',
      type: 'audio',
      status: 'available',
      provenance: 'generated',
      filename: 'narration.mp3',
      localPath: 'assets/narration.mp3',
      mimeType: 'audio/mpeg',
      duration: 0.8,
      filesize: 32,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    project.scenes[1].narration = {
      text: 'hello',
      audioAssetId: 'audio-1'
    };

    project.scenes[0].renders = [
      {
        renderId: 'render-2',
        outputPath: 'renders/scene-2.mp4',
        createdAt: new Date().toISOString(),
        width: 1280,
        height: 720,
        fps: 30,
        duration: 2,
        filesize: 100,
        mimeType: 'video/mp4',
        renderer: 'ffmpeg',
        status: 'completed'
      }
    ];

    project.scenes[1].renders = [
      {
        renderId: 'render-1',
        outputPath: 'renders/scene-1.mp4',
        createdAt: new Date().toISOString(),
        width: 1280,
        height: 720,
        fps: 30,
        duration: 1,
        filesize: 100,
        mimeType: 'video/mp4',
        renderer: 'ffmpeg',
        status: 'completed'
      }
    ];

    await writeRenderFile(project.id, 'renders/scene-1.mp4');
    await writeRenderFile(project.id, 'renders/scene-2.mp4');
    await writeAssetFile(project.id, 'assets/narration.mp3');

    const plan = await resolveCompositionPlan(project, { type: 'none' });
    expect(plan.items[0].sceneId).toBe('scene-1');
    expect(plan.items[0].narrationAudioPath).toContain('assets');
    expect(plan.items[0].narrationAudioDuration).toBe(0.8);
    expect(plan.items[1].sceneId).toBe('scene-2');
    expect(plan.items[1].narrationAudioPath).toBeUndefined();
  });

  it('fails when linked narration audio is longer than scene duration', async () => {
    const project = createProject('project-composition-plan-test');
    project.assets.push({
      id: 'audio-long',
      type: 'audio',
      status: 'available',
      provenance: 'generated',
      filename: 'long.mp3',
      localPath: 'assets/long.mp3',
      mimeType: 'audio/mpeg',
      duration: 5,
      filesize: 32,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    project.scenes[1].narration = {
      text: 'too long',
      audioAssetId: 'audio-long'
    };

    project.scenes[0].renders = [
      {
        renderId: 'render-2',
        outputPath: 'renders/scene-2.mp4',
        createdAt: new Date().toISOString(),
        width: 1280,
        height: 720,
        fps: 30,
        duration: 2,
        filesize: 100,
        mimeType: 'video/mp4',
        renderer: 'ffmpeg',
        status: 'completed'
      }
    ];

    project.scenes[1].renders = [
      {
        renderId: 'render-1',
        outputPath: 'renders/scene-1.mp4',
        createdAt: new Date().toISOString(),
        width: 1280,
        height: 720,
        fps: 30,
        duration: 1,
        filesize: 100,
        mimeType: 'video/mp4',
        renderer: 'ffmpeg',
        status: 'completed'
      }
    ];

    await writeRenderFile(project.id, 'renders/scene-1.mp4');
    await writeRenderFile(project.id, 'renders/scene-2.mp4');
    await writeAssetFile(project.id, 'assets/long.mp3');

    await expect(resolveCompositionPlan(project, { type: 'none' })).rejects.toMatchObject({ code: 'INCOMPATIBLE_RENDER' });
  });

  it('leaves the plan without music when no track is selected', async () => {
    const project = createProject('project-composition-plan-test');
    attachCompletedRenders(project);
    await writeRenderFile(project.id, 'renders/scene-1.mp4');
    await writeRenderFile(project.id, 'renders/scene-2.mp4');

    const plan = await resolveCompositionPlan(project, { type: 'none' });
    expect(plan.music).toBeUndefined();
  });

  it('resolves the selected background music asset into the plan', async () => {
    const project = createProject('project-composition-plan-test');
    project.assets.push({
      id: 'music-1',
      type: 'music',
      status: 'available',
      provenance: 'generated',
      filename: 'music-1.wav',
      localPath: 'assets/music-1.wav',
      mimeType: 'audio/wav',
      duration: 60,
      filesize: 64,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    project.music = { assetId: 'music-1', status: 'generated' };

    attachCompletedRenders(project);
    await writeRenderFile(project.id, 'renders/scene-1.mp4');
    await writeRenderFile(project.id, 'renders/scene-2.mp4');
    await writeAssetFile(project.id, 'assets/music-1.wav');

    const plan = await resolveCompositionPlan(project, { type: 'none' });
    expect(plan.music?.path).toContain('assets');
    expect(plan.music?.duration).toBe(60);
  });

  it('skips music without failing when the selected music asset does not exist', async () => {
    const project = createProject('project-composition-plan-test');
    project.music = { assetId: 'missing-music', status: 'generated' };
    attachCompletedRenders(project);
    await writeRenderFile(project.id, 'renders/scene-1.mp4');
    await writeRenderFile(project.id, 'renders/scene-2.mp4');

    const plan = await resolveCompositionPlan(project, { type: 'none' });
    expect(plan.music).toBeUndefined();
    expect(plan.items).toHaveLength(2);
  });

  it('skips music without failing when the selected asset file is missing on disk', async () => {
    const project = createProject('project-composition-plan-test');
    project.assets.push({
      id: 'music-missing-file',
      type: 'music',
      status: 'available',
      provenance: 'generated',
      filename: 'gone.wav',
      localPath: 'assets/gone.wav',
      mimeType: 'audio/wav',
      duration: 60,
      filesize: 10,
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    project.music = { assetId: 'music-missing-file', status: 'generated' };
    attachCompletedRenders(project);
    await writeRenderFile(project.id, 'renders/scene-1.mp4');
    await writeRenderFile(project.id, 'renders/scene-2.mp4');

    const plan = await resolveCompositionPlan(project, { type: 'none' });
    expect(plan.music).toBeUndefined();
  });
});
