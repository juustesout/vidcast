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
    approveSceneIntents: async () => ({ project: makeProject() as never, approved: ['intent-1'], skipped: [] }),
    manageMusic: async () => ({ action: 'clear', status: 'cleared' }),
    createReference: async () => ({ reference: { id: 'reference-1', name: 'ref', description: '', tags: [], createdAt: '', updatedAt: '' } as never }),
    importStudioAssets: async () => ({ projectId: 'project-1', assets: [] }),
    generateVideo: async () => ({
      sceneId: 'scene-1',
      generationAttemptId: 'generation_attempt_1',
      status: 'queued',
      provider: 'fal',
      providerJobId: 'fal:minimax/h3-max-turbo:req-1',
      providerStatus: 'queued'
    }),
    cancelVideo: async () => ({
      sceneId: 'scene-1',
      generationAttemptId: 'generation_attempt_1',
      status: 'rejected',
      provider: 'fal',
      providerJobId: 'fal:minimax/h3-max-turbo:req-1',
      providerStatus: 'canceled'
    }),
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
      'approve_scene_intents',
      'manage_project_music',
      'create_reference',
      'import_studio_assets',
      'generate_video',
      'cancel_video'
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
    const approved = await service.approveSceneIntents({ projectId: 'project-1', intentIds: ['intent-1'] });

    expect(created.ok).toBe(true);
    expect(updated.ok).toBe(true);
    expect(planned.ok).toBe(true);
    expect(materialized.ok).toBe(true);
    expect(approved.ok).toBe(true);

    if (created.ok) {
      expect(created.data).toEqual({ projectId: 'project-1', title: 'Music Test', valid: true });
    }
    if (planned.ok) {
      expect(planned.data.createdIntentIds).toEqual(['intent-1']);
    }
    if (materialized.ok) {
      expect(materialized.data.materialized).toEqual([{ intentId: 'intent-1', sceneId: 'scene-1' }]);
    }
    if (approved.ok) {
      expect(approved.data.approved).toEqual(['intent-1']);
      expect(approved.data.skipped).toEqual([]);
    }
  });

  it('surfaces a service claim token from create_project', async () => {
    const service = createAuthoringToolService(
      makeClient({ createProject: async () => ({ project: makeProject() as never, claimToken: 'claim-token-abc' }) })
    );

    const result = await service.createProject({ title: 'New' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        projectId: 'project-1',
        title: 'Music Test',
        valid: true,
        claimToken: 'claim-token-abc'
      });
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
      if (text.endsWith('/scene-intents/approve')) {
        return new Response(JSON.stringify({ project: makeProject(), approved: ['intent-1'], skipped: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ project: makeProject(), materialized: [{ intentId: 'intent-1', sceneId: 'scene-1' }], skipped: [] }), { status: 200 });
    });
    const client = new HttpAuthoringApiClient({ baseUrl: 'http://127.0.0.1:5555', fetchFn: fetchMock as unknown as typeof fetch });
    const service = createAuthoringToolService(client);

    await service.planSceneIntents({ projectId: 'project-1' });
    await service.approveSceneIntents({ projectId: 'project-1', intentIds: ['intent-1'] });
    await service.materializeSceneIntents({ projectId: 'project-1', intentIds: ['intent-1'] });

    expect(posted).toEqual([
      'http://127.0.0.1:5555/api/projects/project-1/scene-intents/plan',
      'http://127.0.0.1:5555/api/projects/project-1/scene-intents/approve',
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

describe('create_reference tool', () => {
  it('is registered as a mutating tool', () => {
    const entry = AUTHORING_TOOL_DEFINITIONS.find((definition) => definition.name === 'create_reference');
    expect(entry).toBeDefined();
    expect(entry?.annotations.readOnlyHint).toBe(false);
  });

  it('forwards base64 content and returns stored metadata', async () => {
    const calls: Array<{ projectId: string; input: unknown }> = [];
    const service = createAuthoringToolService(
      makeClient({
        createReference: async (projectId, input) => {
          calls.push({ projectId, input });
          return {
            reference: {
              id: 'reference-9',
              name: input.name,
              description: input.description ?? '',
              filePath: 'references/reference-9-start.png',
              tags: input.tags ?? [],
              metadata: { mimeType: 'image/png', width: 1024, height: 768, filesize: 2048 },
              createdAt: '',
              updatedAt: ''
            } as never
          };
        }
      })
    );

    const result = await service.createReference({
      projectId: 'project-1',
      name: 'start',
      contentBase64: 'AAAA',
      tags: ['frame']
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ projectId: 'project-1', input: expect.objectContaining({ name: 'start', contentBase64: 'AAAA', tags: ['frame'] }) }]);
    if (result.ok) {
      expect(result.data).toEqual({
        projectId: 'project-1',
        referenceId: 'reference-9',
        name: 'start',
        filePath: 'references/reference-9-start.png',
        mimeType: 'image/png',
        width: 1024,
        height: 768,
        filesize: 2048
      });
    }
  });

  it('rejects an empty name without calling the API', async () => {
    const client = makeClient();
    const spy = vi.spyOn(client, 'createReference');
    const service = createAuthoringToolService(client);

    const result = await service.createReference({ projectId: 'project-1', name: '', contentBase64: 'AAAA' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps an API reference.x error to INVALID_ARGUMENT', async () => {
    const client = new HttpAuthoringApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: (async () => new Response(JSON.stringify({ message: 'bad image', code: 'reference.invalidImage' }), { status: 400 })) as unknown as typeof fetch
    });

    const result = await createAuthoringToolService(client).createReference({ projectId: 'project-1', name: 'x', contentBase64: 'AAAA' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
  });
});

describe('import_studio_assets tool', () => {
  it('is registered as a mutating tool', () => {
    const entry = AUTHORING_TOOL_DEFINITIONS.find((definition) => definition.name === 'import_studio_assets');
    expect(entry).toBeDefined();
    expect(entry?.annotations.readOnlyHint).toBe(false);
  });

  it('forwards an explicit file list and returns project-relative paths', async () => {
    const calls: Array<{ projectId: string; input: unknown }> = [];
    const service = createAuthoringToolService(
      makeClient({
        importStudioAssets: async (projectId, input) => {
          calls.push({ projectId, input });
          return {
            projectId,
            assets: [
              {
                id: 'asset_1',
                type: 'image',
                status: 'available',
                provenance: 'imported',
                filename: 'studio_back.png',
                localPath: 'assets/studio/studio_back.png',
                mimeType: 'image/png',
                width: 1,
                height: 1,
                filesize: 70,
                metadata: {},
                createdAt: ''
              } as never
            ]
          };
        }
      })
    );

    const result = await service.importStudioAssets({
      projectId: 'project-1',
      fileNames: ['studio_back.png']
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ projectId: 'project-1', input: { fileNames: ['studio_back.png'] } }]);
    if (result.ok) {
      expect(result.data).toEqual({
        projectId: 'project-1',
        assets: [
          {
            assetId: 'asset_1',
            filename: 'studio_back.png',
            localPath: 'assets/studio/studio_back.png',
            mimeType: 'image/png',
            width: 1,
            height: 1,
            filesize: 70
          }
        ]
      });
    }
  });

  it('rejects an empty file list without calling the API', async () => {
    const client = makeClient();
    const spy = vi.spyOn(client, 'importStudioAssets');
    const service = createAuthoringToolService(client);

    const result = await service.importStudioAssets({ projectId: 'project-1', fileNames: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps a missing source file to NOT_FOUND', async () => {
    const client = new HttpAuthoringApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: (async () => new Response(JSON.stringify({ message: 'missing', code: 'studio.import.fileMissing' }), { status: 404 })) as unknown as typeof fetch
    });

    const result = await createAuthoringToolService(client).importStudioAssets({
      projectId: 'project-1',
      fileNames: ['studio_back.png']
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('maps an existing studio file to CONFLICT', async () => {
    const client = new HttpAuthoringApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: (async () => new Response(JSON.stringify({ message: 'exists', code: 'studio.import.alreadyExists' }), { status: 409 })) as unknown as typeof fetch
    });

    const result = await createAuthoringToolService(client).importStudioAssets({
      projectId: 'project-1',
      fileNames: ['studio_back.png']
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT');
    }
  });
});

describe('generate_video tool', () => {
  it('is registered as a mutating tool', () => {
    const entry = AUTHORING_TOOL_DEFINITIONS.find((definition) => definition.name === 'generate_video');
    expect(entry).toBeDefined();
    expect(entry?.annotations.readOnlyHint).toBe(false);
  });

  it('forwards provider, model, mode and regenerate to the API', async () => {
    const calls: Array<{ projectId: string; sceneId: string; input: unknown }> = [];
    const service = createAuthoringToolService(
      makeClient({
        generateVideo: async (projectId, sceneId, input) => {
          calls.push({ projectId, sceneId, input });
          return {
            sceneId,
            generationAttemptId: 'attempt-1',
            status: 'queued',
            provider: input.provider ?? 'fal',
            model: input.model,
            providerJobId: 'fal:model:req-1',
            providerStatus: 'queued'
          };
        }
      })
    );

    const result = await service.generateVideo({
      projectId: 'project-1',
      sceneId: 'scene-1',
      provider: 'fal',
      model: 'minimax/h3-max-turbo/image-to-video',
      mode: 'real',
      regenerate: true
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        projectId: 'project-1',
        sceneId: 'scene-1',
        input: expect.objectContaining({ provider: 'fal', model: 'minimax/h3-max-turbo/image-to-video', mode: 'real', regenerate: true })
      }
    ]);
    if (result.ok) {
      expect(result.data.generationAttemptId).toBe('attempt-1');
      expect(result.data.provider).toBe('fal');
    }
  });

  it('rejects an invalid mode before calling the API', async () => {
    const client = makeClient();
    const spy = vi.spyOn(client, 'generateVideo');
    const service = createAuthoringToolService(client);

    const result = await service.generateVideo({ projectId: 'project-1', sceneId: 'scene-1', mode: 'live' as never });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps a busy scene conflict to CONFLICT', async () => {
    const client = new HttpAuthoringApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: (async () => new Response(JSON.stringify({ message: 'busy', code: 'generation.scene.busy' }), { status: 409 })) as unknown as typeof fetch
    });

    const result = await createAuthoringToolService(client).generateVideo({ projectId: 'project-1', sceneId: 'scene-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT');
    }
  });
});

describe('cancel_video tool', () => {
  it('is registered as a mutating tool', () => {
    const entry = AUTHORING_TOOL_DEFINITIONS.find((definition) => definition.name === 'cancel_video');
    expect(entry).toBeDefined();
    expect(entry?.annotations.readOnlyHint).toBe(false);
  });

  it('requires a sceneId before calling the API', async () => {
    const client = makeClient();
    const spy = vi.spyOn(client, 'cancelVideo');
    const service = createAuthoringToolService(client);

    const result = await service.cancelVideo({ projectId: 'project-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('posts to the cancel-video endpoint and returns the provider status', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          sceneId: 'scene-1',
          generationAttemptId: 'attempt-1',
          status: 'rejected',
          provider: 'fal',
          providerJobId: 'fal:model:req-1',
          providerStatus: 'canceled'
        }),
        { status: 200 }
      )
    );
    const client = new HttpAuthoringApiClient({ baseUrl: 'http://127.0.0.1:5555', fetchFn: fetchMock as unknown as typeof fetch });

    const result = await createAuthoringToolService(client).cancelVideo({ projectId: 'project-1', sceneId: 'scene-1' });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('http://127.0.0.1:5555/api/projects/project-1/scenes/scene-1/cancel-video');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.providerStatus).toBe('canceled');
      expect(result.data.status).toBe('rejected');
    }
  });
});
