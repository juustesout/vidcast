import path from 'node:path';

import { imageSize } from 'image-size';

export const IMPORTED_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const IMPORTED_IMAGE_MAX_DIMENSION = 8192;
export const IMPORTED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type ImportedImageMime = (typeof IMPORTED_IMAGE_MIMES)[number];

export type ImportedImageErrorCode =
  | 'asset.contentInvalid'
  | 'asset.tooLarge'
  | 'asset.unsupportedType'
  | 'asset.filenameInvalid'
  | 'asset.mimeMismatch'
  | 'asset.invalidImage';

export class ImportedImageError extends Error {
  readonly code: ImportedImageErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ImportedImageErrorCode, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ImportedImageError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ValidatedImportedImage {
  filename: string;
  mimeType: ImportedImageMime;
  bytes: Buffer;
  width: number;
  height: number;
}

const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isImportedImageMime(value: string): value is ImportedImageMime {
  return (IMPORTED_IMAGE_MIMES as readonly string[]).includes(value);
}

function extensionOf(filename: string): string {
  return path.extname(filename).replace(/^\./, '').toLowerCase();
}

function mimeForExtension(extension: string): ImportedImageMime | undefined {
  if (extension === 'png') {
    return 'image/png';
  }
  if (extension === 'jpg' || extension === 'jpeg') {
    return 'image/jpeg';
  }
  if (extension === 'webp') {
    return 'image/webp';
  }
  return undefined;
}

function sniffImageMime(bytes: Buffer): ImportedImageMime | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

function looksLikeUrlOrPath(value: string): boolean {
  return (
    value.startsWith('data:')
    || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
    || value.includes('\\')
    || value.startsWith('/')
    || value.includes('://')
  );
}

export function decodeStrictBase64(raw: string): Buffer {
  const value = raw.trim();
  if (!value || value.startsWith('data:') || value.includes('://') || !STRICT_BASE64.test(value) || value.length % 4 !== 0) {
    throw new ImportedImageError('asset.contentInvalid', 'dataBase64 is not valid base64 image content.', 400);
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, 'base64');
  } catch {
    throw new ImportedImageError('asset.contentInvalid', 'dataBase64 is not valid base64 image content.', 400);
  }

  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    throw new ImportedImageError('asset.contentInvalid', 'dataBase64 is not valid base64 image content.', 400);
  }

  return bytes;
}

function normalizeFilename(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ImportedImageError('asset.filenameInvalid', 'filename is required.', 400);
  }
  const value = raw.trim();
  if (looksLikeUrlOrPath(value) || value.includes('..') || value.includes('/') || path.basename(value) !== value) {
    throw new ImportedImageError('asset.filenameInvalid', 'filename must be a bare file name, not a URL or path.', 400);
  }
  if (!SAFE_FILENAME.test(value) || value.length > 200) {
    throw new ImportedImageError('asset.filenameInvalid', 'filename contains unsupported characters.', 400);
  }
  const extension = extensionOf(value);
  if (!mimeForExtension(extension)) {
    throw new ImportedImageError('asset.unsupportedType', 'filename must end with .png, .jpg, .jpeg, or .webp.', 400);
  }
  return value;
}

function normalizeMimeType(raw: unknown): ImportedImageMime {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ImportedImageError('asset.unsupportedType', 'mimeType is required.', 400);
  }
  const mime = raw.trim().toLowerCase();
  if (mime === 'image/jpg') {
    throw new ImportedImageError('asset.unsupportedType', 'mimeType must be image/png, image/jpeg, or image/webp.', 400);
  }
  if (!isImportedImageMime(mime)) {
    throw new ImportedImageError('asset.unsupportedType', 'mimeType must be image/png, image/jpeg, or image/webp.', 400);
  }
  return mime;
}

export function validateImportedImage(input: {
  filename: unknown;
  mimeType: unknown;
  dataBase64: unknown;
}): ValidatedImportedImage {
  const filename = normalizeFilename(input.filename);
  const mimeType = normalizeMimeType(input.mimeType);
  if (typeof input.dataBase64 !== 'string' || !input.dataBase64.trim()) {
    throw new ImportedImageError('asset.contentInvalid', 'Expected base64 content field "dataBase64".', 400);
  }

  const bytes = decodeStrictBase64(input.dataBase64);
  if (bytes.length > IMPORTED_IMAGE_MAX_BYTES) {
    throw new ImportedImageError(
      'asset.tooLarge',
      `Image exceeds the ${IMPORTED_IMAGE_MAX_BYTES} byte limit.`,
      413,
      { filesize: bytes.length }
    );
  }

  const extensionMime = mimeForExtension(extensionOf(filename));
  const sniffedMime = sniffImageMime(bytes);
  if (!extensionMime || extensionMime !== mimeType) {
    throw new ImportedImageError('asset.mimeMismatch', 'filename extension does not match mimeType.', 400, {
      filename,
      mimeType
    });
  }
  if (!sniffedMime) {
    throw new ImportedImageError('asset.invalidImage', 'dataBase64 must be a PNG, JPEG, or WebP image.', 400);
  }
  if (sniffedMime !== mimeType) {
    throw new ImportedImageError('asset.mimeMismatch', 'Declared MIME type does not match image bytes.', 400, {
      mimeType,
      detectedMimeType: sniffedMime
    });
  }

  let width: number | undefined;
  let height: number | undefined;
  try {
    const size = imageSize(bytes);
    width = size.width;
    height = size.height;
  } catch {
    throw new ImportedImageError('asset.invalidImage', 'Image bytes could not be decoded.', 400);
  }
  if (!width || !height || width < 1 || height < 1 || width > IMPORTED_IMAGE_MAX_DIMENSION || height > IMPORTED_IMAGE_MAX_DIMENSION) {
    throw new ImportedImageError('asset.invalidImage', 'Image dimensions are invalid.', 400, { width, height });
  }

  return { filename, mimeType, bytes, width, height };
}
