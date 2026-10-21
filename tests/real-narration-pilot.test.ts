import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { resolveRealNarrationPilotGate } from '@/lib/ai/text-to-speech/real-narration-pilot';
import { generateSceneNarration } from '@/lib/generation/narration-service';
import { sceneRenderService } from '@/lib/render/scene-render-service';
import { projectStore } from '@/lib/storage/project-store';
import type { Scene } from '@/lib/types/scene';

let PILOT_MP3: Buffer;

function blankSceneWithNarration(id: string, order: number): Scene {
  return {
    id,
    order,
    duration: 5,
    type: 'image',
    narration: {
      text: 'The ocean rolls in under a calm orange sky.',
      voiceId: 'voice-pilot',
      model: 'eleven_multilingual_v2',
      format: 'mp3'
    },
    visual: { kind: 'blank' },
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: ''
  };
}

describe('resolveRealNarrationPilotGate', () => {
  it('is disabled when no pilot environment is present', () => {
    expect(resolveRealNarrationPilotGate({}).allowed).toBe(false);
  });

  it('requires CONFIRM_REAL_NARRATION_PILOT to equal exactly YES', () => {
    expect(resolveRealNarrationPilotGate({ RUN_REAL_NARRATION_PILOT: 'true', CONFIRM_REAL_NARRATION_PILOT: 'yes', ELEVENLABS_API_KEY: 'k' }).allowed).toBe(false);
    expect(resolveRealNarrationPilotGate({ RUN_REAL_NARRATION_PILOT: 'true', CONFIRM_REAL_NARRATION_PILOT: 'true', ELEVENLABS_API_KEY: 'k' }).allowed).toBe(false);
    expect(resolveRealNarrationPilotGate({ RUN_REAL_NARRATION_PILOT: 'true', CONFIRM_REAL_NARRATION_PILOT: 'YES', ELEVENLABS_API_KEY: 'k' }).allowed).toBe(true);
  });

  it('requires an ElevenLabs API key to be present', () => {
    const gate = resolveRealNarrationPilotGate({ RUN_REAL_NARRATION_PILOT: 'true', CONFIRM_REAL_NARRATION_PILOT: 'YES' });
    expect(gate.allowed).toBe(false);
    expect(gate.hasApiKey).toBe(false);
    expect(gate.reason).toContain('ELEVENLABS_API_KEY');
  });

  it('ignores falsey enable values', () => {
    expect(resolveRealNarrationPilotGate({ RUN_REAL_NARRATION_PILOT: 'false', CONFIRM_REAL_NARRATION_PILOT: 'YES', ELEVENLABS_API_KEY: 'k' }).allowed).toBe(false);
  });
});

let originalCwd: string;
let tempRoot: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'real-narration-pilot-'));

  const mp3Path = path.join(tempRoot, 'fixture.mp3');
  const encode = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-codec:a', 'libmp3lame', '-b:a', '128k', mp3Path],
    { encoding: 'utf8' }
  );
  if (encode.status !== 0) {
    throw new Error(`Failed to build MP3 fixture: ${encode.stderr}`);
  }
  PILOT_MP3 = await fs.readFile(mp3Path);

  process.chdir(tempRoot);
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function createNarrationProject(): Promise<{ projectId: string; sceneId: string }> {
  const project = await projectStore.createProject({ title: 'Real narration pilot test' });
  const sceneId = 'scene-narration';
  await projectStore.mutateProject(project.id, (current) => ({
    ...current,
    assets: [],
    references: [],
    renderSettings: {
      ...current.renderSettings,
      aspectRatio: '16:9',
      width: 640,
      height: 360,
      fps: 30,
      subtitlesEnabled: false
    },
    scenes: [blankSceneWithNarration(sceneId, 1)]
  }));
  return { projectId: project.id, sceneId };
}

function enablePilot(): void {
  vi.stubEnv('RUN_REAL_NARRATION_PILOT', 'true');
  vi.stubEnv('CONFIRM_REAL_NARRATION_PILOT', 'YES');
  vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
}

describe('real narration pilot service path', () => {
  it('uses the fake provider and issues no network request when the pilot is disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { projectId, sceneId } = await createNarrationProject();
    const result = await generateSceneNarration(projectId, sceneId, { regenerate: true });

    expect(result.provider).toBe('fake');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('issues exactly one real request and persists validated audio when enabled', async () => {
    enablePilot();
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ audio_base64: PILOT_MP3.toString('base64') }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-narration-pilot' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { projectId, sceneId } = await createNarrationProject();
    const result = await generateSceneNarration(projectId, sceneId, { regenerate: true });

    expect(result.provider).toBe('elevenlabs');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.format).toBe('mp3');
    expect(result.duration).toBeGreaterThan(0);

    const persisted = await projectStore.getProject(projectId);
    const persistedScene = persisted?.scenes.find((entry) => entry.id === sceneId);
    expect(persistedScene?.narration?.status).toBe('generated');
    expect(persistedScene?.narration?.format).toBe('mp3');
    expect(persistedScene?.narration?.audioAssetId).toBe(result.assetId);
    expect(persistedScene?.narration?.duration).toBeCloseTo(result.duration ?? 0, 3);

    const asset = persisted?.assets.find((entry) => entry.id === result.assetId);
    expect(asset?.type).toBe('audio');
    expect(asset?.mimeType).toBe('audio/mpeg');
    expect(asset?.filename.endsWith('.mp3')).toBe(true);
    expect(asset?.duration).toBeGreaterThan(0);
    expect(asset?.metadata?.providerRequestId).toBe('req-narration-pilot');
  });

  it('renders the persisted narration into a scene MP4', async () => {
    enablePilot();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ audio_base64: PILOT_MP3.toString('base64') }), { status: 200, headers: { 'content-type': 'application/json' } }))
    );

    const { projectId, sceneId } = await createNarrationProject();
    await generateSceneNarration(projectId, sceneId, { regenerate: true });

    const rendered = await sceneRenderService.renderScene(projectId, sceneId);
    expect(rendered.render.status).toBe('completed');

    const output = path.join(tempRoot, 'projects', projectId, rendered.render.outputPath);
    const stat = await fs.stat(output);
    expect(stat.size).toBeGreaterThan(0);
  }, 120000);

  it('records a failed attempt and issues no second request when the paid call times out', async () => {
    enablePilot();
    vi.stubEnv('ELEVENLABS_TTS_TIMEOUT_MS', '10');
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { projectId, sceneId } = await createNarrationProject();
    await expect(generateSceneNarration(projectId, sceneId, { regenerate: true })).rejects.toMatchObject({
      code: 'narration.provider.failed'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const persisted = await projectStore.getProject(projectId);
    const persistedScene = persisted?.scenes.find((entry) => entry.id === sceneId);
    expect(persistedScene?.narration?.status).toBe('failed');
  });

  it('rejects corrupt provider audio without persisting an asset', async () => {
    enablePilot();
    const fetchMock = vi.fn(async () => {
      return new Response(Buffer.from('<html>gateway error</html>', 'utf8'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { projectId, sceneId } = await createNarrationProject();
    await expect(generateSceneNarration(projectId, sceneId, { regenerate: true })).rejects.toMatchObject({
      code: 'narration.provider.failed'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const persisted = await projectStore.getProject(projectId);
    const persistedScene = persisted?.scenes.find((entry) => entry.id === sceneId);
    expect(persistedScene?.narration?.status).toBe('failed');
    expect(persisted?.assets.some((entry) => entry.type === 'audio')).toBe(false);
  });
});
