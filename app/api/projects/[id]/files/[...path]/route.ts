import fs from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { getProjectRoot } from '@/lib/storage/storage-paths';

interface RouteContext {
  params: Promise<{ id: string; path: string[] }>;
}

function isUnsafeSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') {
    return true;
  }
  if (segment.includes('\0') || segment.includes('/') || segment.includes('\\')) {
    return true;
  }
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return true;
  }
  if (decoded !== segment && (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0') || decoded === '')) {
    return true;
  }
  return decoded === '.' || decoded === '..';
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveSafePath(projectId: string, segments: string[]): string | null {
  const projectRoot = getProjectRoot(projectId);
  const allowedHead = new Set(['assets', 'references', 'renders', 'previews']);
  if (segments.length === 0 || !allowedHead.has(segments[0]) || segments.some(isUnsafeSegment)) {
    return null;
  }
  const requestedPath = path.resolve(projectRoot, ...segments);
  if (!isPathInside(projectRoot, requestedPath)) {
    return null;
  }

  return requestedPath;
}

export async function GET(request: Request, context: RouteContext) {
  const { id, path: segments } = await context.params;

  try {
    await requireProjectAccess(request, id);
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }

  const filePath = resolveSafePath(id, segments);

  if (!filePath) {
    return NextResponse.json({ message: 'Invalid file path.' }, { status: 400 });
  }

  try {
    const bytes = await fs.readFile(filePath);
    const contentType = filePath.endsWith('.svg')
      ? 'image/svg+xml'
      : filePath.endsWith('.png')
        ? 'image/png'
        : filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')
          ? 'image/jpeg'
          : filePath.endsWith('.webp')
            ? 'image/webp'
            : filePath.endsWith('.mp4')
              ? 'video/mp4'
              : filePath.endsWith('.mp3')
                ? 'audio/mpeg'
                : 'application/octet-stream';

    return new NextResponse(bytes, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
      }
    });
  } catch {
    return NextResponse.json({ message: 'File not found.' }, { status: 404 });
  }
}
