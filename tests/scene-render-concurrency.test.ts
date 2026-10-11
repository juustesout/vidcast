import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SceneRenderService } from '@/lib/render/scene-render-service';
import type { Renderer, SceneRenderOptions } from '@/lib/render/renderer';
import { projectStore } from '@/lib/storage/project-store';
import type { Scene } from '@/lib/types/scene';
import type { Project, RenderPlan, SceneRenderResult } from '@/lib/types/render';

/**
 * Fake renderer that reproduces the render lifecycle that matters for
 * concurrency: create scratch files in the assigned temp directory, overlap
 * with the sibling render, then delete the assigned temp directory (mirroring
 * `LocalFFmpegRenderer`'s `finally` cleanup).
 *
 * It records whether each render's marker file still exists after the sibling
 * performed its cleanup. If two renders share a temp directory, the first
 * cleanup deletes the sibling's marker and `markerSurvived` becomes false.
 */
class TempIsolationRenderer implements Renderer {
  readonly tempDirs: string[] = [];
  ownerSceneId: string | null = null;
  watcherSceneId: string | null = null;
  watcherMarkerSurvived = false;

  private startedCount = 0;
  private cleanupOwner: string | null = null;

  private readonly bothStarted: Promise<void>;
  private resolveBothStarted!: () => void;
  private readonly cleanupDone: Promise<void>;
  private resolveCleanupDone!: () => void;

  constructor() {
    this.bothStarted = new Promise<void>((resolve) => {
      this.resolveBothStarted = resolve;
    });
    this.cleanupDone = new Promise<void>((resolve) => {
      this.resolveCleanupDone = resolve;
    });
  }

  async render(_plan: RenderPlan, options?: SceneRenderOptions): Promise<SceneRenderResult> {
    if (!options) {
      throw new Error('Render options are required.');
    }

    const { sceneId, renderId, tempDir, outputPath } = options;
    this.tempDirs.push(tempDir);

    await fs.mkdir(tempDir, { recursive: true });
    const markerPath = path.join(tempDir, `${sceneId}.marker`);
    await fs.writeFile(markerPath, 'alive', 'utf8');

    this.startedCount += 1;
    if (this.startedCount === 2) {
      this.resolveBothStarted();
    }
    await this.bothStarted;

    if (this.cleanupOwner === null) {
      // This render finishes first and performs its own temp-dir cleanup,
      // mirroring `LocalFFmpegRenderer`'s `finally` block.
      this.cleanupOwner = sceneId;
      this.ownerSceneId = sceneId;
      await fs.rm(tempDir, { recursive: true, force: true });
      this.resolveCleanupDone();
    } else {
      // This render is still "in flight" while the sibling cleans up. It then
      // verifies its own scratch file was not deleted by the sibling.
      await this.cleanupDone;
      let survived = true;
      try {
        await fs.access(markerPath);
      } catch {
        survived = false;
      }
      this.watcherSceneId = sceneId;
      this.watcherMarkerSurvived = survived;
    }

    return {
      renderId,
      sceneId,
      outputPath,
      createdAt: new Date().toISOString(),
      width: options.sceneWidth,
      height: options.sceneHeight,
      fps: options.sceneFps,
      duration: 1,
      filesize: 1,
      mimeType: 'video/mp4',
      renderer: 'ffmpeg',
      status: 'completed'
    };
  }
}

function blankScene(id: string, order: number): Scene {
  return {
    id,
    order,
    duration: 1,
    type: 'blank',
    narration: { text: '' },
    visual: { kind: 'blank' },
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: ''
  };
}

let originalCwd: string;
let tempRoot: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-render-concurrency-'));
  process.chdir(tempRoot);
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('scene render concurrency', () => {
  it('gives each overlapping render its own temp dir and isolates cleanup', async () => {
    const project = await projectStore.createProject({ title: 'Scene render concurrency' });
    await projectStore.mutateProject(project.id, (current) => ({
      ...current,
      assets: [],
      references: [],
      scenes: [blankScene('scene-a', 1), blankScene('scene-b', 2)]
    }));

    const renderer = new TempIsolationRenderer();
    const service = new SceneRenderService(renderer);

    const [first, second] = await Promise.all([
      service.renderScene(project.id, 'scene-a'),
      service.renderScene(project.id, 'scene-b')
    ]);

    expect(first.render.status).toBe('completed');
    expect(second.render.status).toBe('completed');

    expect(renderer.tempDirs).toHaveLength(2);
    expect(new Set(renderer.tempDirs).size).toBe(2);
    expect(renderer.tempDirs.every((dir) => dir.split(path.sep).includes('.tmp'))).toBe(true);

    // One render cleans up while the other is still in flight; the in-flight
    // render's scratch file must survive the sibling's cleanup.
    expect(renderer.ownerSceneId).not.toBeNull();
    expect(renderer.watcherSceneId).not.toBeNull();
    expect(renderer.watcherSceneId).not.toBe(renderer.ownerSceneId);
    expect(renderer.watcherMarkerSurvived).toBe(true);

    const persisted = await projectStore.getProject(project.id);
    const sceneA = persisted?.scenes.find((scene) => scene.id === 'scene-a');
    const sceneB = persisted?.scenes.find((scene) => scene.id === 'scene-b');
    expect(sceneA?.renders).toHaveLength(1);
    expect(sceneB?.renders).toHaveLength(1);
    expect(sceneA?.renders?.[0].status).toBe('completed');
    expect(sceneB?.renders?.[0].status).toBe('completed');

    const rendersRoot = path.join(tempRoot, 'projects', project.id, 'renders');
    const metadataFiles = (await fs.readdir(rendersRoot)).filter((entry) => entry.endsWith('.json'));
    expect(metadataFiles).toHaveLength(2);
  });
});
