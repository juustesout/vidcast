import { NextResponse } from 'next/server';

import { cancelSceneVideoGeneration, SceneVideoGenerationError } from '@/lib/generation/video-generation-service';
import { AccessControlError, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

interface RouteContext {
  params: Promise<{ id: string; sceneId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id, sceneId } = await context.params;

  try {
    const { identity } = await requireProjectAccess(request, id);
    enforceThrottle(identity, 'cancel_video');
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authorization failure.', code: 'auth.unexpected' }, { status: 500 });
  }

  try {
    const result = await cancelSceneVideoGeneration(id, sceneId);
    return NextResponse.json(result, { status: 200 });
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
        message: 'Unexpected internal cancellation failure.',
        code: 'generation.unexpected'
      },
      { status: 500 }
    );
  }
}
