import path from 'node:path';

import { NextResponse } from 'next/server';

import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { projectStore } from '@/lib/storage/project-store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Reference images are limited to the formats the media store accepts
// (png/jpg/jpeg/webp). JSON uploads are size-capped so a base64 payload cannot
// exhaust memory before the store sees it.
const ALLOWED_REFERENCE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;

function parseTags(value: FormDataEntryValue | null): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return parseTags(value);
  }
  return [];
}

// Maps an accepted file extension to its canonical image MIME type. Used only
// when the caller did not supply an explicit MIME type (and no data URL prefix),
// so a `.jpg`/`.jpeg`/`.webp` filename never gets stored as `image/png` while
// carrying bytes of a different format.
function mimeForExtension(fileName: string): string {
  const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
  if (ext === 'webp') {
    return 'image/webp';
  }
  if (ext === 'jpg' || ext === 'jpeg') {
    return 'image/jpeg';
  }
  return 'image/png';
}

// Derives a filename whose extension the media store accepts. An explicit
// fileName is honoured when it already carries an allowed extension; otherwise
// the extension is inferred from the MIME type (defaulting to png). Any path
// components are stripped so a caller cannot influence where the file lands.
function deriveFileName(rawName: string, mimeType: string): string {
  const base = path.basename(rawName.trim()).slice(0, 200);
  const providedExt = path.extname(base).replace(/^\./, '').toLowerCase();
  if (providedExt && ALLOWED_REFERENCE_EXTENSIONS.has(providedExt)) {
    return base;
  }

  const mime = mimeType.toLowerCase();
  const ext = mime.includes('webp') ? 'webp' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
  const stem = base.replace(/\.+$/, '') || 'reference';
  return `${stem}.${ext}`;
}

async function handleJsonUpload(request: Request, projectId: string): Promise<NextResponse> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ message: 'Invalid JSON reference payload.', code: 'reference.invalid' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return NextResponse.json({ message: 'Reference name is required.', code: 'reference.nameRequired' }, { status: 400 });
  }

  const rawContent = typeof body.contentBase64 === 'string' ? body.contentBase64.trim() : '';
  if (!rawContent) {
    return NextResponse.json({ message: 'Expected base64 content field "contentBase64".', code: 'reference.contentRequired' }, { status: 400 });
  }

  // Accept either a bare base64 string or a full data URL and keep only the
  // payload. A data URL also lets the caller pin the MIME type inline.
  const dataUrlMatch = /^data:([^;,]+);base64,(.*)$/s.exec(rawContent);
  const base64 = dataUrlMatch ? dataUrlMatch[2] : rawContent;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return NextResponse.json({ message: 'contentBase64 is not valid base64.', code: 'reference.contentInvalid' }, { status: 400 });
  }

  if (bytes.length === 0) {
    return NextResponse.json({ message: 'contentBase64 decoded to an empty payload.', code: 'reference.contentInvalid' }, { status: 400 });
  }

  if (bytes.length > MAX_REFERENCE_BYTES) {
    return NextResponse.json(
      { message: `Reference exceeds the ${MAX_REFERENCE_BYTES} byte limit.`, code: 'reference.tooLarge' },
      { status: 413 }
    );
  }

  // Prefer an explicit MIME type (body field or data-URL prefix). When neither
  // is given, the type is derived from the final filename extension so the
  // stored content type always matches the stored extension.
  const explicitMimeType =
    (typeof body.mimeType === 'string' && body.mimeType.trim()) ||
    (dataUrlMatch ? dataUrlMatch[1] : '');

  const fileName = deriveFileName(
    typeof body.fileName === 'string' && body.fileName.trim() ? body.fileName : name,
    explicitMimeType || 'image/png'
  );
  const mimeType = explicitMimeType || mimeForExtension(fileName);
  const description = typeof body.description === 'string' ? body.description : '';
  const tags = normalizeTags(body.tags);

  const file = new File([new Uint8Array(bytes)], fileName, { type: mimeType });

  try {
    const reference = await projectStore.importReference(projectId, file, name, description, tags);
    return NextResponse.json({ reference }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : 'Could not import reference.' }, { status: 400 });
  }
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const { project } = await requireProjectAccess(request, id);
    return NextResponse.json({ references: project.references });
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    await requireProjectAccess(request, id);
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project access failure.', code: 'project.unexpected' }, { status: 500 });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return handleJsonUpload(request, id);
  }

  const formData = await request.formData();
  const file = formData.get('file');
  const name = formData.get('name');
  const description = formData.get('description');
  const tags = parseTags(formData.get('tags'));

  if (!(file instanceof File)) {
    return NextResponse.json({ message: 'Expected upload field "file".' }, { status: 400 });
  }

  if (typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ message: 'Reference name is required.' }, { status: 400 });
  }

  try {
    const reference = await projectStore.importReference(id, file, name, typeof description === 'string' ? description : '', tags);
    return NextResponse.json({ reference }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : 'Could not import reference.' }, { status: 400 });
  }
}
