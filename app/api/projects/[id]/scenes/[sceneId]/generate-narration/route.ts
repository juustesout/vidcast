import { NextResponse } from 'next/server';

import { generateSceneNarration, SceneNarrationGenerationError } from '@/lib/generation/narration-service';
import type { TextToSpeechFormat } from '@/lib/ai/text-to-speech/provider';
import { AccessControlError, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

interface RouteContext {
  params: Promise<{ id: string; sceneId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id, sceneId } = await context.params;

  try {
    const { identity } = await requireProjectAccess(request, id);
    enforceThrottle(identity, 'generate_narration');
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authorization failure.', code: 'auth.unexpected' }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    text?: string;
    voiceId?: string;
    model?: string;
    format?: TextToSpeechFormat;
    provider?: string;
    regenerate?: boolean;
    retry?: boolean;
    settings?: {
      stability?: number;
      similarityBoost?: number;
      style?: number;
      speakerBoost?: boolean;
    };
  };

  try {
    const result = await generateSceneNarration(id, sceneId, {
      text: body.text,
      voiceId: body.voiceId,
      model: body.model,
      format: body.format,
      provider: body.provider,
      regenerate: Boolean(body.regenerate || body.retry),
      settings: body.settings
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof SceneNarrationGenerationError) {
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
        message: 'Unexpected internal narration generation failure.',
        code: 'narration.unexpected'
      },
      { status: 500 }
    );
  }
}
