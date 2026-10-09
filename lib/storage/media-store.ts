import fs from 'node:fs/promises';
import path from 'node:path';

import { determineAssetType } from '@/lib/utils/assets';
import { createId } from '@/lib/utils/ids';
import { mediaMetadataReader } from '@/lib/media/metadata-reader';
import { getProjectAssetsRoot, getProjectReferencesRoot } from '@/lib/storage/storage-paths';
import type { Asset } from '@/lib/types/asset';
import type { ReferenceImage } from '@/lib/types/reference';

const ALLOWED_ASSET_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'm4a']);
const ALLOWED_REFERENCE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function extension(filename: string): string {
  const ext = path.extname(filename).replace(/^\./, '').toLowerCase();
  return sanitizeSegment(ext);
}

function safeStoredFilename(prefix: string, originalFilename: string): string {
  const baseName = path.basename(originalFilename);
  const cleanedBase = sanitizeSegment(baseName.replace(path.extname(baseName), ''));
  const ext = extension(baseName);
  return `${prefix}-${cleanedBase}${ext ? `.${ext}` : ''}`;
}

function assertAllowedExtension(fileName: string, allowed: Set<string>): void {
  const ext = extension(fileName);
  if (!ext || !allowed.has(ext)) {
    throw new Error(`Unsupported file format: .${ext || 'unknown'}`);
  }
}

function assertRelativePath(filePath: string): void {
  if (path.isAbsolute(filePath) || filePath.includes('..') || filePath.includes('\\')) {
    throw new Error('Invalid relative media path.');
  }
}

function rootForRelativePath(projectId: string, localPath: string): { root: string; relative: string } {
  assertRelativePath(localPath);
  const [head, ...rest] = localPath.split('/');
  const relative = rest.join('/');
  if (!relative) {
    throw new Error('Invalid media path.');
  }

  if (head === 'assets') {
    return { root: getProjectAssetsRoot(projectId), relative };
  }

  if (head === 'references') {
    return { root: getProjectReferencesRoot(projectId), relative };
  }

  throw new Error('Unsupported media root path.');
}

function resolveSafeFilePath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(path.resolve(root))) {
    throw new Error('Unsafe media path.');
  }
  return resolved;
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeUniqueFile(rootDir: string, relativeDir: 'assets' | 'references', suggestedFilename: string, bytes: Buffer): Promise<{ storedFilename: string; localPath: string }> {
  await ensureDir(rootDir);

  let candidate = suggestedFilename;
  let index = 1;

  for (;;) {
    const destination = path.join(rootDir, candidate);
    try {
      await fs.access(destination);
      const ext = path.extname(suggestedFilename);
      const base = suggestedFilename.slice(0, suggestedFilename.length - ext.length);
      candidate = `${base}-${index}${ext}`;
      index += 1;
    } catch {
      await fs.writeFile(destination, bytes);
      const localPath = `${relativeDir}/${candidate}`;
      assertRelativePath(localPath);
      return {
        storedFilename: candidate,
        localPath
      };
    }
  }
}

export interface ImportedAssetResult {
  asset: Asset;
}

export interface ImportedReferenceResult {
  reference: ReferenceImage;
}

export interface GeneratedImageInput {
  projectId: string;
  sceneOrder: number;
  attemptId: string;
  mimeType: string;
  data: Buffer;
  generation: {
    generationId: string;
    provider: string;
    model?: string;
    prompt: string;
    referenceIds: string[];
    providerRequestId?: string;
  };
}

export interface GeneratedVideoInput {
  projectId: string;
  sceneOrder: number;
  attemptId: string;
  mimeType: string;
  data: Buffer;
  generation: {
    generationId: string;
    provider: string;
    model?: string;
    prompt: string;
    referenceIds: string[];
    providerRequestId?: string;
    providerJobId?: string;
  };
}

export interface GeneratedAudioInput {
  projectId: string;
  sceneOrder: number;
  attemptId: string;
  mimeType: string;
  data: Buffer;
  generation: {
    generationId: string;
    provider: string;
    model?: string;
    prompt: string;
    voiceId?: string;
    providerRequestId?: string;
  };
}

