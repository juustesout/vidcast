import { NextResponse } from 'next/server';

import { applyProjectUpdate } from '@/lib/projects/project-update';
import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { projectStore } from '@/lib/storage/project-store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const { project } = await requireProjectAccess(request, id);
    return NextResponse.json({ project });
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ message: 'Invalid project payload.' }, { status: 400 });
  }

  const existingProjectAccess = await (async () => {
    try {
      return await requireProjectAccess(request, id);
    } catch (error) {
      if (error instanceof AccessControlError) {
        return toAccessControlResponse(error);
      }
      return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
    }
  })();

  if (existingProjectAccess instanceof NextResponse) {
    return existingProjectAccess;
  }

  const existingProject = existingProjectAccess.project;

  if ('id' in body && body.id !== id) {
    return NextResponse.json({ message: 'Project id mismatch.' }, { status: 400 });
  }

  const { project: candidate, validation } = applyProjectUpdate(existingProject, body);
  if (!validation.valid) {
    return NextResponse.json(
      {
        message: 'Project validation failed.',
        errors: validation.errors,
        warnings: validation.warnings
      },
      { status: 422 }
    );
  }

  const project = await projectStore.updateProject(candidate);
  return NextResponse.json({ project });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    await requireProjectAccess(_request, id);
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }

  await projectStore.deleteProject(id);
  return NextResponse.json({ ok: true });
}
