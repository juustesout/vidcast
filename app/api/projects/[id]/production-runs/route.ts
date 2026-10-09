import { NextResponse } from 'next/server';
import * as z from 'zod/v4';

import { headlessProductionRunService, RunServiceError } from '@/lib/production/run-service';
import { AccessControlError, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const startRunSchema = z.object({
  mode: z.enum(['mock', 'real']).optional(),
  providers: z
    .object({
      image: z.enum(['fake', 'openai']).optional(),
      video: z.enum(['local', 'openai']).optional(),
      narration: z.enum(['fake', 'elevenlabs']).optional()
    })
    .optional(),
  maxIterations: z.number().int().positive().max(10_000).optional(),
  limits: z
    .object({
      image_generate: z.number().int().positive().max(128).optional(),
      video_submit: z.number().int().positive().max(128).optional(),
      video_poll: z.number().int().positive().max(128).optional(),
      narration_generate: z.number().int().positive().max(128).optional(),
      scene_render: z.number().int().positive().max(128).optional(),
      final_compose: z.number().int().positive().max(128).optional()
    })
    .optional()
});

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const { identity } = await requireProjectAccess(request, id);
    enforceThrottle(identity, 'run_start');
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authorization failure.', code: 'auth.unexpected' }, { status: 500 });
  }

  const rawBody = (await request.json().catch(() => ({}))) as unknown;

  const parsed = startRunSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        message: 'Invalid run start payload.',
        code: 'INVALID_ARGUMENT',
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            code: issue.code,
            message: issue.message
          }))
        }
      },
      { status: 400 }
    );
  }

  try {
    const result = await headlessProductionRunService.startOrReuseRun({
      projectId: id,
      policy: {
        mode: parsed.data.mode,
        providers: parsed.data.providers
      },
      maxIterations: parsed.data.maxIterations,
      limits: parsed.data.limits
    });

    return NextResponse.json(
      {
        run: result.run,
        reused: result.reused
      },
      { status: result.reused ? 200 : 202 }
    );
  } catch (error) {
    if (error instanceof RunServiceError) {
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
        message: 'Unexpected run start failure.',
        code: 'run.unexpected'
      },
      { status: 500 }
    );
  }
}
