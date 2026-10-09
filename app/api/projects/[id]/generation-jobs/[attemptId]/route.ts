import { NextResponse } from 'next/server';

import { refreshVideoGenerationAttempt, SceneVideoGenerationError } from '@/lib/generation/video-generation-service';
import { AccessControlError, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

interface RouteContext {
  params: Promise<{ id: string; attemptId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const { id, attemptId } = await context.params;
  const { searchParams } = new URL(request.url);
  const poll = searchParams.get('poll');

  try {
    const { identity } = await requireProjectAccess(request, id);
    enforceThrottle(identity, 'video_poll');
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authorization failure.', code: 'auth.unexpected' }, { status: 500 });
  }

  try {
    const result = await refreshVideoGenerationAttempt(id, attemptId);
    return NextResponse.json({ ...result, polled: poll !== '0' }, { status: 200 });
  } catch (error) {
    if (error instanceof SceneVideoGenerationError) {
      return NextResponse.json(
        {
          message: error.message,
          code: error.code
        },
        { status: error.status }
      );
    }

    return NextResponse.json(
      {
        message: 'Unexpected internal generation failure.',
        code: 'generation.unexpected'
      },
      { status: 500 }
    );
  }
}
