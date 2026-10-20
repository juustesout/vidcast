import fs from 'node:fs/promises';
import path from 'node:path';

import { imageSize } from 'image-size';

import { createId } from '@/lib/utils/ids';
import { projectStore } from '@/lib/storage/project-store';
import { getProjectStudioAssetsRoot } from '@/lib/storage/storage-paths';
import type { Asset } from '@/lib/types/asset';

export const DEFAULT_STUDIO_IMPORT_FILENAMES = [
  'studio_back.png',
  'studio_desk.png',
  'studio_intro.png',
  'studio_outtro.png'
] as const;

export const STUDIO_IMPORT_ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);
export const STUDIO_IMPORT_MAX_BYTES = 25 * 1024 * 1024;
export const STUDIO_IMPORT_MAX_FILES = 20;
export const STUDIO_IMPORT_SOURCE_ENV = 'STUDIO_IMPORT_SOURCE_DIR';

const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type StudioImportErrorCode =
  | 'studio.import.sourceNotConfigured'
  | 'studio.import.sourceMissing'
  | 'studio.import.projectNotFound'
  | 'studio.import.emptyList'
  | 'studio.import.invalidName'
  | 'studio.import.pathUnsafe'
  | 'studio.import.fileMissing'
  | 'studio.import.invalidImage'
  | 'studio.import.tooLarge'
  | 'studio.import.alreadyExists'
  | 'studio.import.copyFailed';

export class StudioImportError extends Error {
  readonly code: StudioImportErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: StudioImportErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'StudioImportError';
    this.code = code;
    this.details = details;
  }
}

export interface StudioImportOptions {
  sourceDir?: string;
}

export interface StudioImportResult {
  projectId: string;
  assets: Asset[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function extensionOf(fileName: string): string {
  return path.extname(fileName).replace(/^\./, '').toLowerCase();
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function getStudioImportSourceDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[STUDIO_IMPORT_SOURCE_ENV]?.trim();
  return raw ? path.resolve(raw) : null;
}

export function studioImportHttpStatus(code: StudioImportErrorCode): number {
  switch (code) {
    case 'studio.import.projectNotFound':
    case 'studio.import.sourceMissing':
    case 'studio.import.fileMissing':
      return 404;
    case 'studio.import.alreadyExists':
      return 409;
    case 'studio.import.tooLarge':
      return 413;
    case 'studio.import.copyFailed':
      return 500;
    default:
      return 400;
  }
}

export function assertStudioImportFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed || trimmed.length > 200) {
    throw new StudioImportError('studio.import.invalidName', 'Studio import file name is invalid.', { fileName });
  }
  if (trimmed !== path.basename(trimmed) || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new StudioImportError('studio.import.pathUnsafe', 'Studio import file name must be a bare file name.', { fileName: trimmed });
  }
  if (!SAFE_FILENAME.test(trimmed)) {
    throw new StudioImportError('studio.import.invalidName', 'Studio import file name contains unsupported characters.', { fileName: trimmed });
  }
  const ext = extensionOf(trimmed);
  if (!STUDIO_IMPORT_ALLOWED_EXTENSIONS.has(ext)) {
    throw new StudioImportError('studio.import.invalidName', `Unsupported studio import format: .${ext || 'unknown'}`, { fileName: trimmed });
  }
  return trimmed;
}

