import fs from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { generateSceneNarration } from '@/lib/generation/narration-service';
import { mediaMetadataReader } from '@/lib/media/metadata-reader';
import { mediaStore } from '@/lib/storage/media-store';
import { projectStore } from '@/lib/storage/project-store';
import { getProjectRoot } from '@/lib/storage/storage-paths';

describe('narration generation with the fake provider', () => {
  const createdProjectIds: string[] = [];

  afterEach(async () => {
    for (const id of createdProjectIds) {
      await fs.rm(getProjectRoot(id), { recursive: true, force: true });
    }
  });

  it('persists a decodable WAV whose format, MIME, extension and duration all agree', async () => {
    const project = await projectStore.createProject({ title: 'Fake Narration E2E', durationTarget: 30, fps: 30 });
    createdProjectIds.push(project.id);
    const scene = project.scenes[0];

    const result = await generateSceneNarration(project.id, scene.id, {
      text: 'A short narration line for the mock provider.',
      voiceId: 'voice-mock',
      format: 'mp3'
    });

    expect(result.format).toBe('wav');
    expect(result.duration).toBeGreaterThan(0);

    const persisted = await projectStore.getProject(project.id);
    expect(persisted).not.toBeNull();
    const persistedScene = persisted?.scenes.find((entry) => entry.id === scene.id);
    expect(persistedScene?.narration?.status).toBe('generated');
    expect(persistedScene?.narration?.format).toBe('wav');
    expect(persistedScene?.narration?.duration).toBeCloseTo(result.duration ?? 0, 3);

    const asset = persisted?.assets.find((entry) => entry.id === result.assetId);
    expect(asset).toBeDefined();
    expect(asset?.mimeType).toBe('audio/wav');
    expect(asset?.filename.endsWith('.wav')).toBe(true);
    expect(asset?.duration).toBeCloseTo(result.duration ?? 0, 3);

    const lastAttempt = persistedScene?.narration?.attempts?.at(-1);
    expect(lastAttempt?.format).toBe('wav');
    expect(lastAttempt?.duration).toBeCloseTo(result.duration ?? 0, 3);

    const bytes = await mediaStore.readRelativeFile(project.id, asset!.localPath!);
    expect(bytes.length).toBeGreaterThan(44);
    const probed = await mediaMetadataReader.read(bytes, asset!.filename, asset!.mimeType!, 'audio');
    expect(probed.duration).toBeCloseTo(result.duration ?? 0, 2);
  }, 30000);
});
