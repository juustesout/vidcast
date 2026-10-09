import { NextResponse } from 'next/server';

import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { projectStore } from '@/lib/storage/project-store';

interface RouteContext {
  params: Promise<{ id: string; referenceId: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id, referenceId } = await context.params;

  try {
    await requireProjectAccess(request, id);
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as { name?: string; description?: string; tags?: string[] };

  try {
    const reference = await projectStore.updateReference(id, referenceId, {
      name: body.name,
      description: body.description,
      tags: body.tags
    });
    return NextResponse.json({ reference });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : 'Could not update reference.' }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id, referenceId } = await context.params;

  try {
    await requireProjectAccess(_request, id);
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }

  try {
    const result = await projectStore.deleteReference(id, referenceId);
    if (result.usageSceneIds.length > 0) {
      return NextResponse.json(
        {
          message: `This reference is used by ${result.usageSceneIds.length} scene(s). Remove it from those scenes before deleting.`,
          usageSceneIds: result.usageSceneIds
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : 'Could not delete reference.' }, { status: 400 });
  }
}
