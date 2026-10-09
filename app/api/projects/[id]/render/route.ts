import { NextResponse } from 'next/server';

import { AccessControlError, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { projectStore } from '@/lib/storage/project-store';
import { sceneRenderService } from '@/lib/render/scene-render-service';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  let project: Awaited<ReturnType<typeof projectStore.getProject>>;
  try {
    const access = await requireProjectAccess(_request, id);
    enforceThrottle(access.identity, 'render_scene');
    project = access.project;
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }

  const sceneId = project.scenes[0]?.id;
  if (!sceneId) {
    return NextResponse.json({ message: 'Project has no scenes to render.' }, { status: 400 });
  }

  const result = await sceneRenderService.renderScene(id, sceneId);

  return NextResponse.json(
    {
      message: 'Scene render completed.',
      ...result
    },
    { status: 200 }
  );
}
