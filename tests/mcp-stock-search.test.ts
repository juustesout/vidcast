import { describe, expect, it, vi } from 'vitest';

import { parseHtmlStillTemplateData } from '@/lib/render/html-still/templates';
import type { AppApiClient } from '@/mcp/read-only/api-client';
import { HttpAppApiClient } from '@/mcp/read-only/api-client';
import { READ_ONLY_TOOL_DEFINITIONS, createReadOnlyToolService } from '@/mcp/read-only/tools';

const sampleSearch = {
  searchId: 'stocksearch_1',
  query: 'mountains',
  orientation: 'landscape' as const,
  cached: false,
  results: [
    {
      id: 'pexels:42',
      provider: 'pexels' as const,
      photoId: '42',
      width: 1200,
      height: 800,
      previewUrl: 'https://cdn.local/pexels-42.jpg',
      imageUrl: 'https://images.pexels.com/photos/42/mountains.jpg',
      sourceUrl: 'https://www.pexels.com/photo/42/',
      photographerName: 'Ada',
      photographerUrl: 'https://www.pexels.com/@ada',
      license: 'Pexels License',
      usagePolicy: 'download' as const
    }
  ],
  diagnostics: [{ provider: 'pexels' as const, outcome: 'selected' as const, detail: '1 results' }],
  quota: [
    {
      provider: 'pexels' as const,
      configured: true,
      allowed: true,
      windowSeconds: 3600,
      windowLimit: 200,
      windowRemaining: 199,
      reserve: 3
    }
  ]
};

function makeApiClient(overrides: Partial<AppApiClient> = {}): AppApiClient {
  return {
    listProjects: async () => [],
    getProject: async () => ({ id: 'project-1', assets: [], scenes: [] }) as never,
    getValidationReport: async () => ({}) as never,
    getProductionPlan: async () => ({}) as never,
    getGenerationJob: async () => ({}) as never,
    listAnimationTemplates: async () => [],
    searchStockPhotos: async () => sampleSearch,
    ...overrides
  };
}

describe('search_stock_photos tool definition', () => {
  it('is registered as a non-pure-read discovery tool', () => {
    const entry = READ_ONLY_TOOL_DEFINITIONS.find((definition) => definition.name === 'search_stock_photos');
    expect(entry).toBeDefined();
    expect(entry?.annotations.readOnlyHint).toBe(false);
    expect(entry?.description).toMatch(/never selects/i);
    expect(entry?.description).toMatch(/stock_select/);
    expect(entry?.description).toMatch(/import_asset/);
    expect(entry?.description).toMatch(/human approval/);
  });
});

