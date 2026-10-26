import { describe, expect, it } from 'vitest';

import { AUTHORING_TOOL_DEFINITIONS, createAuthoringToolService } from '@/mcp/authoring/tools';
import type { AuthoringApiClient } from '@/mcp/authoring/api-client';
import { READ_ONLY_TOOL_DEFINITIONS, createReadOnlyToolService } from '@/mcp/read-only/tools';
import type { AppApiClient } from '@/mcp/read-only/api-client';
import { listAnimationTemplateSummaries } from '@/lib/animation/catalog';

function makeAuthoringClient(overrides: Partial<AuthoringApiClient> = {}): AuthoringApiClient {
  return {
    createProject: async () => ({ project: { id: 'project-1', title: 't' } as never }),
    updateProject: async () => ({ project: { id: 'project-1' } as never }),
    planSceneIntents: async () => ({ project: { id: 'project-1' } as never, createdIntentIds: [] }),
    materializeSceneIntents: async () => ({ project: { id: 'project-1' } as never, materialized: [], skipped: [] }),
    approveSceneIntents: async () => ({ project: { id: 'project-1' } as never, approved: [], skipped: [] }),
    manageMusic: async () => ({ action: 'clear', status: 'cleared' }),
    createReference: async () => ({ reference: { id: 'r' } as never }),
    importAsset: async () => ({ asset: { id: 'asset_1' } as never }),
    importStudioAssets: async () => ({ projectId: 'project-1', assets: [] }),
    generateVideo: async () => ({
      sceneId: 'scene-1',
      generationAttemptId: 'a',
      status: 'queued',
      provider: 'fal',
      providerJobId: 'job',
      providerStatus: 'queued'
    }),
    cancelVideo: async () => ({
      sceneId: 'scene-1',
      generationAttemptId: 'a',
      status: 'rejected',
      provider: 'fal',
      providerStatus: 'canceled'
    }),
    renderAnimationTemplate: async () => ({
      projectId: 'project-1',
      templateId: 'northwind_arr_chart',
      assetId: 'asset_chart',
      localPath: 'assets/mc-northwind-arr-chart.mp4',
      mimeType: 'video/mp4',
      destination: 'bigscreen',
      width: 1920,
      height: 1080
    }),
    attachAnimation: async () => ({
      projectId: 'project-1',
      sceneId: 'scene-1',
      assetId: 'asset_chart',
      localPath: 'assets/mc-northwind-arr-chart.mp4',
      destination: 'bigscreen',
      layerId: 'studio-screen',
      rect: { x: 293, y: 98, width: 1346, height: 761 },
      startSeconds: 0,
      durationSeconds: 5
    }),
    selectStockPhoto: async () => ({
      action: 'choose',
      sceneId: 'scene-1',
      status: 'selected',
      provider: 'pexels',
      photoId: '42',
      usagePolicy: 'download',
      cached: false,
      attribution: {
        provider: 'pexels',
        providerName: 'Pexels',
        photoId: '42',
        photographerName: 'Ada',
        sourceUrl: 'https://pexels.local/42',
        license: 'Pexels License'
      }
    }),
    ...overrides
  };
}

describe('animation MCP tool definitions', () => {
  it('registers list/render/attach with expected names', () => {
    expect(READ_ONLY_TOOL_DEFINITIONS.map((entry) => entry.name)).toContain('list_animation_templates');
    expect(AUTHORING_TOOL_DEFINITIONS.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      'render_animation_template',
      'attach_animation'
    ]));
    const list = READ_ONLY_TOOL_DEFINITIONS.find((entry) => entry.name === 'list_animation_templates');
    const render = AUTHORING_TOOL_DEFINITIONS.find((entry) => entry.name === 'render_animation_template');
    const attach = AUTHORING_TOOL_DEFINITIONS.find((entry) => entry.name === 'attach_animation');
    expect(list?.annotations.readOnlyHint).toBe(true);
    expect(render?.annotations.readOnlyHint).toBe(false);
    expect(attach?.annotations.readOnlyHint).toBe(false);
  });
});

