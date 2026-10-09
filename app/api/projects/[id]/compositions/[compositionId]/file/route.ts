import fs from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { getProjectRoot } from '@/lib/storage/storage-paths';

interface RouteContext {
  params: Promise<{ id: string; compositionId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const { id, compositionId } = await context.params;

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

  const composition = (project.compositions ?? []).find((entry) => entry.compositionId === compositionId);
  if (!composition) {
    return NextResponse.json({ message: 'Composition not found.' }, { status: 404 });
  }

  if (path.isAbsolute(composition.outputPath) || composition.outputPath.includes('..')) {
    return NextResponse.json({ message: 'Invalid composition path.' }, { status: 400 });
  }

  const filePath = path.resolve(getProjectRoot(id), composition.outputPath);
  if (!filePath.startsWith(path.resolve(getProjectRoot(id)))) {
    return NextResponse.json({ message: 'Invalid composition path.' }, { status: 400 });
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
    return NextResponse.json({ message: 'Composition file missing on disk.' }, { status: 404 });
  }
}
