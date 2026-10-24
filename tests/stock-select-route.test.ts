import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as selectStockRoute } from '@/app/api/projects/[id]/scenes/[sceneId]/select-stock-image/route';
import * as stockSearchService from '@/lib/ai/stock/stock-search-service';
import * as stockImageService from '@/lib/generation/stock-image-service';
import { clearThrottleStateForTests } from '@/lib/security/access-control';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { projectStore } from '@/lib/storage/project-store';
import type { StockPhoto } from '@/lib/types/stock';

function buildRequest(subject: string | null, body: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (subject) {
    headers.cookie = `${SESSION_COOKIE_NAME}=${createUserSessionCookie(subject)}`;
  }
  return new Request('http://localhost/api/projects/project-1/scenes/scene-1/select-stock-image', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

const context = { params: Promise.resolve({ id: 'project-1', sceneId: 'scene-1' }) };

const photo: StockPhoto = {
  provider: 'pexels',
  photoId: '42',
  width: 1200,
  height: 800,
  imageUrl: 'https://cdn.local/pexels-42.jpg',
  sourceUrl: 'https://pexels.local/42',
  photographerName: 'Ada',
  usagePolicy: 'download',
  attribution: {
    provider: 'pexels',
    providerName: 'pexels',
    photoId: '42',
    photographerName: 'Ada',
    sourceUrl: 'https://pexels.local/42',
    license: 'Pexels License'
  }
};

const selectionResult: stockImageService.StockSelectionExecutionResult = {
  sceneId: 'scene-1',
  status: 'selected',
  provider: 'pexels',
  photoId: '42',
  usagePolicy: 'download',
  assetId: 'asset_1',
  cached: false,
  attribution: photo.attribution
};

describe('select-stock-image route', () => {
  beforeEach(() => {
    clearThrottleStateForTests();
    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-1', ownerId: 'user-a' } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearThrottleStateForTests();
  });

  it('requires authentication', async () => {
    const response = await selectStockRoute(buildRequest(null, { action: 'auto' }), context);
    expect(response.status).toBe(401);
  });

  it('hides projects owned by another user', async () => {
    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-1', ownerId: 'user-b' } as never);
    const response = await selectStockRoute(buildRequest('user-a', { action: 'auto' }), context);
    expect(response.status).toBe(404);
  });

  it('routes auto selection through selectSceneStockImage', async () => {
    const auto = vi.spyOn(stockImageService, 'selectSceneStockImage').mockResolvedValue(selectionResult);

    const response = await selectStockRoute(buildRequest('user-a', { action: 'auto' }), context);
    const body = (await response.json()) as { action?: string; provider?: string };

    expect(response.status).toBe(200);
    expect(body.action).toBe('auto');
    expect(body.provider).toBe('pexels');
    expect(auto).toHaveBeenCalledWith('project-1', 'scene-1', {
      regenerate: false,
      mode: undefined,
      identity: expect.objectContaining({ kind: 'user', subject: 'user-a', authType: 'session' })
    });
  });

  it('resolves a chosen candidate server-side and applies it', async () => {
    vi.spyOn(stockSearchService, 'resolveStockPhoto').mockReturnValue({
      query: 'mountains',
      orientation: 'landscape',
      photo
    });
    const choose = vi.spyOn(stockImageService, 'selectSceneStockPhoto').mockResolvedValue(selectionResult);

    const response = await selectStockRoute(
      buildRequest('user-a', { action: 'choose', searchId: 'stocksearch_1', photoId: 'pexels:42', query: 'mountains' }),
      context
    );
    const body = (await response.json()) as { action?: string; assetId?: string };

    expect(response.status).toBe(200);
    expect(body.action).toBe('choose');
    expect(body.assetId).toBe('asset_1');
    expect(choose).toHaveBeenCalledWith('project-1', 'scene-1', photo, {
      query: 'mountains',
      orientation: 'landscape',
      regenerate: false,
      mode: undefined,
      identity: expect.objectContaining({ kind: 'user', subject: 'user-a', authType: 'session' })
    });
  });

  it('rejects a choose request without a candidate reference', async () => {
    const resolve = vi.spyOn(stockSearchService, 'resolveStockPhoto');
    const response = await selectStockRoute(buildRequest('user-a', { action: 'choose' }), context);
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe('stock.select.missingCandidate');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('maps an expired search to 409', async () => {
    vi.spyOn(stockSearchService, 'resolveStockPhoto').mockImplementation(() => {
      throw new stockSearchService.StockSearchError('Expired.', 409, 'stock.search.expired');
    });

    const response = await selectStockRoute(
      buildRequest('user-a', { action: 'choose', searchId: 'old', photoId: 'pexels:42' }),
      context
    );
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(409);
    expect(body.code).toBe('stock.search.expired');
  });

  it('maps a selection failure to its status and code', async () => {
    vi.spyOn(stockImageService, 'selectSceneStockImage').mockRejectedValue(
      new stockImageService.StockImageSelectionError('Provider not allowed.', 403, 'stock.provider.notAllowed')
    );

    const response = await selectStockRoute(buildRequest('user-a', { action: 'auto' }), context);
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(403);
    expect(body.code).toBe('stock.provider.notAllowed');
  });
});
