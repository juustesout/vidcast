import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectSummary } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';
import type { AppApiClient } from '@/mcp/read-only/api-client';
import { HttpAppApiClient } from '@/mcp/read-only/api-client';
import { READ_ONLY_TOOL_DEFINITIONS, createReadOnlyToolService } from '@/mcp/read-only/tools';

function makeProject(id: string): Project {
  const now = new Date().toISOString();
  return {
    id,
    title: `Project ${id}`,
    description: 'Test project',
    durationTarget: 30,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 5,
        type: 'blank',
        narration: { text: 'Hello' },
        visual: { kind: 'blank' },
        render: {
          motion: { preset: 'none' },
          transition: { type: 'fade' }
        },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ],
    assets: [],
    references: [],
    compositions: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: {
        narrationVolume: 1,
        musicVolume: 0.35,
        effectsVolume: 0.2
      },
      subtitlesEnabled: true
    }
  };
}

function makeSummary(id: string): ProjectSummary {
  return {
    id,
    title: `Project ${id}`,
    description: 'Summary',
    sceneCount: 1,
    assetCount: 0,
    referenceCount: 0,
    durationTarget: 30,
    updatedAt: new Date().toISOString()
  };
}

function makeApiClient(overrides: Partial<AppApiClient> = {}): AppApiClient {
  return {
    listProjects: async () => [makeSummary('project-1')],
    getProject: async () => makeProject('project-1'),
    getValidationReport: async () => ({
      projectId: 'project-1',
      generatedAt: new Date().toISOString(),
      validation: {
        valid: true,
        errorCount: 0,
        warningCount: 0,
        errors: [],
        warnings: []
      },
      workflow: {
        recommendedStepId: 'final_render',
        blockedSteps: [],
        steps: []
      },
      renderPlan: {
        ready: true,
        sceneCount: 1,
        renderableSceneCount: 1,
        plannedSceneCount: 0,
        invalidSceneCount: 0,
        issueCount: 0
      },
      scenes: [],
      composition: {
        canCompose: true,
        needsSceneRenderIds: [],
        staleSceneIds: [],
        blockingSceneIds: [],
        invalidNarrationAudioSceneIds: [],
        artifactStatus: 'missing',
        artifactReasons: []
      },
      blockers: []
    }),
    getProductionPlan: async () => ({
      projectId: 'project-1',
      generatedAt: new Date().toISOString(),
      plan: {
        actions: [],
        summary: {
          ready: 0,
          running: 0,
          current: 0,
          failed: 0,
          waiting: 0,
          blocked: 0,
          skipped: 0
        }
      },
      groupedByScene: [],
      derivedFlags: {
        hasBlockingActions: false,
        hasWaitingDependencies: false,
        readyActionCount: 0
      }
    }),
    ...overrides
  };
}

describe('read-only MCP tool definitions', () => {
  it('registers read-only tools with expected names', () => {
    const names = READ_ONLY_TOOL_DEFINITIONS.map((entry) => entry.name);
    expect(names).toEqual(['list_projects', 'get_project', 'get_scene', 'get_validation_report', 'get_production_plan', 'get_project_compositions']);
    expect(READ_ONLY_TOOL_DEFINITIONS.every((entry) => entry.annotations.readOnlyHint)).toBe(true);
  });
});