function sniffImage(bytes: Buffer, fileName: string): { mimeType: string; width: number; height: number } {
  const ext = extensionOf(fileName);
  let mimeType: string | undefined;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    mimeType = 'image/png';
  } else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mimeType = 'image/jpeg';
  } else if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    mimeType = 'image/webp';
  }

  if (!mimeType) {
    throw new StudioImportError('studio.import.invalidImage', 'File is not a valid PNG, JPEG, or WebP image.', { fileName });
  }

  if (ext === 'png' && mimeType !== 'image/png') {
    throw new StudioImportError('studio.import.invalidImage', 'File extension does not match image contents.', { fileName });
  }
  if ((ext === 'jpg' || ext === 'jpeg') && mimeType !== 'image/jpeg') {
    throw new StudioImportError('studio.import.invalidImage', 'File extension does not match image contents.', { fileName });
  }
  if (ext === 'webp' && mimeType !== 'image/webp') {
    throw new StudioImportError('studio.import.invalidImage', 'File extension does not match image contents.', { fileName });
  }

  let dimensions: { width?: number; height?: number };
  try {
    dimensions = imageSize(bytes);
  } catch {
    throw new StudioImportError('studio.import.invalidImage', 'Image bytes could not be decoded.', { fileName });
  }
  if (!dimensions.width || !dimensions.height) {
    throw new StudioImportError('studio.import.invalidImage', 'Image has no usable dimensions.', { fileName });
  }

  return { mimeType, width: dimensions.width, height: dimensions.height };
}

function studioRoleFor(fileName: string): string {
  switch (fileName) {
    case 'studio_back.png':
      return 'back';
    case 'studio_desk.png':
      return 'desk';
    case 'studio_intro.png':
      return 'intro';
    case 'studio_outtro.png':
      return 'outtro';
    default:
      return 'stock';
  }
}

async function resolveSourceDir(options?: StudioImportOptions): Promise<string> {
  const configured = options?.sourceDir?.trim() ? path.resolve(options.sourceDir.trim()) : getStudioImportSourceDir();
  if (!configured) {
    throw new StudioImportError(
      'studio.import.sourceNotConfigured',
      `${STUDIO_IMPORT_SOURCE_ENV} is not set.`,
      { env: STUDIO_IMPORT_SOURCE_ENV }
    );
  }

  try {
    const stat = await fs.stat(configured);
    if (!stat.isDirectory()) {
      throw new StudioImportError('studio.import.sourceMissing', 'Studio import source is not a directory.', { sourceDir: configured });
    }
  } catch (error) {
    if (error instanceof StudioImportError) {
      throw error;
    }
    throw new StudioImportError('studio.import.sourceMissing', 'Studio import source directory was not found.', { sourceDir: configured });
  }

  return configured;
}

async function readValidatedImage(sourceDir: string, fileName: string): Promise<{ bytes: Buffer; mimeType: string; width: number; height: number }> {
  const sourcePath = path.resolve(sourceDir, fileName);
  if (!isPathInside(sourceDir, sourcePath)) {
    throw new StudioImportError('studio.import.pathUnsafe', 'Studio import path escapes the source directory.', { fileName });
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(sourcePath);
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
    if (code === 'ENOENT') {
      throw new StudioImportError('studio.import.fileMissing', `Studio source file was not found: ${fileName}`, { fileName });
    }
    throw new StudioImportError('studio.import.copyFailed', `Could not read studio source file: ${fileName}`, { fileName });
  }

  if (bytes.length === 0) {
    throw new StudioImportError('studio.import.invalidImage', 'Studio source file is empty.', { fileName });
  }
  if (bytes.length > STUDIO_IMPORT_MAX_BYTES) {
    throw new StudioImportError(
      'studio.import.tooLarge',
      `Studio source file exceeds the ${STUDIO_IMPORT_MAX_BYTES} byte limit.`,
      { fileName, filesize: bytes.length }
    );
  }

  const sniffed = sniffImage(bytes, fileName);
  return { bytes, ...sniffed };
}

