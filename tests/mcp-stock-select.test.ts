import { describe, expect, it, vi } from 'vitest';

import { parseHtmlStillTemplateData } from '@/lib/render/html-still/templates';
import type { AuthoringApiClient } from '@/mcp/authoring/api-client';
import { HttpAuthoringApiClient } from '@/mcp/authoring/api-client';
import { AUTHORING_TOOL_DEFINITIONS, createAuthoringToolService } from '@/mcp/authoring/tools';

const pexelsAttribution = {
  provider: 'pexels' as const,
  providerName: 'Pexels',
  photoId: '42',
  photographerName: 'Ada',
  photographerUrl: 'https://www.pexels.com/@ada',
  sourceUrl: 'https://www.pexels.com/photo/42/',
  license: 'Pexels License'
};

const unsplashAttribution = {
  provider: 'unsplash' as const,
  providerName: 'Unsplash',
  photoId: 'abc',
  photographerName: 'Bea',
  sourceUrl: 'https://unsplash.com/photos/abc',
  license: 'Unsplash License'
};

function makeClient(overrides: Partial<AuthoringApiClient> = {}): AuthoringApiClient {
  return {
    createProject: async () => ({ project: { id: 'project-1' } as never }),
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
      destination: 'bigscreen'
    }),
    attachAnimation: async () => ({
      projectId: 'project-1',
      sceneId: 'scene-1',
      assetId: 'asset_chart',
      localPath: 'assets/mc-northwind-arr-chart.mp4',
      destination: 'bigscreen',
      layerId: 'studio-screen',
      rect: { x: 0, y: 0, width: 1, height: 1 }
    }),
    selectStockPhoto: async () => ({
      action: 'choose',
      sceneId: 'scene-1',
      status: 'selected',
      provider: 'pexels',
      photoId: '42',
      usagePolicy: 'download',
      assetId: 'asset_stock',
      cached: false,
      attribution: pexelsAttribution
    }),
    ...overrides
  };
}

describe('select_stock_photo tool definition', () => {
  it('is registered as a mutating choose-only tool', () => {
    const entry = AUTHORING_TOOL_DEFINITIONS.find((definition) => definition.name === 'select_stock_photo');
    expect(entry).toBeDefined();
    expect(entry?.annotations.readOnlyHint).toBe(false);
    expect(entry?.description).toMatch(/action=choose/);
    expect(entry?.description).not.toMatch(/action=auto/);
    expect(entry?.description).toMatch(/search_stock_photos/);
    expect(entry?.description).toMatch(/stock_select/);
    expect(entry?.description).toMatch(/import_asset/);
  });
});

