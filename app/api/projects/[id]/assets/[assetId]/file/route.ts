import fs from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { getProjectRoot } from '@/lib/storage/storage-paths';

interface RouteContext {
  params: Promise<{ id: string; assetId: string }>;
}

function contentTypeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  return 'application/octet-stream';
}

export async function GET(request: Request, context: RouteContext) {
  const { id, assetId } = await context.params;

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

  const asset = project.assets.find((entry) => entry.id === assetId);
  if (!asset || !asset.localPath) {
    return NextResponse.json({ message: 'Asset file not found.' }, { status: 404 });
  }

  if (asset.localPath.includes('..') || path.isAbsolute(asset.localPath)) {
    return NextResponse.json({ message: 'Invalid asset path.' }, { status: 400 });
  }

  const filePath = path.resolve(getProjectRoot(id), asset.localPath);
  if (!filePath.startsWith(path.resolve(getProjectRoot(id)))) {
    return NextResponse.json({ message: 'Invalid asset path.' }, { status: 400 });
  }

  try {
    const bytes = await fs.readFile(filePath);
    return new NextResponse(bytes, {
      headers: {
        'Content-Type': asset.mimeType || contentTypeFromPath(filePath),
        'Cache-Control': 'no-store'
      }
    });
  } catch {
    return NextResponse.json({ message: 'Asset file missing on disk.' }, { status: 404 });
  }
}
