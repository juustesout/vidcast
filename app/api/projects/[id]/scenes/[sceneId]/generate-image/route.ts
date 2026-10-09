import { NextResponse } from 'next/server';

import { generateSceneImage, SceneImageGenerationError } from '@/lib/generation/image-generation-service';
import { AccessControlError, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

interface RouteContext {
  params: Promise<{ id: string; sceneId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id, sceneId } = await context.params;

  try {
    const { identity } = await requireProjectAccess(request, id);
    enforceThrottle(identity, 'generate_image');
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authorization failure.', code: 'auth.unexpected' }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as { regenerate?: boolean };

  try {
    const result = await generateSceneImage(id, sceneId, { regenerate: Boolean(body.regenerate) });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof SceneImageGenerationError) {
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