describe('select_stock_photo tool service', () => {
  it('forwards searchId and photoId and returns a download selection with assetId', async () => {
    const calls: Array<{ projectId: string; sceneId: string; input: unknown }> = [];
    const service = createAuthoringToolService(
      makeClient({
        selectStockPhoto: async (projectId, sceneId, input) => {
          calls.push({ projectId, sceneId, input });
          return {
            action: 'choose',
            sceneId,
            status: 'selected',
            provider: 'pexels',
            photoId: '42',
            usagePolicy: 'download',
            assetId: 'asset_stock',
            cached: false,
            attribution: pexelsAttribution
          };
        }
      })
    );

    const result = await service.selectStockPhoto({
      projectId: 'project-1',
      sceneId: 'scene-1',
      searchId: 'stocksearch_1',
      photoId: 'pexels:42',
      query: 'mountains',
      orientation: 'landscape',
      mode: 'mock'
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        projectId: 'project-1',
        sceneId: 'scene-1',
        input: {
          searchId: 'stocksearch_1',
          photoId: 'pexels:42',
          query: 'mountains',
          orientation: 'landscape',
          regenerate: undefined,
          mode: 'mock'
        }
      }
    ]);
    if (result.ok) {
      expect(result.data.action).toBe('choose');
      expect(result.data.status).toBe('selected');
      expect(result.data.usagePolicy).toBe('download');
      expect(result.data.assetId).toBe('asset_stock');
      expect(result.data.attribution.license).toBe('Pexels License');
      expect(JSON.stringify(result.data)).not.toMatch(/UNSPLASH_ACCESS_KEY|PEXELS_API_KEY|PIXABAY_API_KEY|apiKey|secret/i);
    }
  });

  it('rejects missing photoId without calling the API', async () => {
    const client = makeClient();
    const spy = vi.spyOn(client, 'selectStockPhoto');
    const result = await createAuthoringToolService(client).selectStockPhoto({
      projectId: 'project-1',
      sceneId: 'scene-1',
      searchId: 'stocksearch_1'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects image URLs and file paths as searchId or photoId', async () => {
    const client = makeClient();
    const spy = vi.spyOn(client, 'selectStockPhoto');
    const service = createAuthoringToolService(client);

    const urlResult = await service.selectStockPhoto({
      projectId: 'project-1',
      sceneId: 'scene-1',
      searchId: 'stocksearch_1',
      photoId: 'https://images.pexels.com/photos/42/mountains.jpg'
    });
    const pathResult = await service.selectStockPhoto({
      projectId: 'project-1',
      sceneId: 'scene-1',
      searchId: '../secrets',
      photoId: 'pexels:42'
    });

    expect(urlResult.ok).toBe(false);
    expect(pathResult.ok).toBe(false);
    if (!urlResult.ok) {
      expect(urlResult.error.code).toBe('INVALID_ARGUMENT');
    }
    if (!pathResult.ok) {
      expect(pathResult.error.code).toBe('INVALID_ARGUMENT');
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('select_stock_photo HTTP proxy', () => {
  it('POSTs action=choose to the existing select route', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(body.action).toBe('choose');
      expect(body.searchId).toBe('stocksearch_1');
      expect(body.photoId).toBe('pexels:42');
      expect(body).not.toHaveProperty('imageUrl');
      return new Response(
        JSON.stringify({
          action: 'choose',
          sceneId: 'scene-1',
          status: 'selected',
          provider: 'pexels',
          photoId: '42',
          usagePolicy: 'download',
          assetId: 'asset_stock',
          cached: false,
          attribution: pexelsAttribution
        }),
        { status: 200 }
      );
    });
    const client = new HttpAuthoringApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: fetchMock as unknown as typeof fetch
    });

    const result = await createAuthoringToolService(client).selectStockPhoto({
      projectId: 'project-1',
      sceneId: 'scene-1',
      searchId: 'stocksearch_1',
      photoId: 'pexels:42',
      mode: 'mock'
    });

    expect(result.ok).toBe(true);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('http://127.0.0.1:5555/api/projects/project-1/scenes/scene-1/select-stock-image');
    if (result.ok) {
      expect(result.data.assetId).toBe('asset_stock');
      expect(result.data.usagePolicy).toBe('download');
    }
  });

  it('returns a hotlink selection without an assetId', async () => {
    const client = new HttpAuthoringApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            action: 'choose',
            sceneId: 'scene-1',
            status: 'selected',
            provider: 'unsplash',
            photoId: 'abc',
            usagePolicy: 'hotlink',
            cached: false,
            attribution: unsplashAttribution
          }),
          { status: 200 }
        )) as unknown as typeof fetch
    });

    const result = await createAuthoringToolService(client).selectStockPhoto({
      projectId: 'project-1',
      sceneId: 'scene-1',
      searchId: 'stocksearch_1',
      photoId: 'unsplash:abc'
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.usagePolicy).toBe('hotlink');
      expect(result.data.assetId).toBeUndefined();
      expect(result.data.attribution.license).toBe('Unsplash License');
    }
  });

  it('maps an expired candidate to CONFLICT', async () => {
    const client = new HttpAuthoringApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: (async () =>
        new Response(JSON.stringify({ message: 'The stock search results have expired. Run the search again.', code: 'stock.search.expired' }), {
          status: 409
        })) as unknown as typeof fetch
    });

    const result = await createAuthoringToolService(client).selectStockPhoto({
      projectId: 'project-1',
      sceneId: 'scene-1',
      searchId: 'old',
      photoId: 'pexels:42'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT');
      expect(result.error.details?.apiCode).toBe('stock.search.expired');
    }
  });

  it('maps a non-stock scene to INVALID_ARGUMENT', async () => {
    const client = new HttpAuthoringApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: (async () =>
        new Response(JSON.stringify({ message: 'Scene is not a stock image scene.', code: 'stock.scene.invalidVisualKind' }), {
          status: 400
        })) as unknown as typeof fetch
    });

    const result = await createAuthoringToolService(client).selectStockPhoto({
      projectId: 'project-1',
      sceneId: 'scene-html',
      searchId: 'stocksearch_1',
      photoId: 'pexels:42'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.details?.apiCode).toBe('stock.scene.invalidVisualKind');
    }
  });

  it('maps mock-mode real-provider denial to FORBIDDEN', async () => {
    const client = new HttpAuthoringApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: (async () =>
        new Response(JSON.stringify({ message: 'Stock provider pexels is not available in this mode.', code: 'stock.provider.notAllowed' }), {
          status: 403
        })) as unknown as typeof fetch
    });

    const result = await createAuthoringToolService(client).selectStockPhoto({
      projectId: 'project-1',
      sceneId: 'scene-1',
      searchId: 'stocksearch_1',
      photoId: 'pexels:42',
      mode: 'mock'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details?.apiCode).toBe('stock.provider.notAllowed');
    }
  });
});

describe('select_stock_photo vs HTML slots', () => {
  it('does not make stock CDN URLs valid imageAssetId values', () => {
    expect(() =>
      parseHtmlStillTemplateData('headline', { title: 'Live', imageAssetId: 'https://images.pexels.com/photos/42/mountains.jpg' })
    ).toThrow(/asset id/);
  });
});
