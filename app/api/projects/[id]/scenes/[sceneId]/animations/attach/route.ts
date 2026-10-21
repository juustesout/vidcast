import { NextResponse } from 'next/server';

import { attachAnimationToScene } from '@/lib/animation/attach-service';
import { AnimationError, animationHttpStatus } from '@/lib/animation/errors';
import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

interface RouteContext {
  params: Promise<{ id: string; sceneId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id, sceneId } = await context.params;

  try {
    await requireProjectAccess(request, id);
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ message: 'Invalid animation attach payload.', code: 'animation.params.invalid' }, { status: 400 });
  }

  try {
    const result = await attachAnimationToScene({
      ...body,
      projectId: id,
      sceneId
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof AnimationError) {
      return NextResponse.json(
        { message: error.message, code: error.code, details: error.details },
        { status: animationHttpStatus(error.code) }
      );
    }
    return NextResponse.json({ message: 'Could not attach animation to scene.', code: 'animation.params.invalid' }, { status: 500 });
  }
}
