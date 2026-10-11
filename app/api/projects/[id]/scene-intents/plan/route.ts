import { NextResponse } from 'next/server';

import { planSceneIntentsFromBeats } from '@/lib/explainer/scene-intent-planner';
import { applyProjectUpdate, ProjectUpdateValidationError } from '@/lib/projects/project-update';
import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { projectStore } from '@/lib/storage/project-store';
import { validateProject } from '@/lib/validation/project-validation';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { project?: unknown };

  let existing: Awaited<ReturnType<typeof projectStore.getProject>>;
  try {
    const access = await requireProjectAccess(request, id);
    existing = access.project;
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }

  const initial = applyProjectUpdate(existing, body.project ?? existing);
  if (!initial.validation.valid) {
    return NextResponse.json({ message: 'Project validation failed.', errors: initial.validation.errors, warnings: initial.validation.warnings }, { status: 422 });
  }

  let createdIntentIds: string[] = [];
  let project: Awaited<ReturnType<typeof projectStore.mutateProject>>;
  try {
    project = await projectStore.mutateProject(id, (current) => {
      const { project: candidate, validation } = applyProjectUpdate(current, body.project ?? current);
      if (!validation.valid) {
        throw new ProjectUpdateValidationError(validation, 'Project validation failed.');
      }

      const result = planSceneIntentsFromBeats(candidate);
      const finalValidation = validateProject(result.project);
      if (!finalValidation.valid) {
        throw new ProjectUpdateValidationError(finalValidation, 'Planned scene intents are invalid.');
      }

      createdIntentIds = result.createdIntentIds;
      return result.project;
    });
  } catch (error) {
    if (error instanceof ProjectUpdateValidationError) {
      return NextResponse.json({ message: error.message, errors: error.validation.errors, warnings: error.validation.warnings }, { status: 422 });
    }
    throw error;
  }

  if (!project) {
    return NextResponse.json({ message: 'Project not found.', code: 'project.notFound' }, { status: 404 });
  }

  return NextResponse.json({ project, createdIntentIds }, { status: 200 });
}