export async function importStudioAssets(
  projectId: string,
  fileNames: string[],
  options?: StudioImportOptions
): Promise<StudioImportResult> {
  const project = await projectStore.getProject(projectId);
  if (!project) {
    throw new StudioImportError('studio.import.projectNotFound', `Project ${projectId} not found.`, { projectId });
  }

  if (!Array.isArray(fileNames) || fileNames.length === 0) {
    throw new StudioImportError('studio.import.emptyList', 'At least one studio file name is required.');
  }
  if (fileNames.length > STUDIO_IMPORT_MAX_FILES) {
    throw new StudioImportError('studio.import.invalidName', `At most ${STUDIO_IMPORT_MAX_FILES} studio files can be imported at once.`);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawName of fileNames) {
    const fileName = assertStudioImportFileName(String(rawName ?? ''));
    if (seen.has(fileName)) {
      throw new StudioImportError('studio.import.invalidName', 'Duplicate studio file name in import list.', { fileName });
    }
    seen.add(fileName);
    normalized.push(fileName);
  }

  const sourceDir = await resolveSourceDir(options);
  const destinationRoot = getProjectStudioAssetsRoot(projectId);
  await fs.mkdir(destinationRoot, { recursive: true });

  const existingPaths = new Set(
    project.assets
      .map((asset) => asset.localPath)
      .filter((localPath): localPath is string => typeof localPath === 'string')
  );

  const prepared: Array<{
    fileName: string;
    destinationPath: string;
    localPath: string;
    bytes: Buffer;
    mimeType: string;
    width: number;
    height: number;
  }> = [];

  for (const fileName of normalized) {
    const localPath = `assets/studio/${fileName}`;
    const destinationPath = path.resolve(destinationRoot, fileName);
    if (!isPathInside(destinationRoot, destinationPath)) {
      throw new StudioImportError('studio.import.pathUnsafe', 'Studio import destination escapes the project studio directory.', { fileName });
    }
    if (existingPaths.has(localPath)) {
      throw new StudioImportError('studio.import.alreadyExists', `Studio asset already exists: ${fileName}`, { fileName, localPath });
    }
    try {
      await fs.access(destinationPath);
      throw new StudioImportError('studio.import.alreadyExists', `Studio asset already exists: ${fileName}`, { fileName, localPath });
    } catch (error) {
      if (error instanceof StudioImportError) {
        throw error;
      }
    }

    const image = await readValidatedImage(sourceDir, fileName);
    prepared.push({ fileName, destinationPath, localPath, ...image });
  }

  const written: string[] = [];
  const assets: Asset[] = [];
  const createdAt = nowIso();

  try {
    for (const entry of prepared) {
      try {
        await fs.writeFile(entry.destinationPath, entry.bytes, { flag: 'wx' });
      } catch (error) {
        const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
        if (code === 'EEXIST') {
          throw new StudioImportError('studio.import.alreadyExists', `Studio asset already exists: ${entry.fileName}`, {
            fileName: entry.fileName,
            localPath: entry.localPath
          });
        }
        throw new StudioImportError('studio.import.copyFailed', `Could not copy studio file: ${entry.fileName}`, {
          fileName: entry.fileName
        });
      }
      written.push(entry.destinationPath);

      assets.push({
        id: createId('asset'),
        type: 'image',
        status: 'available',
        provenance: 'imported',
        filename: entry.fileName,
        originalFilename: entry.fileName,
        localPath: entry.localPath,
        mimeType: entry.mimeType,
        width: entry.width,
        height: entry.height,
        filesize: entry.bytes.byteLength,
        source: 'studio-import',
        metadata: {
          mimeType: entry.mimeType,
          filesize: entry.bytes.byteLength,
          studioRole: studioRoleFor(entry.fileName)
        },
        createdAt,
        updatedAt: createdAt
      });
    }

    const updated = await projectStore.mutateProject(projectId, (current) => {
      for (const asset of assets) {
        const clash = current.assets.some((existing) => existing.localPath === asset.localPath);
        if (clash) {
          throw new StudioImportError('studio.import.alreadyExists', `Studio asset already exists: ${asset.filename}`, {
            fileName: asset.filename,
            localPath: asset.localPath
          });
        }
      }
      return { ...current, assets: [...current.assets, ...assets] };
    });

    if (!updated) {
      throw new StudioImportError('studio.import.projectNotFound', `Project ${projectId} not found.`, { projectId });
    }
  } catch (error) {
    await Promise.all(written.map((filePath) => fs.rm(filePath, { force: true }).catch(() => undefined)));
    if (error instanceof StudioImportError) {
      throw error;
    }
    throw new StudioImportError('studio.import.copyFailed', 'Studio import failed before assets were registered.', {
      projectId
    });
  }

  return { projectId, assets };
}
