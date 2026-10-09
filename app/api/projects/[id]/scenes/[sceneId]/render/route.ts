import { NextResponse } from 'next/server';

import { sceneRenderService } from '@/lib/render/scene-render-service';
import { SceneRenderError } from '@/lib/render/renderer';
import { AccessControlError, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

interface RouteContext {
  params: Promise<{ id: string; sceneId: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  const { id, sceneId } = await context.params;

  try {
    const { identity } = await requireProjectAccess(_request, id);
    enforceThrottle(identity, 'render_scene');
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authorization failure.', code: 'auth.unexpected' }, { status: 500 });
  }

  try {
    const result = await sceneRenderService.renderScene(id, sceneId);
    return NextResponse.json(
      {
        message: 'Scene render completed.',
        ...result
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof SceneRenderError) {
      return NextResponse.json(
        {
          message: error.message,
          code: error.code,
          details: error.details
        },
        { status: error.code === 'MISSING_ASSET' ? 404 : error.code === 'INVALID_PLAN' || error.code === 'UNSUPPORTED_RENDER' ? 422 : 500 }
      );
    }

    return NextResponse.json(
      {
        message: 'Unexpected internal render failure.',
        code: 'render.unexpected'
      },
      { status: 500 }
    );
  }
}