describe('read-only MCP tool service', () => {
  it('returns all local projects without allowlist filtering', async () => {
    const service = createReadOnlyToolService(
      makeApiClient({
        listProjects: async () => [makeSummary('project-a'), makeSummary('project-b')]
      })
    );

    const result = await service.listProjects({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.projects.map((entry) => entry.id)).toEqual(['project-a', 'project-b']);
    }
  });

  it('validates required arguments', async () => {
    const service = createReadOnlyToolService(makeApiClient());

    const projectResult = await service.getProject({});
    const sceneResult = await service.getScene({ projectId: 'project-1' });
    const productionPlanResult = await service.getProductionPlan({});

    expect(projectResult.ok).toBe(false);
    expect(sceneResult.ok).toBe(false);
    expect(productionPlanResult.ok).toBe(false);
    if (!projectResult.ok) {
      expect(projectResult.error.code).toBe('INVALID_ARGUMENT');
    }
    if (!sceneResult.ok) {
      expect(sceneResult.error.code).toBe('INVALID_ARGUMENT');
    }
    if (!productionPlanResult.ok) {
      expect(productionPlanResult.error.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('returns NOT_FOUND for unknown project and scene ids', async () => {
    const service = createReadOnlyToolService(
      makeApiClient({
        getProject: async (projectId: string) => {
          if (projectId === 'missing-project') {
            throw new Error('should be mapped by client layer in production');
          }
          return makeProject('project-1');
        }
      })
    );

    const missingSceneResult = await service.getScene({ projectId: 'project-1', sceneId: 'missing-scene' });

    expect(missingSceneResult.ok).toBe(false);
    if (!missingSceneResult.ok) {
      expect(missingSceneResult.error.code).toBe('NOT_FOUND');
    }
  });

  it('returns one scene for valid ids', async () => {
    const service = createReadOnlyToolService(makeApiClient());

    const result = await service.getScene({ projectId: 'project-1', sceneId: 'scene-1' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scene.id).toBe('scene-1');
      expect(result.data.projectId).toBe('project-1');
    }
  });

  it('returns both clean and blocked validation reports', async () => {
    const service = createReadOnlyToolService(
      makeApiClient({
        getValidationReport: async (projectId: string) => {
          if (projectId === 'blocked-project') {
            return {
              projectId,
              generatedAt: new Date().toISOString(),
              validation: {
                valid: false,
                errorCount: 1,
                warningCount: 0,
                errors: [
                  {
                    severity: 'error',
                    code: 'scene.visual.required',
                    path: 'scenes.scene-1.visual',
                    message: 'Scene visual specification is required.'
                  }
                ],
                warnings: []
              },
              workflow: {
                recommendedStepId: 'visuals',
                blockedSteps: ['visuals'],
                steps: []
              },
              renderPlan: {
                ready: false,
                sceneCount: 1,
                renderableSceneCount: 0,
                plannedSceneCount: 0,
                invalidSceneCount: 1,
                issueCount: 1
              },
              scenes: [],
              composition: {
                canCompose: false,
                needsSceneRenderIds: [],
                staleSceneIds: [],
                blockingSceneIds: ['scene-1'],
                invalidNarrationAudioSceneIds: [],
                artifactStatus: 'missing',
                artifactReasons: []
              },
              blockers: ['Scene visual specification is required.']
            };
          }

          return {
            projectId,
            generatedAt: new Date().toISOString(),
            validation: {
              valid: true,
              errorCount: 0,
              warningCount: 0,
              errors: [],
              warnings: []
            },
            workflow: {
              recommendedStepId: 'final_render',
              blockedSteps: [],
              steps: []
            },
            renderPlan: {
              ready: true,
              sceneCount: 1,
              renderableSceneCount: 1,
              plannedSceneCount: 0,
              invalidSceneCount: 0,
              issueCount: 0
            },
            scenes: [],
            composition: {
              canCompose: true,
              needsSceneRenderIds: [],
              staleSceneIds: [],
              blockingSceneIds: [],
              invalidNarrationAudioSceneIds: [],
              artifactStatus: 'missing',
              artifactReasons: []
            },
            blockers: []
          };
        }
      })
    );

    const clean = await service.getValidationReport({ projectId: 'project-1' });
    const blocked = await service.getValidationReport({ projectId: 'blocked-project' });

    expect(clean.ok).toBe(true);
    expect(blocked.ok).toBe(true);

    if (clean.ok) {
      expect(clean.data.report.blockers).toHaveLength(0);
    }
    if (blocked.ok) {
      expect(blocked.data.report.blockers.length).toBeGreaterThan(0);
      expect(blocked.data.report.validation.valid).toBe(false);
    }
  });

  it('returns structured production plan payload', async () => {
    const service = createReadOnlyToolService(
      makeApiClient({
        getProductionPlan: async (projectId: string) => ({
          projectId,
          generatedAt: new Date().toISOString(),
          plan: {
            actions: [
              {
                id: 'scene:scene-1:scene_render',
                type: 'scene_render',
                sceneId: 'scene-1',
                sceneOrder: 1,
                status: 'ready',
                reason: 'Scene render is ready.',
                dependencyActionIds: [],
                execute: true
              },
              {
                id: 'project:final_compose',
                type: 'final_compose',
                status: 'waiting_dependency',
                reason: 'Waiting for required scene outputs to become current.',
                dependencyActionIds: ['scene:scene-1:scene_render'],
                execute: false
              }
            ],
            summary: {
              ready: 1,
              running: 0,
              current: 0,
              failed: 0,
              waiting: 1,
              blocked: 0,
              skipped: 0
            }
          },
          groupedByScene: [
            {
              sceneId: 'scene-1',
              sceneOrder: 1,
              actions: [
                {
                  id: 'scene:scene-1:scene_render',
                  type: 'scene_render',
                  sceneId: 'scene-1',
                  sceneOrder: 1,
                  status: 'ready',
                  reason: 'Scene render is ready.',
                  dependencyActionIds: [],
                  execute: true
                }
              ]
            }
          ],
          derivedFlags: {
            hasBlockingActions: false,
            hasWaitingDependencies: true,
            readyActionCount: 1
          }
        })
      })
    );

    const result = await service.getProductionPlan({ projectId: 'project-1' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.report.projectId).toBe('project-1');
      expect(result.data.report.plan.summary.ready).toBe(1);
      expect(result.data.report.plan.actions.some((entry) => entry.id === 'project:final_compose')).toBe(true);
      expect(result.data.report.derivedFlags.hasWaitingDependencies).toBe(true);
      expect(result.data.report.groupedByScene).toHaveLength(1);
    }
  });
});

describe('HTTP API client behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reports API_UNAVAILABLE when API is unreachable', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const client = new HttpAppApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn
    });

    const service = createReadOnlyToolService(client);
    const result = await service.listProjects({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('API_UNAVAILABLE');
    }
  });

  it('uses GET requests only and sends no request body', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const url = String(_url);
      if (url.endsWith('/api/projects')) {
        return new Response(JSON.stringify({ projects: [makeSummary('project-1')] }), { status: 200 });
      }
      if (url.includes('/validation-report')) {
        return new Response(
          JSON.stringify({
            report: {
              projectId: 'project-1',
              generatedAt: new Date().toISOString(),
              validation: { valid: true, errorCount: 0, warningCount: 0, errors: [], warnings: [] },
              workflow: { recommendedStepId: 'final_render', blockedSteps: [], steps: [] },
              renderPlan: { ready: true, sceneCount: 1, renderableSceneCount: 1, plannedSceneCount: 0, invalidSceneCount: 0, issueCount: 0 },
              scenes: [],
              composition: {
                canCompose: true,
                needsSceneRenderIds: [],
                staleSceneIds: [],
                blockingSceneIds: [],
                invalidNarrationAudioSceneIds: [],
                artifactStatus: 'missing',
                artifactReasons: []
              },
              blockers: []
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes('/production-plan')) {
        return new Response(
          JSON.stringify({
            report: {
              projectId: 'project-1',
              generatedAt: new Date().toISOString(),
              plan: {
                actions: [],
                summary: {
                  ready: 0,
                  running: 0,
                  current: 0,
                  failed: 0,
                  waiting: 0,
                  blocked: 0,
                  skipped: 0
                }
              },
              groupedByScene: [],
              derivedFlags: {
                hasBlockingActions: false,
                hasWaitingDependencies: false,
                readyActionCount: 0
              }
            }
          }),
          { status: 200 }
        );
      }

      return new Response(JSON.stringify({ project: makeProject('project-1') }), { status: 200 });
    });

    const client = new HttpAppApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: fetchMock as unknown as typeof fetch
    });

    const service = createReadOnlyToolService(client);

    await service.listProjects({});
    await service.getProject({ projectId: 'project-1' });
    await service.getScene({ projectId: 'project-1', sceneId: 'scene-1' });
    await service.getValidationReport({ projectId: 'project-1' });
    await service.getProductionPlan({ projectId: 'project-1' });

    expect(fetchMock).toHaveBeenCalled();

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
    }
  });

  it('maps unknown project ID to NOT_FOUND', async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(JSON.stringify({ message: 'Project not found.' }), { status: 404 });
    }) as unknown as typeof fetch;

    const client = new HttpAppApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn
    });

    const service = createReadOnlyToolService(client);
    const result = await service.getProject({ projectId: 'missing-project' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('maps unknown production plan project ID to NOT_FOUND', async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(JSON.stringify({ message: 'Project not found.' }), { status: 404 });
    }) as unknown as typeof fetch;

    const client = new HttpAppApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn
    });

    const service = createReadOnlyToolService(client);
    const result = await service.getProductionPlan({ projectId: 'missing-project' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('maps production plan 5xx response to API_ERROR', async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(JSON.stringify({ message: 'Planner unavailable.' }), { status: 500 });
    }) as unknown as typeof fetch;

    const client = new HttpAppApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn
    });

    const service = createReadOnlyToolService(client);
    const result = await service.getProductionPlan({ projectId: 'project-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('API_ERROR');
    }
  });
});

describe('read-only HTTP client service token forwarding', () => {
  const previousToken = process.env.EXPLAINER_API_TOKEN;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (previousToken === undefined) {
      delete process.env.EXPLAINER_API_TOKEN;
    } else {
      process.env.EXPLAINER_API_TOKEN = previousToken;
    }
  });

  it('forwards EXPLAINER_API_TOKEN as a bearer Authorization header', async () => {
    process.env.EXPLAINER_API_TOKEN = 'service-token-123';
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ projects: [] }), { status: 200 }));

    const client = new HttpAppApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: fetchMock as unknown as typeof fetch
    });

    await client.listProjects();

    const init = fetchMock.mock.calls[0][1];
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer service-token-123');
  });

  it('sends no Authorization header when no token is configured, staying fail-closed', async () => {
    delete process.env.EXPLAINER_API_TOKEN;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ message: 'Authentication required.' }), { status: 401 }));

    const client = new HttpAppApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: fetchMock as unknown as typeof fetch
    });

    const service = createReadOnlyToolService(client);
    const result = await service.listProjects({});

    const init = fetchMock.mock.calls[0][1];
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('API_ERROR');
    }
  });
});
