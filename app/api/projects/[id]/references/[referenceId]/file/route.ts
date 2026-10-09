import fs from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { getProjectRoot } from '@/lib/storage/storage-paths';

interface RouteContext {
  params: Promise<{ id: string; referenceId: string }>;
}

function contentTypeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

export async function GET(request: Request, context: RouteContext) {
  const { id, referenceId } = await context.params;

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

  const reference = project.references.find((entry) => entry.id === referenceId);
  if (!reference || !reference.filePath) {
    return NextResponse.json({ message: 'Reference file not found.' }, { status: 404 });
  }

  if (reference.filePath.includes('..') || path.isAbsolute(reference.filePath)) {
    return NextResponse.json({ message: 'Invalid reference path.' }, { status: 400 });
  }

  const filePath = path.resolve(getProjectRoot(id), reference.filePath);
  if (!filePath.startsWith(path.resolve(getProjectRoot(id)))) {
    return NextResponse.json({ message: 'Invalid reference path.' }, { status: 400 });
  }

  try {
    const bytes = await fs.readFile(filePath);
    const mime = typeof reference.metadata?.mimeType === 'string' ? reference.metadata.mimeType : undefined;
    return new NextResponse(bytes, {
      headers: {
        'Content-Type': mime || contentTypeFromPath(filePath),
        'Cache-Control': 'no-store'
      }
    });
  } catch {
    return NextResponse.json({ message: 'Reference file missing on disk.' }, { status: 404 });
  }
}
