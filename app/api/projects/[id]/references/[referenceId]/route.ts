import { NextResponse } from 'next/server';

import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { projectStore, type ReferenceDeletionUsage } from '@/lib/storage/project-store';

interface RouteContext {
  params: Promise<{ id: string; referenceId: string }>;
}

function describeBlockingUsage(usage: ReferenceDeletionUsage): string {
  const parts: string[] = [];
  if (usage.usageSceneIds.length > 0) {
    parts.push(`${usage.usageSceneIds.length} scene(s)`);
  }
  if (usage.usageAssetIds.length > 0) {
    parts.push(`${usage.usageAssetIds.length} generated asset(s)`);
  }

  const target = parts.join(' and ');
  if (usage.usageAssetIds.length > 0) {
    return `This reference is used by ${target}. Unbind or delete those assets first, then delete the reference.`;
  }
  return `This reference is used by ${target}. Remove it from those scenes before deleting.`;
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
    if (result.usageSceneIds.length > 0 || result.usageAssetIds.length > 0) {
      return NextResponse.json(
        {
          message: describeBlockingUsage(result),
          usageSceneIds: result.usageSceneIds,
          usageAssetIds: result.usageAssetIds
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : 'Could not delete reference.' }, { status: 400 });
  }
}
