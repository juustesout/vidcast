import { NextResponse } from 'next/server';

import {
  clearProjectMusic,
  generateProjectMusic,
  ProjectMusicGenerationError,
  selectProjectMusic
} from '@/lib/generation/music-service';
import { AccessControlError, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

interface RouteContext {
  params: Promise<{ id: string }>;
}

type MusicAction = 'generate' | 'regenerate' | 'select' | 'clear';

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const { project } = await requireProjectAccess(request, id);
    return NextResponse.json({ music: project.music ?? null }, { status: 200 });
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authorization failure.', code: 'auth.unexpected' }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const { identity } = await requireProjectAccess(request, id);
    enforceThrottle(identity, 'generate_music');
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authorization failure.', code: 'auth.unexpected' }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: MusicAction;
    prompt?: string;
    musicLengthMs?: number;
    instrumental?: boolean;
    model?: string;
    provider?: string;
    seed?: number;
    outputFormat?: string;
    assetId?: string;
    mode?: 'mock' | 'real';
  };

  const action: MusicAction = body.action ?? 'generate';

  try {
    if (action === 'clear') {
      const result = await clearProjectMusic(id);
      return NextResponse.json({ action, ...result }, { status: 200 });
    }

    if (action === 'select') {
      if (!body.assetId) {
        return NextResponse.json({ message: 'An assetId is required to select background music.', code: 'music.invalid' }, { status: 400 });
      }
      const result = await selectProjectMusic(id, body.assetId);
      return NextResponse.json({ action, ...result }, { status: 200 });
    }

    if (action !== 'generate' && action !== 'regenerate') {
      return NextResponse.json({ message: `Unsupported music action: ${action}.`, code: 'music.invalid' }, { status: 400 });
    }

    const result = await generateProjectMusic(id, {
      prompt: body.prompt,
      musicLengthMs: body.musicLengthMs,
      instrumental: body.instrumental,
      model: body.model,
      provider: body.provider,
      seed: body.seed,
      outputFormat: body.outputFormat,
      regenerate: action === 'regenerate',
      mode: body.mode
    });

    return NextResponse.json({ action, ...result }, { status: 200 });
  } catch (error) {
    if (error instanceof ProjectMusicGenerationError) {
      return NextResponse.json({ message: error.message, code: error.code }, { status: error.status });
    }

    return NextResponse.json({ message: 'Unexpected internal music generation failure.', code: 'music.unexpected' }, { status: 500 });
  }
}
