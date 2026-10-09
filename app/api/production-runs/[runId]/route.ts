import { NextResponse } from 'next/server';

import { headlessProductionRunService, RunServiceError } from '@/lib/production/run-service';
import { AccessControlError, enforceThrottle, requireIdentity, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

interface RouteContext {
  params: Promise<{ runId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { runId } = await context.params;

  try {
    const identity = requireIdentity(_request);
    enforceThrottle(identity, 'run_status');

    const run = headlessProductionRunService.getRun(runId);
    await requireProjectAccess(_request, run.projectId);
    return NextResponse.json({ run }, { status: 200 });
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
        message: 'Unexpected run status failure.',
        code: 'run.unexpected'
      },
      { status: 500 }
    );
  }
}