describe('list_animation_templates', () => {
  it('returns the server-owned catalog', async () => {
    const templates = listAnimationTemplateSummaries();
    const service = createReadOnlyToolService({
      listProjects: async () => [],
      getProject: async () => ({}) as never,
      getValidationReport: async () => ({}) as never,
      getProductionPlan: async () => ({}) as never,
      getGenerationJob: async () => ({}) as never,
      getMandateStatus: async () => ({}) as never,
      listAnimationTemplates: async () => templates,
      searchStockPhotos: async () => ({
        searchId: 'stocksearch_1',
        query: 'mountains',
        cached: false,
        results: [],
        diagnostics: [],
        quota: []
      })
    } satisfies AppApiClient);

    const result = await service.listAnimationTemplates({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.templates.map((entry) => entry.id)).toEqual(['northwind_arr_chart', 'nix_overlay']);
    }
  });

  it('rejects unknown arguments', async () => {
    const service = createReadOnlyToolService({
      listProjects: async () => [],
      getProject: async () => ({}) as never,
      getValidationReport: async () => ({}) as never,
      getProductionPlan: async () => ({}) as never,
      getGenerationJob: async () => ({}) as never,
      getMandateStatus: async () => ({}) as never,
      listAnimationTemplates: async () => [],
      searchStockPhotos: async () => ({
        searchId: 'stocksearch_1',
        query: 'mountains',
        cached: false,
        results: [],
        diagnostics: [],
        quota: []
      })
    } satisfies AppApiClient);
    const result = await service.listAnimationTemplates({ extra: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
  });
});

describe('render_animation_template and attach_animation', () => {
  it('forwards structured render params and returns a project-relative asset', async () => {
    const calls: unknown[] = [];
    const service = createAuthoringToolService(makeAuthoringClient({
      renderAnimationTemplate: async (projectId, input) => {
        calls.push({ projectId, input });
        return {
          projectId,
          templateId: input.templateId,
          assetId: 'asset_chart',
          localPath: 'assets/mc-northwind-arr-chart.mp4',
          mimeType: 'video/mp4',
          destination: 'bigscreen'
        };
      }
    }));

    const result = await service.renderAnimationTemplate({
      projectId: 'project-1',
      templateId: 'northwind_arr_chart',
      params: { values: [24, 41, 63, 88, 76] }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.localPath.startsWith('assets/')).toBe(true);
      expect(result.data.destination).toBe('bigscreen');
    }
    expect(calls).toEqual([{
      projectId: 'project-1',
      input: { templateId: 'northwind_arr_chart', params: { values: [24, 41, 63, 88, 76] } }
    }]);
  });

  it('rejects unknown template ids at the tool boundary', async () => {
    const service = createAuthoringToolService(makeAuthoringClient());
    const result = await service.renderAnimationTemplate({
      projectId: 'project-1',
      templateId: 'not_a_template'
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('attaches overlay timing onto studio-overlay', async () => {
    const service = createAuthoringToolService(makeAuthoringClient({
      attachAnimation: async (projectId, sceneId, input) => ({
        projectId,
        sceneId,
        assetId: input.assetId,
        localPath: 'assets/mc-nix-overlay.webm',
        destination: input.destination,
        layerId: 'studio-overlay',
        rect: { x: 1648, y: 200, width: 260, height: 390 },
        startSeconds: input.startSeconds,
        durationSeconds: input.durationSeconds
      })
    }));

    const result = await service.attachAnimation({
      projectId: 'project-1',
      sceneId: 'scene-1',
      assetId: 'asset_overlay',
      destination: 'overlay',
      startSeconds: 0.2,
      durationSeconds: 4
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.layerId).toBe('studio-overlay');
      expect(result.data.startSeconds).toBe(0.2);
    }
  });

  it('rejects unknown attach fields', async () => {
    const service = createAuthoringToolService(makeAuthoringClient());
    const result = await service.attachAnimation({
      projectId: 'project-1',
      sceneId: 'scene-1',
      assetId: 'asset_overlay',
      destination: 'overlay',
      code: 'alert(1)'
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
  });
});
