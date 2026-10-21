import { NextResponse } from 'next/server';

import { AnimationError, animationHttpStatus } from '@/lib/animation/errors';
import { renderAnimationTemplate } from '@/lib/animation/render-service';
import { AccessControlError, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const { identity } = await requireProjectAccess(request, id);
    enforceThrottle(identity, 'render_scene');
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ message: 'Invalid animation render payload.', code: 'animation.params.invalid' }, { status: 400 });
  }

  try {
    const result = await renderAnimationTemplate({
      ...body,
      projectId: id
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof AnimationError) {
      return NextResponse.json(
        { message: error.message, code: error.code, details: error.details },
        { status: animationHttpStatus(error.code) }
      );
    }
    return NextResponse.json({ message: 'Could not render animation template.', code: 'animation.render.failed' }, { status: 500 });
  }
}
