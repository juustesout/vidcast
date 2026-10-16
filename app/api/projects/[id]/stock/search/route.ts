import { NextResponse } from 'next/server';

import { isStockProviderId } from '@/lib/ai/stock/catalog';
import { searchStockPhotos, StockSearchError } from '@/lib/ai/stock/stock-search-service';
import type { RunMode } from '@/lib/production/run-types';
import { AccessControlError, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import type { StockOrientation, StockProviderId } from '@/lib/types/stock';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ORIENTATIONS: StockOrientation[] = ['landscape', 'portrait', 'squarish'];
const MODES: RunMode[] = ['mock', 'real'];

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const { identity } = await requireProjectAccess(request, id);
    enforceThrottle(identity, 'stock_search');
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authorization failure.', code: 'auth.unexpected' }, { status: 500 });
  }

  const url = new URL(request.url);
  const query = (url.searchParams.get('query') ?? '').trim();
  if (!query) {
    return NextResponse.json({ message: 'A stock search query is required.', code: 'stock.search.missingQuery' }, { status: 400 });
  }

  const orientationRaw = url.searchParams.get('orientation');
  if (orientationRaw && !ORIENTATIONS.includes(orientationRaw as StockOrientation)) {
    return NextResponse.json({ message: `Unsupported orientation: ${orientationRaw}.`, code: 'stock.search.invalidOrientation' }, { status: 400 });
  }

  const providersRaw = url.searchParams.get('providers');
  let providers: StockProviderId[] | undefined;
  if (providersRaw) {
    const parsed = providersRaw.split(',').map((entry) => entry.trim()).filter(Boolean);
    const invalid = parsed.filter((entry) => !isStockProviderId(entry));
    if (invalid.length > 0) {
      return NextResponse.json({ message: `Unsupported stock provider(s): ${invalid.join(', ')}.`, code: 'stock.search.invalidProvider' }, { status: 400 });
    }
    providers = parsed as StockProviderId[];
  }

  let limit: number | undefined;
  const limitRaw = url.searchParams.get('limit');
  if (limitRaw) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return NextResponse.json({ message: 'limit must be a positive integer.', code: 'stock.search.invalidLimit' }, { status: 400 });
    }
    limit = parsed;
  }

  const modeRaw = url.searchParams.get('mode');
  if (modeRaw && !MODES.includes(modeRaw as RunMode)) {
    return NextResponse.json({ message: `Unsupported mode: ${modeRaw}.`, code: 'stock.search.invalidMode' }, { status: 400 });
  }

  try {
    const result = await searchStockPhotos({
      query,
      orientation: orientationRaw as StockOrientation | undefined,
      providers,
      limit,
      mode: modeRaw as RunMode | undefined
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof StockSearchError) {
      return NextResponse.json(
        { message: error.message, code: error.code, diagnostics: error.diagnostics },
        { status: error.status }
      );
    }
    return NextResponse.json({ message: 'Unexpected internal stock search failure.', code: 'stock.search.unexpected' }, { status: 500 });
  }
}
