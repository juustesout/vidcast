import { NextResponse } from 'next/server';

import { headlessProductionRunService, RunServiceError } from '@/lib/production/run-service';
import { AccessControlError, enforceThrottle, requireIdentity, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

interface RouteContext {
  params: Promise<{ runId: string }>;
}

function parseQueryInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

export async function GET(request: Request, context: RouteContext) {
  const { runId } = await context.params;
  const { searchParams } = new URL(request.url);

  const cursor = parseQueryInteger(searchParams.get('cursor'));
  const limit = parseQueryInteger(searchParams.get('limit'));

  if (typeof cursor === 'number' && cursor < 0) {
    return NextResponse.json(
      {
        message: 'cursor must be zero or greater.',
        code: 'INVALID_ARGUMENT'
      },
      { status: 400 }
    );
  }

  if (typeof limit === 'number' && limit <= 0) {
    return NextResponse.json(
      {
        message: 'limit must be greater than zero.',
        code: 'INVALID_ARGUMENT'
      },
      { status: 400 }
    );
  }

  try {
    const identity = requireIdentity(request);
    enforceThrottle(identity, 'run_log');

    const run = headlessProductionRunService.getRun(runId);
    await requireProjectAccess(request, run.projectId);

    const log = headlessProductionRunService.getRunLog(runId, {
      cursor,
      limit
    });
    return NextResponse.json({ log }, { status: 200 });
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }

    if (error instanceof RunServiceError) {
      return NextResponse.json(
        {
          message: error.message,
          code: error.code,
          details: error.details
        },
        { status: error.status }
      );
    }

    return NextResponse.json(
      {
        message: 'Unexpected run log failure.',
        code: 'run.unexpected'
      },
      { status: 500 }
    );
  }
}
