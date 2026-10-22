import { NextResponse } from 'next/server';

import { HtmlStillError } from '@/lib/render/html-still/errors';
import { renderSceneHtmlStill } from '@/lib/render/html-still/service';
import { AccessControlError, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

interface RouteContext {
  params: Promise<{ id: string; sceneId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id, sceneId } = await context.params;

  try {
    const { identity } = await requireProjectAccess(request, id);
    enforceThrottle(identity, 'render_scene');
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authorization failure.', code: 'auth.unexpected' }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as { regenerate?: boolean };

  try {
    const result = await renderSceneHtmlStill(id, sceneId, { regenerate: Boolean(body.regenerate) });
    return NextResponse.json({
      message: result.reused ? 'HTML still PNG is current.' : 'HTML still PNG rendered.',
      ...result
    }, { status: 200 });
  } catch (error) {
    if (error instanceof HtmlStillError) {
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
        message: 'Unexpected HTML still render failure.',
        code: 'html.unexpected'
      },
      { status: 500 }
    );
  }
}
