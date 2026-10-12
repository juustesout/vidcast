import { NextResponse } from 'next/server';

import { approveSceneIntents, SceneIntentApprovalError } from '@/lib/explainer/scene-intent-approval';
import { ProjectUpdateValidationError } from '@/lib/projects/project-update';
import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { projectStore } from '@/lib/storage/project-store';
import { validateProject } from '@/lib/validation/project-validation';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { intentIds?: unknown };

  try {
    await requireProjectAccess(request, id);
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }

  const intentIds = Array.isArray(body.intentIds) ? body.intentIds.filter((value): value is string => typeof value === 'string') : undefined;

  let approved: string[] = [];
  let skipped: string[] = [];
  let project: Awaited<ReturnType<typeof projectStore.mutateProject>>;
  try {
    project = await projectStore.mutateProject(id, (current) => {
      const result = approveSceneIntents(current, intentIds);
      const finalValidation = validateProject(result.project);
      if (!finalValidation.valid) {
        throw new ProjectUpdateValidationError(finalValidation, 'Approved scene intents are invalid.');
      }

      approved = result.approved;
      skipped = result.skipped;
      return result.project;
    });
  } catch (error) {
    if (error instanceof ProjectUpdateValidationError) {
      return NextResponse.json({ message: error.message, errors: error.validation.errors, warnings: error.validation.warnings }, { status: 422 });
    }

    if (error instanceof SceneIntentApprovalError) {
      return NextResponse.json({ message: error.message, code: error.code }, { status: 404 });
    }

    return NextResponse.json({ message: 'Unexpected scene intent approval failure.', code: 'scene_intents.unexpected' }, { status: 500 });
  }

  if (!project) {
    return NextResponse.json({ message: 'Project not found.', code: 'project.notFound' }, { status: 404 });
  }

  return NextResponse.json({ project, approved, skipped }, { status: 200 });
}
