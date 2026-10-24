import { NextResponse } from 'next/server';

import { resolveStockPhoto, StockSearchError } from '@/lib/ai/stock/stock-search-service';
import { selectSceneStockImage, selectSceneStockPhoto, StockImageSelectionError } from '@/lib/generation/stock-image-service';
import type { RunMode } from '@/lib/production/run-types';
import { AccessControlError, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import type { StockOrientation } from '@/lib/types/stock';

interface RouteContext {
  params: Promise<{ id: string; sceneId: string }>;
}

type SelectAction = 'auto' | 'choose';

const MODES: RunMode[] = ['mock', 'real'];

export async function POST(request: Request, context: RouteContext) {
  const { id, sceneId } = await context.params;

  let identity;
  try {
    const access = await requireProjectAccess(request, id);
    identity = access.identity;
    enforceThrottle(identity, 'stock_select');
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authorization failure.', code: 'auth.unexpected' }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: SelectAction;
    regenerate?: boolean;
    mode?: RunMode;
    searchId?: string;
    photoId?: string;
    query?: string;
    orientation?: StockOrientation;
  };

  const action: SelectAction = body.action ?? (body.searchId && body.photoId ? 'choose' : 'auto');

  if (body.mode && !MODES.includes(body.mode)) {
    return NextResponse.json({ message: `Unsupported mode: ${body.mode}.`, code: 'stock.select.invalidMode' }, { status: 400 });
  }

  try {
    if (action === 'choose') {
      if (!body.searchId || !body.photoId) {
        return NextResponse.json(
          { message: 'searchId and photoId are required to choose a stock photo.', code: 'stock.select.missingCandidate' },
          { status: 400 }
        );
      }
      const { photo, query, orientation } = resolveStockPhoto(body.searchId, body.photoId);
      const result = await selectSceneStockPhoto(id, sceneId, photo, {
        query: body.query ?? query,
        orientation: body.orientation ?? orientation,
        regenerate: Boolean(body.regenerate),
        mode: body.mode,
        identity
      });
      return NextResponse.json({ action, ...result }, { status: 200 });
    }

    if (action !== 'auto') {
      return NextResponse.json({ message: `Unsupported stock selection action: ${action}.`, code: 'stock.select.invalidAction' }, { status: 400 });
    }

    const result = await selectSceneStockImage(id, sceneId, {
      regenerate: Boolean(body.regenerate),
      mode: body.mode,
      identity
    });
    return NextResponse.json({ action, ...result }, { status: 200 });
  } catch (error) {
    if (error instanceof StockImageSelectionError) {
      return NextResponse.json({ message: error.message, code: error.code, diagnostics: error.diagnostics }, { status: error.status });
    }
    if (error instanceof StockSearchError) {
      return NextResponse.json({ message: error.message, code: error.code, diagnostics: error.diagnostics }, { status: error.status });
    }
    return NextResponse.json({ message: 'Unexpected internal stock selection failure.', code: 'stock.select.unexpected' }, { status: 500 });
  }
}
