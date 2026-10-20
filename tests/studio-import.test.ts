import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { projectStore } from '@/lib/storage/project-store';
import {
  assertStudioImportFileName,
  DEFAULT_STUDIO_IMPORT_FILENAMES,
  getStudioImportSourceDir,
  importStudioAssets,
  STUDIO_IMPORT_SOURCE_ENV,
  StudioImportError
} from '@/lib/storage/studio-import';
import { getProjectStudioAssetsRoot } from '@/lib/storage/storage-paths';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let originalCwd: string;
let originalSource: string | undefined;
let tempRoot: string;
let sourceDir: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  originalSource = process.env[STUDIO_IMPORT_SOURCE_ENV];
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-import-'));
  sourceDir = path.join(tempRoot, 'tmp_images');
  await fs.mkdir(sourceDir, { recursive: true });
  process.chdir(tempRoot);
  process.env[STUDIO_IMPORT_SOURCE_ENV] = sourceDir;
});

beforeEach(async () => {
  await fs.mkdir(sourceDir, { recursive: true });
  const entries = await fs.readdir(sourceDir);
  await Promise.all(entries.map((entry) => fs.rm(path.join(sourceDir, entry), { force: true })));
});

afterAll(async () => {
  process.chdir(originalCwd);
  if (originalSource === undefined) {
    delete process.env[STUDIO_IMPORT_SOURCE_ENV];
  } else {
    process.env[STUDIO_IMPORT_SOURCE_ENV] = originalSource;
  }
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

async function writePng(fileName: string): Promise<void> {
  await fs.writeFile(path.join(sourceDir, fileName), PNG_BYTES);
}

describe('studio import file names', () => {
  it('accepts the four default studio stills', () => {
    expect(DEFAULT_STUDIO_IMPORT_FILENAMES).toEqual([
      'studio_back.png',
      'studio_desk.png',
      'studio_intro.png',
      'studio_outtro.png'
    ]);
    for (const fileName of DEFAULT_STUDIO_IMPORT_FILENAMES) {
      expect(assertStudioImportFileName(fileName)).toBe(fileName);
    }
  });

  it('rejects path traversal and absolute paths', () => {
    for (const fileName of ['../secret.png', '..\\secret.png', '/tmp/secret.png', 'sub/studio_back.png', 'studio_back.txt']) {
      expect(() => assertStudioImportFileName(fileName)).toThrow(StudioImportError);
    }
  });

  it('resolves the source directory from env', () => {
    expect(getStudioImportSourceDir()).toBe(path.resolve(sourceDir));
  });
});

describe('project studio directories', () => {
  it('creates assets/studio when a project is created', async () => {
    const project = await projectStore.createProject({ title: 'Studio dirs' });
    const studioRoot = getProjectStudioAssetsRoot(project.id);
    const stat = await fs.stat(studioRoot);
    expect(stat.isDirectory()).toBe(true);
    expect(path.relative(path.join(tempRoot, 'projects', project.id, 'assets'), studioRoot)).toBe('studio');
  });
});

describe('importStudioAssets', () => {
  it('copies the four studio stills into project-relative assets/studio paths', async () => {
    for (const fileName of DEFAULT_STUDIO_IMPORT_FILENAMES) {
      await writePng(fileName);
    }
    const project = await projectStore.createProject({ title: 'Studio import ok' });

    const result = await importStudioAssets(project.id, [...DEFAULT_STUDIO_IMPORT_FILENAMES]);
    expect(result.assets).toHaveLength(4);

    const stored = await projectStore.getProject(project.id);
    expect(stored?.assets.map((asset) => asset.localPath)).toEqual([
      'assets/studio/studio_back.png',
      'assets/studio/studio_desk.png',
      'assets/studio/studio_intro.png',
      'assets/studio/studio_outtro.png'
    ]);

    for (const asset of result.assets) {
      expect(asset.localPath?.startsWith('assets/studio/')).toBe(true);
      expect(asset.localPath?.includes('tmp_images')).toBe(false);
      expect(path.isAbsolute(asset.localPath ?? '')).toBe(false);
      expect(asset.provenance).toBe('imported');
      expect(asset.mimeType).toBe('image/png');
      expect(asset.width).toBe(1);
      expect(asset.height).toBe(1);
      const bytes = await fs.readFile(path.join(tempRoot, 'projects', project.id, asset.localPath ?? ''));
      expect(bytes.equals(PNG_BYTES)).toBe(true);
    }
  });

  it('imports an extra stock image alongside studio stills', async () => {
    await writePng('studio_back.png');
    await writePng('stock_extra.png');
    const project = await projectStore.createProject({ title: 'Extra stock' });

    const result = await importStudioAssets(project.id, ['studio_back.png', 'stock_extra.png']);
    expect(result.assets.map((asset) => asset.filename)).toEqual(['studio_back.png', 'stock_extra.png']);
    expect(result.assets[1]?.metadata.studioRole).toBe('stock');
    expect(result.assets[1]?.localPath).toBe('assets/studio/stock_extra.png');
  });

  it('fails closed when a source file is missing and leaves no assets', async () => {
    await writePng('studio_back.png');
    const project = await projectStore.createProject({ title: 'Missing file' });

    await expect(importStudioAssets(project.id, ['studio_back.png', 'studio_desk.png'])).rejects.toMatchObject({
      code: 'studio.import.fileMissing'
    });

    const stored = await projectStore.getProject(project.id);
    expect(stored?.assets).toEqual([]);
    const leftover = await fs.readdir(getProjectStudioAssetsRoot(project.id));
    expect(leftover).toEqual([]);
  });

  it('rejects a non-image file that uses a png extension', async () => {
    await fs.writeFile(path.join(sourceDir, 'studio_intro.png'), 'not-an-image');
    const project = await projectStore.createProject({ title: 'Invalid image' });

    await expect(importStudioAssets(project.id, ['studio_intro.png'])).rejects.toMatchObject({
      code: 'studio.import.invalidImage'
    });
    expect((await projectStore.getProject(project.id))?.assets).toEqual([]);
  });

  it('does not overwrite an existing studio asset', async () => {
    await writePng('studio_outtro.png');
    const project = await projectStore.createProject({ title: 'No overwrite' });
    await importStudioAssets(project.id, ['studio_outtro.png']);

    await expect(importStudioAssets(project.id, ['studio_outtro.png'])).rejects.toMatchObject({
      code: 'studio.import.alreadyExists'
    });
    expect((await projectStore.getProject(project.id))?.assets).toHaveLength(1);
  });

  it('rejects a missing source directory', async () => {
    const project = await projectStore.createProject({ title: 'Missing source' });
    await expect(importStudioAssets(project.id, ['studio_back.png'], { sourceDir: path.join(tempRoot, 'no-such-dir') })).rejects.toMatchObject({
      code: 'studio.import.sourceMissing'
    });
  });

  it('fails closed when the source directory is not configured', async () => {
    const previous = process.env[STUDIO_IMPORT_SOURCE_ENV];
    delete process.env[STUDIO_IMPORT_SOURCE_ENV];
    const project = await projectStore.createProject({ title: 'Unconfigured' });
    try {
      await expect(importStudioAssets(project.id, ['studio_back.png'])).rejects.toMatchObject({
        code: 'studio.import.sourceNotConfigured'
      });
    } finally {
      process.env[STUDIO_IMPORT_SOURCE_ENV] = previous;
    }
  });

  it('rejects a missing project', async () => {
    await expect(importStudioAssets('project_missing', ['studio_back.png'])).rejects.toMatchObject({
      code: 'studio.import.projectNotFound'
    });
  });

  it('rejects path traversal in the import list', async () => {
    const project = await projectStore.createProject({ title: 'Traversal' });
    await expect(importStudioAssets(project.id, ['../secret.png'])).rejects.toMatchObject({
      code: 'studio.import.pathUnsafe'
    });
    expect((await projectStore.getProject(project.id))?.assets).toEqual([]);
  });
});
