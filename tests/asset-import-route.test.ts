import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import { POST as createAssetRoute } from '@/app/api/projects/[id]/assets/route';
import { GET as getProjectRoute, PUT as updateProjectRoute } from '@/app/api/projects/[id]/route';
import { isHtmlStillSlotImageAsset } from '@/lib/projects/html-still-slot-images';
import { resolveHtmlStillImageAsset } from '@/lib/render/html-still/image-assets';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { projectStore } from '@/lib/storage/project-store';
import type { Project } from '@/lib/types/render';
import type { HtmlVisual } from '@/lib/types/scene';

let originalCwd: string;
let tempRoot: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-import-'));
  process.chdir(tempRoot);
  delete process.env.EXPLAINER_API_TOKEN;
});

afterEach(async () => {
  process.chdir(originalCwd);
  delete process.env.EXPLAINER_API_TOKEN;
  vi.restoreAllMocks();
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

function sessionHeader(subject: string): string {
  return `${SESSION_COOKIE_NAME}=${createUserSessionCookie(subject)}`;
}

async function pngBytes(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();
}

async function jpegBytes(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#00ff00' } }).jpeg().toBuffer();
}

async function webpBytes(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#0000ff' } }).webp().toBuffer();
}

function jsonAssetRequest(projectId: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/projects/${projectId}/assets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

function context(projectId: string) {
  return { params: Promise.resolve({ id: projectId }) };
}

describe('POST /api/projects/:id/assets JSON import', () => {
  it('imports PNG, JPEG, and WebP and stores server-owned paths', async () => {
    const project = await projectStore.createProject({ title: 'Import' }, 'user-a');
    const headers = { cookie: sessionHeader('user-a') };
    const cases = [
      { filename: 'hero.png', mimeType: 'image/png', bytes: await pngBytes() },
      { filename: 'hero.jpg', mimeType: 'image/jpeg', bytes: await jpegBytes() },
      { filename: 'hero.webp', mimeType: 'image/webp', bytes: await webpBytes() }
    ] as const;

    for (const entry of cases) {
      const response = await createAssetRoute(
        jsonAssetRequest(project.id, {
          filename: entry.filename,
          mimeType: entry.mimeType,
          dataBase64: entry.bytes.toString('base64')
        }, headers),
        context(project.id)
      );
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { asset: { id: string; localPath?: string; provenance: string; mimeType?: string } };
      expect(payload.asset.provenance).toBe('imported');
      expect(payload.asset.mimeType).toBe(entry.mimeType);
      expect(payload.asset.localPath).toMatch(/^assets\//);
      expect(payload.asset.localPath).not.toContain('..');
      expect(payload.asset.localPath).not.toContain(':');
    }

    const stored = await projectStore.getProject(project.id);
    expect(stored?.assets).toHaveLength(3);
    expect(stored?.assets.every((asset) => isHtmlStillSlotImageAsset(asset))).toBe(true);
    expect(stored?.assets.some((asset) => asset.metadata?.htmlStill === true)).toBe(false);
  });

  it('rejects invalid payloads without registering an asset', async () => {
    const project = await projectStore.createProject({ title: 'Reject' }, 'user-a');
    const headers = { cookie: sessionHeader('user-a') };
    const png = await pngBytes();
    const importAsset = vi.spyOn(projectStore, 'importAsset');

    const invalid = [
      { filename: 'hero.png', mimeType: 'image/png', dataBase64: '!!!!' },
      { filename: 'hero.png', mimeType: 'image/png', dataBase64: `data:image/png;base64,${png.toString('base64')}` },
      { filename: 'hero.png', mimeType: 'image/png', dataBase64: 'https://example.com/x.png' },
      { filename: '/tmp/hero.png', mimeType: 'image/png', dataBase64: png.toString('base64') },
      { filename: 'hero.jpg', mimeType: 'image/jpeg', dataBase64: png.toString('base64') },
      { filename: 'hero.png', mimeType: 'image/png', dataBase64: Buffer.from('not-an-image').toString('base64') }
    ];

    for (const body of invalid) {
      const response = await createAssetRoute(jsonAssetRequest(project.id, body, headers), context(project.id));
      expect(response.status).toBe(400);
    }

    expect(importAsset).not.toHaveBeenCalled();
    expect((await projectStore.getProject(project.id))?.assets).toEqual([]);
  });

  it('requires authentication and does not leak another user project', async () => {
    const project = await projectStore.createProject({ title: 'Owned' }, 'user-a');
    const png = (await pngBytes()).toString('base64');
    const body = { filename: 'hero.png', mimeType: 'image/png', dataBase64: png };

    const unauthenticated = await createAssetRoute(jsonAssetRequest(project.id, body), context(project.id));
    expect(unauthenticated.status).toBe(401);

    const otherUser = await createAssetRoute(
      jsonAssetRequest(project.id, body, { cookie: sessionHeader('user-b') }),
      context(project.id)
    );
    expect(otherUser.status).toBe(404);
    expect((await projectStore.getProject(project.id))?.assets).toEqual([]);
  });

  it('assigns an imported asset to an HTML slot and resolves it for render', async () => {
    const project = await projectStore.createProject({ title: 'Slot' }, 'user-a');
    const headers = { cookie: sessionHeader('user-a') };
    const png = await pngBytes();

    const imported = await createAssetRoute(
      jsonAssetRequest(project.id, {
        filename: 'hero.png',
        mimeType: 'image/png',
        dataBase64: png.toString('base64')
      }, headers),
      context(project.id)
    );
    expect(imported.status).toBe(201);
    const asset = ((await imported.json()) as { asset: { id: string } }).asset;

    const listed = await getProjectRoute(
      new Request(`http://localhost/api/projects/${project.id}`, { headers }),
      context(project.id)
    );
    const listedBody = (await listed.json()) as { project: Project };
    expect(listedBody.project.assets.some((entry) => entry.id === asset.id)).toBe(true);

    const sceneId = listedBody.project.scenes[0]?.id ?? 'scene-html';
    const updated = await updateProjectRoute(
      new Request(`http://localhost/api/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          scenes: [
            {
              id: sceneId,
              order: 1,
              duration: 5,
              type: 'html',
              narration: { text: '' },
              visual: {
                kind: 'html',
                template: 'headline',
                templateData: { title: 'Live', imageAssetId: asset.id }
              },
              render: { motion: { preset: 'none' }, transition: { type: 'none' } },
              overlay: { type: 'none' },
              referenceIds: [],
              notes: ''
            }
          ]
        })
      }),
      context(project.id)
    );
    expect(updated.status).toBe(200);

    const confirmed = await getProjectRoute(
      new Request(`http://localhost/api/projects/${project.id}`, { headers }),
      context(project.id)
    );
    const confirmedBody = (await confirmed.json()) as { project: Project };
    const visual = confirmedBody.project.scenes[0]?.visual as HtmlVisual;
    expect(visual.templateData?.imageAssetId).toBe(asset.id);

    const resolved = await resolveHtmlStillImageAsset(confirmedBody.project, asset.id);
    expect(resolved).toMatchObject({ assetId: asset.id, mimeType: 'image/png' });
    expect(resolved.dataUri.startsWith('data:image/png;base64,')).toBe(true);
  });
});
