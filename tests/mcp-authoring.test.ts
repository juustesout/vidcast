import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthoringApiClient } from '@/mcp/authoring/api-client';
import { HttpAuthoringApiClient } from '@/mcp/authoring/api-client';
import { AUTHORING_TOOL_DEFINITIONS, createAuthoringToolService } from '@/mcp/authoring/tools';

function makeProject(id = 'project-1', title = 'Music Test') {
  return {
    id,
    title,
    description: 'desc',
    durationTarget: 30,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    narration: { text: '', segments: [] },
    scenes: [],
    assets: [],
    references: [],
    compositions: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1280,
      height: 720,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    }
  };
}

function makeClient(overrides: Partial<AuthoringApiClient> = {}): AuthoringApiClient {
  return {
    createProject: async () => ({ project: makeProject() as never }),
    updateProject: async () => ({ project: makeProject() as never }),
    planSceneIntents: async () => ({ project: makeProject() as never, createdIntentIds: ['intent-1'] }),
    materializeSceneIntents: async () => ({
      project: makeProject() as never,
      materialized: [{ intentId: 'intent-1', sceneId: 'scene-1' }],
      skipped: []
    }),
    manageMusic: async () => ({ action: 'clear', status: 'cleared' }),
    ...overrides
  };
}

const originalToken = process.env.EXPLAINER_API_TOKEN;

afterAll(() => {
  if (originalToken === undefined) {
    delete process.env.EXPLAINER_API_TOKEN;
  } else {
    process.env.EXPLAINER_API_TOKEN = originalToken;
  }
});

describe('authoring MCP tool definitions', () => {
  it('registers the minimal authoring tools as mutating', () => {
    const names = AUTHORING_TOOL_DEFINITIONS.map((entry) => entry.name);
    expect(names).toEqual([
      'create_project',
      'update_project',
      'plan_scene_intents',
      'materialize_scene_intents',
      'manage_project_music'
    ]);
    expect(AUTHORING_TOOL_DEFINITIONS.every((entry) => entry.annotations.readOnlyHint === false)).toBe(true);
  });
});

describe('authoring MCP tool service', () => {
  it('validates required arguments', async () => {
    const service = createAuthoringToolService(makeClient());

    const update = await service.updateProject({});
    const materialize = await service.materializeSceneIntents({});
    const music = await service.manageProjectMusic({ projectId: 'project-1' });

    expect(update.ok).toBe(false);
    expect(materialize.ok).toBe(false);
    expect(music.ok).toBe(false);
    for (const result of [update, materialize, music]) {
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_ARGUMENT');
      }
    }
  });

  it('returns structured create/update/plan/materialize payloads', async () => {
    const service = createAuthoringToolService(makeClient());

    const created = await service.createProject({ title: 'New' });
    const updated = await service.updateProject({ projectId: 'project-1', project: { title: 'Updated' } });
    const planned = await service.planSceneIntents({ projectId: 'project-1' });
    const materialized = await service.materializeSceneIntents({ projectId: 'project-1' });

    expect(created.ok).toBe(true);
    expect(updated.ok).toBe(true);
    expect(planned.ok).toBe(true);
    expect(materialized.ok).toBe(true);

    if (created.ok) {
      expect(created.data).toEqual({ projectId: 'project-1', title: 'Music Test', valid: true });
    }
    if (planned.ok) {
      expect(planned.data.createdIntentIds).toEqual(['intent-1']);
    }
    if (materialized.ok) {
      expect(materialized.data.materialized).toEqual([{ intentId: 'intent-1', sceneId: 'scene-1' }]);
    }
  });

  it('requires an assetId before selecting music and never calls the client', async () => {
    const manageMusic = vi.fn();
    const service = createAuthoringToolService(makeClient({ manageMusic: manageMusic as never }));

    const result = await service.manageProjectMusic({ projectId: 'project-1', action: 'select' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
    expect(manageMusic).not.toHaveBeenCalled();
  });

  it('maps music generate results into a structured response', async () => {
    const service = createAuthoringToolService(
      makeClient({
        manageMusic: async () => ({ action: 'generate', status: 'generated', assetId: 'asset-1', musicLengthMs: 60000, provider: 'elevenlabs', model: 'music_v2_5' })
      })
    );

    const result = await service.manageProjectMusic({ projectId: 'project-1', action: 'generate', prompt: 'calm' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        projectId: 'project-1',
        action: 'generate',
        status: 'generated',
        assetId: 'asset-1',
        musicProvider: 'elevenlabs',
        musicModel: 'music_v2_5'
      });
    }
  });
});

