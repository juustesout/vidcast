import { NextResponse } from 'next/server';

import { planSceneIntentsFromBeats } from '@/lib/explainer/scene-intent-planner';
import { applyProjectUpdate } from '@/lib/projects/project-update';
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

  const { project: candidate, validation } = applyProjectUpdate(existing, body.project ?? existing);
  if (!validation.valid) {
    return NextResponse.json({ message: 'Project validation failed.', errors: validation.errors, warnings: validation.warnings }, { status: 422 });
  }

  const result = planSceneIntentsFromBeats(candidate);
  const finalValidation = validateProject(result.project);
  if (!finalValidation.valid) {
    return NextResponse.json({ message: 'Planned scene intents are invalid.', errors: finalValidation.errors, warnings: finalValidation.warnings }, { status: 422 });
  }

  const project = await projectStore.updateProject(result.project);
  return NextResponse.json({ project, createdIntentIds: result.createdIntentIds }, { status: 200 });
}
