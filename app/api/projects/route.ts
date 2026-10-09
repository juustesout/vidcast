import { NextResponse } from 'next/server';

import { AccessControlError, requireIdentity } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { projectStore } from '@/lib/storage/project-store';

export async function GET(request: Request) {
  try {
    const identity = requireIdentity(request);
    if (identity.kind === 'service') {
      const projects = await projectStore.listProjects();
      return NextResponse.json({ projects });
    }

    const projects = await projectStore.listProjects(identity.subject);
    return NextResponse.json({ projects });
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authentication failure.', code: 'auth.unexpected' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const identity = requireIdentity(request);
    const body = (await request.json().catch(() => ({}))) as { title?: string; description?: string; durationTarget?: number; aspectRatio?: '16:9' | '1:1' | '9:16'; fps?: number };
    const ownerId = identity.kind === 'service' ? undefined : identity.subject;
    const project = await projectStore.createProject(body, ownerId);
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project creation failure.', code: 'project.unexpected' }, { status: 500 });
  }
}