describe('authoring HTTP client behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.EXPLAINER_API_TOKEN;
  });

  it('does not call the API on construction (no implicit paid action)', () => {
    const fetchMock = vi.fn();
    new HttpAuthoringApiClient({ baseUrl: 'http://127.0.0.1:5555', fetchFn: fetchMock as unknown as typeof fetch });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a project with POST /api/projects and returns the projectId', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ project: makeProject('project-9', 'Fresh') }), { status: 201 }));
    const client = new HttpAuthoringApiClient({ baseUrl: 'http://127.0.0.1:5555', fetchFn: fetchMock as unknown as typeof fetch });

    const service = createAuthoringToolService(client);
    const result = await service.createProject({ title: 'Fresh' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.projectId).toBe('project-9');
      expect(result.data.title).toBe('Fresh');
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5555/api/projects');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ title: 'Fresh' });
  });

  it('maps a 422 project validation failure to VALIDATION_FAILED with structured errors', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          message: 'Project validation failed.',
          errors: [{ severity: 'error', code: 'scene.visual.required', path: 'scenes.scene-1.visual', message: 'Scene visual specification is required.' }],
          warnings: []
        }),
        { status: 422 }
      )
    );
    const client = new HttpAuthoringApiClient({ baseUrl: 'http://127.0.0.1:5555', fetchFn: fetchMock as unknown as typeof fetch });

    const service = createAuthoringToolService(client);
    const result = await service.updateProject({ projectId: 'project-1', project: { scenes: [] } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      const errors = result.error.details?.errors as unknown[];
      expect(Array.isArray(errors)).toBe(true);
      expect(errors).toHaveLength(1);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PUT');
  });

  it('uses the correct scene-intent endpoints', async () => {
    const posted: string[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const text = String(url);
      posted.push(text);
      if (text.endsWith('/scene-intents/plan')) {
        return new Response(JSON.stringify({ project: makeProject(), createdIntentIds: ['intent-1'] }), { status: 200 });
      }
      return new Response(JSON.stringify({ project: makeProject(), materialized: [{ intentId: 'intent-1', sceneId: 'scene-1' }], skipped: [] }), { status: 200 });
    });
    const client = new HttpAuthoringApiClient({ baseUrl: 'http://127.0.0.1:5555', fetchFn: fetchMock as unknown as typeof fetch });
    const service = createAuthoringToolService(client);

    await service.planSceneIntents({ projectId: 'project-1' });
    await service.materializeSceneIntents({ projectId: 'project-1', intentIds: ['intent-1'] });

    expect(posted).toEqual([
      'http://127.0.0.1:5555/api/projects/project-1/scene-intents/plan',
      'http://127.0.0.1:5555/api/projects/project-1/scene-intents/materialize'
    ]);
  });

  it('maps a music provider-not-configured error to PROVIDER_NOT_CONFIGURED', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'Real music generation requires ELEVENLABS_API_KEY.', code: 'music.provider.notConfigured' }), { status: 409 })
    );
    const client = new HttpAuthoringApiClient({ baseUrl: 'http://127.0.0.1:5555', fetchFn: fetchMock as unknown as typeof fetch });
    const service = createAuthoringToolService(client);

    const result = await service.manageProjectMusic({ projectId: 'project-1', action: 'generate', prompt: 'calm', mode: 'real' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    }
  });

  it('maps a music rate-limit error to RATE_LIMITED', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'Quota exceeded.', code: 'music.provider.rateLimited' }), { status: 429 })
    );
    const client = new HttpAuthoringApiClient({ baseUrl: 'http://127.0.0.1:5555', fetchFn: fetchMock as unknown as typeof fetch });
    const service = createAuthoringToolService(client);

    const result = await service.manageProjectMusic({ projectId: 'project-1', action: 'generate', prompt: 'calm' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('RATE_LIMITED');
    }
  });

  it('maps unauthorized and forbidden responses', async () => {
    const unauthorized = new HttpAuthoringApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: (async () => new Response(JSON.stringify({ message: 'Authentication required.', code: 'UNAUTHENTICATED' }), { status: 401 })) as unknown as typeof fetch
    });
    const forbidden = new HttpAuthoringApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: (async () => new Response(JSON.stringify({ message: 'Project not found.' }), { status: 403 })) as unknown as typeof fetch
    });

    const unauthorizedResult = await createAuthoringToolService(unauthorized).updateProject({ projectId: 'project-1', project: {} });
    const forbiddenResult = await createAuthoringToolService(forbidden).updateProject({ projectId: 'project-1', project: {} });

    expect(unauthorizedResult.ok).toBe(false);
    expect(forbiddenResult.ok).toBe(false);
    if (!unauthorizedResult.ok) {
      expect(unauthorizedResult.error.code).toBe('UNAUTHENTICATED');
    }
    if (!forbiddenResult.ok) {
      expect(forbiddenResult.error.code).toBe('FORBIDDEN');
    }
  });

  it('forwards the service token as a bearer header', async () => {
    process.env.EXPLAINER_API_TOKEN = 'authoring-token';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ project: makeProject() }), { status: 200 }));
    const client = new HttpAuthoringApiClient({ baseUrl: 'http://127.0.0.1:5555', fetchFn: fetchMock as unknown as typeof fetch });

    await client.updateProject('project-1', { title: 'x' });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer authoring-token');
  });

  it('issues exactly one request per action and never retries paid work', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ action: 'generate', status: 'generated', assetId: 'a1' }), { status: 200 }));
    const client = new HttpAuthoringApiClient({ baseUrl: 'http://127.0.0.1:5555', fetchFn: fetchMock as unknown as typeof fetch });
    const service = createAuthoringToolService(client);

    await service.manageProjectMusic({ projectId: 'project-1', action: 'generate', prompt: 'calm' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
