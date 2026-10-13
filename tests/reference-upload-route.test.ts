import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as createReferenceRoute } from '@/app/api/projects/[id]/references/route';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { projectStore } from '@/lib/storage/project-store';

// 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function withSession(subject: string): string {
  return `${SESSION_COOKIE_NAME}=${createUserSessionCookie(subject)}`;
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/projects/project-1/references', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: withSession('user-a')
    },
    body: JSON.stringify(body)
  });
}

const context = { params: Promise.resolve({ id: 'project-1' }) };

describe('references route JSON upload', () => {
  let importReference: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-1', ownerId: 'user-a' } as never);
    importReference = vi.spyOn(projectStore, 'importReference').mockImplementation(async (_projectId, file, name, description, tags) => ({
      id: 'reference-1',
      name,
      description,
      filePath: `references/reference-1-${name}.png`,
      tags,
      metadata: { mimeType: file.type, width: 1, height: 1, filesize: file.size },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts raw base64 and reuses projectStore.importReference', async () => {
    const response = await createReferenceRoute(jsonRequest({ name: 'start', contentBase64: PNG_BASE64, tags: ['frame'] }), context);
    const body = (await response.json()) as { reference?: { id: string; filePath?: string } };

    expect(response.status).toBe(201);
    expect(body.reference?.id).toBe('reference-1');
    expect(importReference).toHaveBeenCalledTimes(1);

    const call = importReference.mock.calls[0];
    const file = call[1] as File;
    expect(call[0]).toBe('project-1');
    expect(call[2]).toBe('start');
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('start.png');
    expect(file.type).toBe('image/png');
    expect(call[4]).toEqual(['frame']);
  });

  it('accepts a full data URL and pins the mime type from it', async () => {
    const response = await createReferenceRoute(
      jsonRequest({ name: 'end', contentBase64: `data:image/webp;base64,${Buffer.from('binary-webp-bytes').toString('base64')}` }),
      context
    );

    expect(response.status).toBe(201);
    const file = importReference.mock.calls[0][1] as File;
    expect(file.type).toBe('image/webp');
    expect(file.name).toBe('end.webp');
  });

  it('derives the extension from mimeType when the filename has none', async () => {
    const response = await createReferenceRoute(
      jsonRequest({ name: 'shot', fileName: 'shot', mimeType: 'image/jpeg', contentBase64: PNG_BASE64 }),
      context
    );

    expect(response.status).toBe(201);
    const file = importReference.mock.calls[0][1] as File;
    expect(file.name).toBe('shot.jpg');
    expect(file.type).toBe('image/jpeg');
  });

  it('derives the MIME type from a .jpg filename when none is supplied', async () => {
    const response = await createReferenceRoute(
      jsonRequest({ name: 'frame', fileName: 'frame.jpg', contentBase64: PNG_BASE64 }),
      context
    );

    expect(response.status).toBe(201);
    const file = importReference.mock.calls[0][1] as File;
    expect(file.name).toBe('frame.jpg');
    expect(file.type).toBe('image/jpeg');
  });

  it('derives the MIME type from a .webp filename when none is supplied', async () => {
    const response = await createReferenceRoute(
      jsonRequest({ name: 'frame', fileName: 'frame.webp', contentBase64: PNG_BASE64 }),
      context
    );

    expect(response.status).toBe(201);
    const file = importReference.mock.calls[0][1] as File;
    expect(file.name).toBe('frame.webp');
    expect(file.type).toBe('image/webp');
  });

  it('rejects a missing name without calling the store', async () => {
    const response = await createReferenceRoute(jsonRequest({ contentBase64: PNG_BASE64 }), context);
    expect(response.status).toBe(400);
    expect(importReference).not.toHaveBeenCalled();
  });

  it('rejects empty or invalid base64 content', async () => {
    const response = await createReferenceRoute(jsonRequest({ name: 'empty', contentBase64: '!!!!' }), context);
    expect(response.status).toBe(400);
    expect(importReference).not.toHaveBeenCalled();
  });

  it('still supports the original multipart upload path', async () => {
    const form = new FormData();
    form.set('file', new File([Buffer.from(PNG_BASE64, 'base64')], 'start.png', { type: 'image/png' }));
    form.set('name', 'start');
    form.set('description', 'a frame');
    form.set('tags', 'a, b');

    const request = new Request('http://localhost/api/projects/project-1/references', {
      method: 'POST',
      headers: { cookie: withSession('user-a') },
      body: form
    });

    const response = await createReferenceRoute(request, context);
    expect(response.status).toBe(201);
    const call = importReference.mock.calls[0];
    expect(call[2]).toBe('start');
    expect(call[3]).toBe('a frame');
    expect(call[4]).toEqual(['a', 'b']);
  });
});
