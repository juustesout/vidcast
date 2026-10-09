import { NextResponse } from 'next/server';

import { videoCompositionService, CompositionServiceError } from '@/lib/render/video-composition-service';
import { AccessControlError, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const { identity } = await requireProjectAccess(request, id);
    enforceThrottle(identity, 'compose_project');
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authorization failure.', code: 'auth.unexpected' }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as { transition?: { type?: 'none' | 'fade'; duration?: number } };

  try {
    const result = await videoCompositionService.composeProject(id, {
      transition: {
        type: body.transition?.type === 'fade' ? 'fade' : 'none',
        duration: body.transition?.duration
      }
    });

    return NextResponse.json(
      {
        message: 'Project composition completed.',
        ...result
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof CompositionServiceError) {
      const status = error.code === 'PROJECT_NOT_FOUND'
        ? 404
        : error.code === 'SCENE_MISSING' || error.code === 'SCENE_RENDER_MISSING' || error.code === 'RENDER_FILE_MISSING' || error.code === 'INCOMPATIBLE_RENDER'
          ? 422
          : error.code === 'FFMPEG_UNAVAILABLE'
            ? 503
            : 500;

      return NextResponse.json(
        {
          message: error.message,
          code: error.code,
          details: error.details
        },
        { status }
      );
    }

    return NextResponse.json(
      {
        message: 'Unexpected composition failure.',
        code: 'compose.unexpected'
      },
      { status: 500 }
    );
  }
}
