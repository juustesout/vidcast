import { NextResponse } from 'next/server';

import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { importStudioAssets, StudioImportError, studioImportHttpStatus } from '@/lib/storage/studio-import';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;

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
    return NextResponse.json({ message: 'Invalid studio import payload.', code: 'studio.import.invalidName' }, { status: 400 });
  }

  const fileNames = Array.isArray(body.fileNames) ? body.fileNames : undefined;
  if (!fileNames) {
    return NextResponse.json({ message: 'Expected fileNames array.', code: 'studio.import.emptyList' }, { status: 400 });
  }

  try {
    const result = await importStudioAssets(id, fileNames.map((entry) => String(entry)));
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof StudioImportError) {
      return NextResponse.json(
        { message: error.message, code: error.code, details: error.details },
        { status: studioImportHttpStatus(error.code) }
      );
    }
    return NextResponse.json({ message: 'Could not import studio assets.', code: 'studio.import.copyFailed' }, { status: 500 });
  }
}