export class MediaStore {
  async saveAsset(projectId: string, file: File): Promise<ImportedAssetResult> {
    assertAllowedExtension(file.name, ALLOWED_ASSET_EXTENSIONS);

    const assetId = createId('asset');
    const bytes = Buffer.from(await file.arrayBuffer());
    const storedFilename = safeStoredFilename(assetId, file.name);
    const writeResult = await writeUniqueFile(getProjectAssetsRoot(projectId), 'assets', storedFilename, bytes);
    const type = determineAssetType(file.name, file.type);
    const metadata = await mediaMetadataReader.read(bytes, file.name, file.type, type);
    const now = nowIso();

    const asset: Asset = {
      id: assetId,
      type,
      status: 'available',
      provenance: 'imported',
      filename: writeResult.storedFilename,
      originalFilename: file.name,
      localPath: writeResult.localPath,
      mimeType: metadata.mimeType,
      width: metadata.width,
      height: metadata.height,
      duration: metadata.duration,
      filesize: metadata.filesize,
      metadata: {
        mimeType: metadata.mimeType,
        filesize: metadata.filesize
      },
      createdAt: now,
      updatedAt: now
    };

    return { asset };
  }

  async saveReference(projectId: string, file: File, name: string, description: string, tags: string[]): Promise<ImportedReferenceResult> {
    assertAllowedExtension(file.name, ALLOWED_REFERENCE_EXTENSIONS);

    const referenceId = createId('reference');
    const bytes = Buffer.from(await file.arrayBuffer());
    const storedFilename = safeStoredFilename(referenceId, file.name);
    const writeResult = await writeUniqueFile(getProjectReferencesRoot(projectId), 'references', storedFilename, bytes);
    const metadata = await mediaMetadataReader.read(bytes, file.name, file.type, 'image');
    const now = nowIso();

    const reference: ReferenceImage = {
      id: referenceId,
      name: name.trim() || `Reference ${referenceId}`,
      description: description.trim(),
      filePath: writeResult.localPath,
      tags,
      metadata: {
        filename: writeResult.storedFilename,
        originalFilename: file.name,
        mimeType: metadata.mimeType,
        width: metadata.width,
        height: metadata.height,
        filesize: metadata.filesize
      },
      createdAt: now,
      updatedAt: now
    };

    return { reference };
  }

  async deleteAssetFile(projectId: string, asset: Asset): Promise<void> {
    if (!asset.localPath) {
      return;
    }

    assertRelativePath(asset.localPath);
    const { root, relative } = rootForRelativePath(projectId, asset.localPath);
    await fs.rm(resolveSafeFilePath(root, relative), { force: true });
  }

  async deleteReferenceFile(projectId: string, reference: ReferenceImage): Promise<void> {
    if (!reference.filePath) {
      return;
    }

    assertRelativePath(reference.filePath);
    const { root, relative } = rootForRelativePath(projectId, reference.filePath);
    await fs.rm(resolveSafeFilePath(root, relative), { force: true });
  }

  async readRelativeFile(projectId: string, localPath: string): Promise<Buffer> {
    const { root, relative } = rootForRelativePath(projectId, localPath);
    const fullPath = resolveSafeFilePath(root, relative);
    return fs.readFile(fullPath);
  }

  async saveGeneratedImage(input: GeneratedImageInput): Promise<Asset> {
    const now = nowIso();
    const assetId = createId('asset');
    const extension = input.mimeType.includes('webp') ? 'webp' : input.mimeType.includes('jpeg') || input.mimeType.includes('jpg') ? 'jpg' : 'png';
    const suggestedFilename = `scene-${String(input.sceneOrder).padStart(2, '0')}-generated-${input.attemptId}.${extension}`;
    const writeResult = await writeUniqueFile(getProjectAssetsRoot(input.projectId), 'assets', suggestedFilename, input.data);
    const metadata = await mediaMetadataReader.read(input.data, writeResult.storedFilename, input.mimeType, 'image');

    return {
      id: assetId,
      type: 'image',
      status: 'available',
      provenance: 'generated',
      filename: writeResult.storedFilename,
      originalFilename: writeResult.storedFilename,
      localPath: writeResult.localPath,
      mimeType: metadata.mimeType || input.mimeType,
      width: metadata.width,
      height: metadata.height,
      duration: undefined,
      filesize: metadata.filesize,
      metadata: {
        mimeType: metadata.mimeType || input.mimeType,
        filesize: metadata.filesize,
        generationAttemptId: input.attemptId,
        generationId: input.generation.generationId,
        providerRequestId: input.generation.providerRequestId
      },
      generation: {
        generationId: input.generation.generationId,
        provider: input.generation.provider,
        model: input.generation.model,
        prompt: input.generation.prompt,
        referenceIds: input.generation.referenceIds
      },
      createdAt: now,
      updatedAt: now
    };
  }

