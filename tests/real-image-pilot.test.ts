import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeImageGenerationProvider } from '@/lib/ai/image-generation/fake-provider';
import { resolveRealImagePilotGate } from '@/lib/ai/image-generation/real-image-pilot';
import { stampHumanApproval } from '@/lib/explainer/human-approval';
import { generateSceneImage } from '@/lib/generation/image-generation-service';
import { InMemoryPaidSubmitLedger, setPaidSubmitLedgerForTests } from '@/lib/spend/paid-submit-cap';
import { sceneRenderService } from '@/lib/render/scene-render-service';
import { projectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';

let PILOT_PNG_BASE64 = '';

function generatedImageScene(id: string, order: number): Scene {
  const now = new Date().toISOString();
  return {
    id,
    order,
    duration: 1,
    type: 'image',
    narration: { text: '' },
    visual: {
      kind: 'generated_image',
      generation: {
        id: `${id}-gen`,
        kind: 'image',
        status: 'generated',
        provider: 'openai',
        model: 'gpt-image-1',
        prompt: 'A calm ocean at sunrise',
        referenceIds: [],
        aspectRatio: '16:9',
        createdAt: now,
        completedAt: now
      },
      attempts: []
    },
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: ''
  };
}

describe('resolveRealImagePilotGate', () => {
  it('is disabled when no pilot environment is present', () => {
    expect(resolveRealImagePilotGate({}).allowed).toBe(false);
  });

  it('requires CONFIRM_REAL_IMAGE_PILOT to equal exactly YES', () => {
    expect(resolveRealImagePilotGate({ RUN_REAL_IMAGE_PILOT: 'true', CONFIRM_REAL_IMAGE_PILOT: 'yes', OPENAI_API_KEY: 'k' }).allowed).toBe(false);
    expect(resolveRealImagePilotGate({ RUN_REAL_IMAGE_PILOT: 'true', CONFIRM_REAL_IMAGE_PILOT: 'true', OPENAI_API_KEY: 'k' }).allowed).toBe(false);
    expect(resolveRealImagePilotGate({ RUN_REAL_IMAGE_PILOT: 'true', CONFIRM_REAL_IMAGE_PILOT: 'YES', OPENAI_API_KEY: 'k' }).allowed).toBe(true);
  });

  it('requires an OpenAI API key to be present', () => {
    const gate = resolveRealImagePilotGate({ RUN_REAL_IMAGE_PILOT: 'true', CONFIRM_REAL_IMAGE_PILOT: 'YES' });
    expect(gate.allowed).toBe(false);
    expect(gate.hasApiKey).toBe(false);
    expect(gate.reason).toContain('OPENAI_API_KEY');
  });

  it('ignores falsey enable values', () => {
    expect(resolveRealImagePilotGate({ RUN_REAL_IMAGE_PILOT: 'false', CONFIRM_REAL_IMAGE_PILOT: 'YES', OPENAI_API_KEY: 'k' }).allowed).toBe(false);
  });
});

let originalCwd: string;
let tempRoot: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'real-image-pilot-'));
  process.chdir(tempRoot);

  const png = await new FakeImageGenerationProvider().generateImage({ prompt: 'pilot placeholder', aspectRatio: '16:9' });
  PILOT_PNG_BASE64 = png.data.toString('base64');
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setPaidSubmitLedgerForTests(undefined);
});

async function createPilotProject(): Promise<{ projectId: string; sceneId: string }> {
  const project = await projectStore.createProject({ title: 'Real image pilot test' });
  const sceneId = 'scene-pilot';
  await projectStore.mutateProject(project.id, (current) => {
    const next: Project = {
      ...current,
      assets: [],
      references: [],
      renderSettings: {
        ...current.renderSettings,
        aspectRatio: '16:9',
        width: 1280,
        height: 720,
        fps: 30,
        subtitlesEnabled: false
      },
      scenes: [generatedImageScene(sceneId, 1)]
    };
    return {
      ...next,
      explainer: {
        ...next.explainer!,
        humanApproval: stampHumanApproval(next, { subject: 'user_test' })
      }
    };
  });
  return { projectId: project.id, sceneId };
}

function enablePilot(): void {
  vi.stubEnv('RUN_REAL_IMAGE_PILOT', 'true');
  vi.stubEnv('CONFIRM_REAL_IMAGE_PILOT', 'YES');
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.stubEnv('PAID_SPEND_CAP_ENABLED', 'true');
  vi.stubEnv('PAID_SPEND_CAP_WINDOW_HOURS', '24');
  vi.stubEnv('PAID_SPEND_CAP_MAX_SUBMITS', '10');
  vi.stubEnv('PAID_SPEND_CAP_MAX_IMAGE_SUBMITS', '4');
  vi.stubEnv('PAID_SPEND_CAP_MAX_VIDEO_SUBMITS', '2');
  vi.stubEnv('PAID_SPEND_CAP_MAX_NARRATION_SUBMITS', '4');
  vi.stubEnv('PAID_SPEND_CAP_MAX_MUSIC_SUBMITS', '1');
  vi.stubEnv('PAID_SPEND_CAP_MAX_PRESENTER_SUBMITS', '1');
  setPaidSubmitLedgerForTests(new InMemoryPaidSubmitLedger());
}

describe('real image pilot service path', () => {
  it('uses the fake provider and issues no network request when the pilot is disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { projectId, sceneId } = await createPilotProject();
    const result = await generateSceneImage(projectId, sceneId, { regenerate: true });

    expect(result.provider).toBe('fake');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('issues exactly one real request and persists a validated PNG asset when enabled', async () => {
    enablePilot();
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [{ b64_json: PILOT_PNG_BASE64 }] }), {
        status: 200,
        headers: { 'x-request-id': 'req-pilot' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { projectId, sceneId } = await createPilotProject();
    const result = await generateSceneImage(projectId, sceneId, { regenerate: true });

    expect(result.provider).toBe('openai');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const persisted = await projectStore.getProject(projectId);
    const asset = persisted?.assets.find((entry) => entry.id === result.assetId);
    expect(asset?.type).toBe('image');
    expect(asset?.mimeType).toBe('image/png');
    expect(asset?.filename.endsWith('.png')).toBe(true);
    expect(asset?.width).toBeGreaterThan(0);
    expect(asset?.height).toBeGreaterThan(0);
    expect(asset?.metadata?.providerRequestId).toBe('req-pilot');

    const onDisk = path.join(tempRoot, 'projects', projectId, String(asset?.localPath));
    const stat = await fs.stat(onDisk);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('renders the persisted pilot image into a scene MP4', async () => {
    enablePilot();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: PILOT_PNG_BASE64 }] }), { status: 200 }))
    );

    const { projectId, sceneId } = await createPilotProject();
    await generateSceneImage(projectId, sceneId, { regenerate: true });

    const rendered = await sceneRenderService.renderScene(projectId, sceneId);
    expect(rendered.render.status).toBe('completed');

    const output = path.join(tempRoot, 'projects', projectId, rendered.render.outputPath);
    const stat = await fs.stat(output);
    expect(stat.size).toBeGreaterThan(0);
  }, 120000);
});
