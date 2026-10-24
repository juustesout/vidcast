import { NextResponse } from 'next/server';

import { ImportedImageError, validateImportedImage } from '@/lib/projects/imported-image';
import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { projectStore } from '@/lib/storage/project-store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function handleJsonUpload(request: Request, projectId: string): Promise<NextResponse> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ message: 'Invalid JSON asset payload.', code: 'asset.invalid' }, { status: 400 });
  }

  let validated;
  try {
    validated = validateImportedImage({
      filename: body.filename,
      mimeType: body.mimeType,
      dataBase64: body.dataBase64
    });
  } catch (error) {
    if (error instanceof ImportedImageError) {
      return NextResponse.json(
        { message: error.message, code: error.code, details: error.details },
        { status: error.status }
      );
    }
    return NextResponse.json({ message: 'Could not import asset.', code: 'asset.invalid' }, { status: 400 });
  }

  const file = new File([new Uint8Array(validated.bytes)], validated.filename, { type: validated.mimeType });

  try {
    const asset = await projectStore.importAsset(projectId, file);
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : 'Could not import asset.', code: 'asset.storeFailed' }, { status: 400 });
  }
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const { project } = await requireProjectAccess(request, id);
    return NextResponse.json({ assets: project.assets });
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }
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

  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return handleJsonUpload(request, id);
  }

  const formData = await request.formData();
  const file = formData.get('file');

  if (!(file instanceof File)) {
    return NextResponse.json({ message: 'Expected upload field "file".' }, { status: 400 });
  }

  try {
    const asset = await projectStore.importAsset(id, file);
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : 'Could not import asset.' }, { status: 400 });
  }
}
