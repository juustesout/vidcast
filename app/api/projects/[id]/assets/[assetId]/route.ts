import { NextResponse } from 'next/server';

import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { projectStore } from '@/lib/storage/project-store';

interface RouteContext {
  params: Promise<{ id: string; assetId: string }>;
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id, assetId } = await context.params;

  try {
    await requireProjectAccess(_request, id);
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }

  try {
    const result = await projectStore.deleteAsset(id, assetId);
    if (result.usageSceneIds.length > 0) {
      return NextResponse.json(
        {
          message: `This asset is used by ${result.usageSceneIds.length} scene(s). Remove it from those scenes before deleting.`,
          usageSceneIds: result.usageSceneIds
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : 'Could not delete asset.' }, { status: 400 });
  }
}
