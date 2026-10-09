import { NextResponse } from 'next/server';

import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { projectStore } from '@/lib/storage/project-store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function parseTags(value: FormDataEntryValue | null): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const { project } = await requireProjectAccess(request, id);
    return NextResponse.json({ references: project.references });
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

  const formData = await request.formData();
  const file = formData.get('file');
  const name = formData.get('name');
  const description = formData.get('description');
  const tags = parseTags(formData.get('tags'));

  if (!(file instanceof File)) {
    return NextResponse.json({ message: 'Expected upload field "file".' }, { status: 400 });
  }

  if (typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ message: 'Reference name is required.' }, { status: 400 });
  }

  try {
    const reference = await projectStore.importReference(id, file, name, typeof description === 'string' ? description : '', tags);
    return NextResponse.json({ reference }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : 'Could not import reference.' }, { status: 400 });
  }
}
