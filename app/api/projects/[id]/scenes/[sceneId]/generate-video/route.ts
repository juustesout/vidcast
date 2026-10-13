import { NextResponse } from 'next/server';

import { SceneVideoGenerationError, submitSceneVideoGeneration } from '@/lib/generation/video-generation-service';
import { AccessControlError, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

interface RouteContext {
  params: Promise<{ id: string; sceneId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id, sceneId } = await context.params;

  try {
    const { identity } = await requireProjectAccess(request, id);
    enforceThrottle(identity, 'generate_video');
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authorization failure.', code: 'auth.unexpected' }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as { regenerate?: boolean; provider?: string; model?: string; mode?: 'mock' | 'real' };

  // Provider/model selected in the scene inspector are forwarded so a stored
  // `fal` (or any non-default) provider is honoured instead of falling back to
  // server defaults. Server-side mock/real gating and credential checks still run
  // inside `submitSceneVideoGeneration`, so this cannot bypass policy.
  const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : undefined;
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
  const mode = body.mode === 'mock' || body.mode === 'real' ? body.mode : undefined;

  try {
    const result = await submitSceneVideoGeneration(id, sceneId, {
      regenerate: Boolean(body.regenerate),
      provider,
      model,
      mode
    });
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
        message: 'Unexpected internal generation failure.',
        code: 'generation.unexpected'
      },
      { status: 500 }
    );
  }
}