describe('search_stock_photos tool service', () => {
  it('forwards search arguments and returns license plus usagePolicy', async () => {
    const calls: Array<{ projectId: string; input: unknown }> = [];
    const service = createReadOnlyToolService(
      makeApiClient({
        searchStockPhotos: async (projectId, input) => {
          calls.push({ projectId, input });
          return sampleSearch;
        }
      })
    );

    const result = await service.searchStockPhotos({
      projectId: 'project-1',
      query: 'mountains',
      orientation: 'landscape',
      providers: ['pexels'],
      limit: 6,
      mode: 'mock'
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        projectId: 'project-1',
        input: {
          query: 'mountains',
          orientation: 'landscape',
          providers: ['pexels'],
          limit: 6,
          mode: 'mock'
        }
      }
    ]);
    if (result.ok) {
      expect(result.data.searchId).toBe('stocksearch_1');
      expect(result.data.results[0].license).toBe('Pexels License');
      expect(result.data.results[0].usagePolicy).toBe('download');
      expect(JSON.stringify(result.data)).not.toMatch(/UNSPLASH_ACCESS_KEY|PEXELS_API_KEY|PIXABAY_API_KEY|apiKey|secret/i);
    }
  });

  it('rejects missing query without calling the API', async () => {
    const client = makeApiClient();
    const spy = vi.spyOn(client, 'searchStockPhotos');
    const result = await createReadOnlyToolService(client).searchStockPhotos({ projectId: 'project-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an unknown orientation without calling the API', async () => {
    const client = makeApiClient();
    const spy = vi.spyOn(client, 'searchStockPhotos');
    const result = await createReadOnlyToolService(client).searchStockPhotos({
      projectId: 'project-1',
      query: 'mountains',
      orientation: 'diagonal'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('search_stock_photos HTTP proxy', () => {
  it('GETs the existing stock search route and does not mutate the project', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      return new Response(JSON.stringify(sampleSearch), { status: 200 });
    });
    const client = new HttpAppApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: fetchMock as unknown as typeof fetch
    });

    const result = await createReadOnlyToolService(client).searchStockPhotos({
      projectId: 'project-1',
      query: 'mountains',
      orientation: 'landscape',
      limit: 6,
      mode: 'mock'
    });

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'http://127.0.0.1:5555/api/projects/project-1/stock/search?query=mountains&orientation=landscape&limit=6&mode=mock'
    );
    expect(init.method).toBe('GET');
    expect(url).not.toContain('select-stock-image');
    if (result.ok) {
      expect(result.data.results[0].license).toBe('Pexels License');
      expect(result.data.results[0].usagePolicy).toBe('download');
    }
  });

  it('maps throttling to RATE_LIMITED', async () => {
    const client = new HttpAppApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: (async () =>
        new Response(JSON.stringify({ message: 'Too many requests for this endpoint. Try again later.', code: 'RATE_LIMITED' }), {
          status: 429
        })) as unknown as typeof fetch
    });

    const result = await createReadOnlyToolService(client).searchStockPhotos({
      projectId: 'project-1',
      query: 'mountains'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('RATE_LIMITED');
    }
  });

  it('maps invalid search input to INVALID_ARGUMENT', async () => {
    const client = new HttpAppApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: (async () =>
        new Response(JSON.stringify({ message: 'A stock search query is required.', code: 'stock.search.missingQuery' }), {
          status: 400
        })) as unknown as typeof fetch
    });

    const result = await createReadOnlyToolService(client).searchStockPhotos({
      projectId: 'project-1',
      query: 'mountains'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.details?.apiCode).toBe('stock.search.missingQuery');
    }
  });

  it('maps a real-mode policy denial to FORBIDDEN', async () => {
    const client = new HttpAppApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: (async () =>
        new Response(JSON.stringify({ message: 'Real provider mode is disabled on this server.', code: 'stock.policy.denied' }), {
          status: 403
        })) as unknown as typeof fetch
    });

    const result = await createReadOnlyToolService(client).searchStockPhotos({
      projectId: 'project-1',
      query: 'mountains',
      mode: 'real'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details?.apiCode).toBe('stock.policy.denied');
    }
  });

  it('maps upstream provider failure to API_ERROR with diagnostics', async () => {
    const client = new HttpAppApiClient({
      baseUrl: 'http://127.0.0.1:5555',
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            message: 'No stock provider could satisfy the search.',
            code: 'stock.search.noProvider',
            diagnostics: [{ provider: 'pexels', outcome: 'skipped_quota' }]
          }),
          { status: 503 }
        )) as unknown as typeof fetch
    });

    const result = await createReadOnlyToolService(client).searchStockPhotos({
      projectId: 'project-1',
      query: 'mountains',
      mode: 'real'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('API_ERROR');
      expect(result.error.details?.apiCode).toBe('stock.search.noProvider');
      expect(result.error.details?.diagnostics).toEqual([{ provider: 'pexels', outcome: 'skipped_quota' }]);
    }
  });
});

describe('stock search vs HTML slots', () => {
  it('rejects stock CDN URLs as imageAssetId', () => {
    expect(() =>
      parseHtmlStillTemplateData('headline', { title: 'Live', imageAssetId: sampleSearch.results[0].imageUrl })
    ).toThrow(/asset id/);
    expect(() =>
      parseHtmlStillTemplateData('headline', { title: 'Live', imageAssetId: 'https://images.unsplash.com/photo-1' })
    ).toThrow(/asset id/);
  });
});
