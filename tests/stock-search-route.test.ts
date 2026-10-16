import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as stockSearchRoute } from '@/app/api/projects/[id]/stock/search/route';
import * as stockSearchService from '@/lib/ai/stock/stock-search-service';
import { clearThrottleStateForTests } from '@/lib/security/access-control';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { projectStore } from '@/lib/storage/project-store';

function buildRequest(subject: string | null, query = 'query=mountains'): Request {
  const headers: Record<string, string> = {};
  if (subject) {
    headers.cookie = `${SESSION_COOKIE_NAME}=${createUserSessionCookie(subject)}`;
  }
  return new Request(`http://localhost/api/projects/project-1/stock/search?${query}`, { headers });
}

const context = { params: Promise.resolve({ id: 'project-1' }) };

const sampleResponse = {
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
      imageUrl: 'https://cdn.local/pexels-42.jpg',
      sourceUrl: 'https://pexels.local/42',
      photographerName: 'Ada',
      license: 'Pexels License',
      usagePolicy: 'download' as const
    }
  ],
  diagnostics: [],
  quota: []
};

describe('stock search route', () => {
  beforeEach(() => {
    clearThrottleStateForTests();
    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-1', ownerId: 'user-a' } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearThrottleStateForTests();
  });

  it('requires authentication', async () => {
    const response = await stockSearchRoute(buildRequest(null), context);
    expect(response.status).toBe(401);
  });

  it('hides projects owned by another user', async () => {
    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-1', ownerId: 'user-b' } as never);
    const response = await stockSearchRoute(buildRequest('user-a'), context);
    expect(response.status).toBe(404);
  });

  it('returns the sanitized search response for the owner', async () => {
    const search = vi.spyOn(stockSearchService, 'searchStockPhotos').mockResolvedValue(sampleResponse);

    const response = await stockSearchRoute(buildRequest('user-a', 'query=mountains&orientation=landscape&limit=6'), context);
    const body = (await response.json()) as { searchId?: string; results?: unknown[] };

    expect(response.status).toBe(200);
    expect(body.searchId).toBe('stocksearch_1');
    expect(body.results).toHaveLength(1);
    expect(search).toHaveBeenCalledWith({
      query: 'mountains',
      orientation: 'landscape',
      providers: undefined,
      limit: 6,
      mode: null
    });
  });

  it('maps a service failure to its status and code with diagnostics', async () => {
    vi.spyOn(stockSearchService, 'searchStockPhotos').mockRejectedValue(
      new stockSearchService.StockSearchError('No provider available.', 503, 'stock.search.noProvider', [
        { provider: 'pexels', outcome: 'skipped_quota' }
      ])
    );

    const response = await stockSearchRoute(buildRequest('user-a'), context);
    const body = (await response.json()) as { code?: string; diagnostics?: unknown[] };

    expect(response.status).toBe(503);
    expect(body.code).toBe('stock.search.noProvider');
    expect(body.diagnostics).toHaveLength(1);
  });

  it.each([
    ['query=', 'stock.search.missingQuery'],
    ['query=x&orientation=diagonal', 'stock.search.invalidOrientation'],
    ['query=x&providers=bogus', 'stock.search.invalidProvider'],
    ['query=x&limit=0', 'stock.search.invalidLimit'],
    ['query=x&mode=hyper', 'stock.search.invalidMode']
  ])('rejects invalid input (%s)', async (query, code) => {
    const search = vi.spyOn(stockSearchService, 'searchStockPhotos');
    const response = await stockSearchRoute(buildRequest('user-a', query), context);
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe(code);
    expect(search).not.toHaveBeenCalled();
  });

  it('rate limits repeated searches for the same identity', async () => {
    vi.stubEnv('API_THROTTLE_STOCK_SEARCH_LIMIT', '1');
    vi.spyOn(stockSearchService, 'searchStockPhotos').mockResolvedValue(sampleResponse);

    const first = await stockSearchRoute(buildRequest('user-a'), context);
    const second = await stockSearchRoute(buildRequest('user-a'), context);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    vi.unstubAllEnvs();
  });
});
