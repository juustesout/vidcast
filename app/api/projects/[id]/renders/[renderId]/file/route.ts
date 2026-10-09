import fs from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { getProjectRoot } from '@/lib/storage/storage-paths';

interface RouteContext {
  params: Promise<{ id: string; renderId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const { id, renderId } = await context.params;

  let project;
  try {
    const access = await requireProjectAccess(request, id);
    project = access.project;
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }

  const render = project.scenes.flatMap((scene) => scene.renders ?? []).find((entry) => entry.renderId === renderId);
  if (!render) {
    return NextResponse.json({ message: 'Render not found.' }, { status: 404 });
  }

  if (path.isAbsolute(render.outputPath) || render.outputPath.includes('..')) {
    return NextResponse.json({ message: 'Invalid render path.' }, { status: 400 });
  }

  const filePath = path.resolve(getProjectRoot(id), render.outputPath);
  if (!filePath.startsWith(path.resolve(getProjectRoot(id)))) {
    return NextResponse.json({ message: 'Invalid render path.' }, { status: 400 });
  }

  try {
    const bytes = await fs.readFile(filePath);
    return new NextResponse(bytes, {
      headers: {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store'
      }
    });
  } catch {
    return NextResponse.json({ message: 'Render file missing on disk.' }, { status: 404 });
  }
}
