import { NextResponse } from 'next/server';

import { materializeSceneIntents, SceneIntentMaterializationError } from '@/lib/explainer/scene-intent-materializer';
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
  const body = (await request.json().catch(() => ({}))) as { project?: unknown; intentIds?: string[] };

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

  try {
    const result = materializeSceneIntents(candidate, Array.isArray(body.intentIds) ? body.intentIds : undefined);
    const finalValidation = validateProject(result.project);
    if (!finalValidation.valid) {
      return NextResponse.json({ message: 'Materialized scenes are invalid.', errors: finalValidation.errors, warnings: finalValidation.warnings }, { status: 422 });
    }

    const project = await projectStore.updateProject(result.project);
    return NextResponse.json({ project, materialized: result.materialized, skipped: result.skipped }, { status: 200 });
  } catch (error) {
    if (error instanceof SceneIntentMaterializationError) {
      return NextResponse.json({ message: error.message, code: error.code }, { status: error.code === 'INTENT_NOT_FOUND' ? 404 : 422 });
    }

    return NextResponse.json({ message: 'Unexpected scene intent materialization failure.', code: 'scene_intents.unexpected' }, { status: 500 });
  }
}