  async saveGeneratedVideo(input: GeneratedVideoInput): Promise<Asset> {
    const now = nowIso();
    const assetId = createId('asset');
    const extension = input.mimeType.includes('webm') ? 'webm' : input.mimeType.includes('quicktime') ? 'mov' : 'mp4';
    const suggestedFilename = `scene-${String(input.sceneOrder).padStart(2, '0')}-generated-${input.attemptId}.${extension}`;
    const writeResult = await writeUniqueFile(getProjectAssetsRoot(input.projectId), 'assets', suggestedFilename, input.data);
    const metadata = await mediaMetadataReader.read(input.data, writeResult.storedFilename, input.mimeType, 'video');

    return {
      id: assetId,
      type: 'video',
      status: 'available',
      provenance: 'generated',
      filename: writeResult.storedFilename,
      originalFilename: writeResult.storedFilename,
      localPath: writeResult.localPath,
      mimeType: metadata.mimeType || input.mimeType,
      width: metadata.width,
      height: metadata.height,
      duration: metadata.duration,
      filesize: metadata.filesize,
      metadata: {
        mimeType: metadata.mimeType || input.mimeType,
        filesize: metadata.filesize,
        generationAttemptId: input.attemptId,
        generationId: input.generation.generationId,
        providerRequestId: input.generation.providerRequestId,
        providerJobId: input.generation.providerJobId
      },
      generation: {
        generationId: input.generation.generationId,
        provider: input.generation.provider,
        model: input.generation.model,
        prompt: input.generation.prompt,
        referenceIds: input.generation.referenceIds
      },
      createdAt: now,
      updatedAt: now
    };
  }

  async saveGeneratedAudio(input: GeneratedAudioInput): Promise<Asset> {
    const now = nowIso();
    const assetId = createId('asset');
    const extension = input.mimeType.includes('wav') ? 'wav' : input.mimeType.includes('mp4') || input.mimeType.includes('m4a') ? 'm4a' : 'mp3';
    const suggestedFilename = `scene-${String(input.sceneOrder).padStart(2, '0')}-narration-${input.attemptId}.${extension}`;
    const writeResult = await writeUniqueFile(getProjectAssetsRoot(input.projectId), 'assets', suggestedFilename, input.data);
    const metadata = await mediaMetadataReader.read(input.data, writeResult.storedFilename, input.mimeType, 'audio');

    return {
      id: assetId,
      type: 'audio',
      status: 'available',
      provenance: 'generated',
      filename: writeResult.storedFilename,
      originalFilename: writeResult.storedFilename,
      localPath: writeResult.localPath,
      mimeType: metadata.mimeType || input.mimeType,
      duration: metadata.duration,
      filesize: metadata.filesize,
      metadata: {
        mimeType: metadata.mimeType || input.mimeType,
        filesize: metadata.filesize,
        generationAttemptId: input.attemptId,
        generationId: input.generation.generationId,
        providerRequestId: input.generation.providerRequestId,
        voiceId: input.generation.voiceId
      },
      generation: {
        generationId: input.generation.generationId,
        provider: input.generation.provider,
        model: input.generation.model,
        prompt: input.generation.prompt,
        referenceIds: []
      },
      createdAt: now,
      updatedAt: now
    };
  }

  async exists(projectId: string, localPath: string): Promise<boolean> {
    try {
      const { root, relative } = rootForRelativePath(projectId, localPath);
      await fs.access(resolveSafeFilePath(root, relative));
      return true;
    } catch {
      return false;
    }
  }
}

export const mediaStore = new MediaStore();
