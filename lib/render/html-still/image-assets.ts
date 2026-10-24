import { createHash } from 'node:crypto';
import { imageSize } from 'image-size';

import { isSafeAssetPath } from '@/lib/render/scene-composition';
import { mediaStore } from '@/lib/storage/media-store';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import type { HtmlVisual } from '@/lib/types/scene';
import { HtmlStillError } from './errors';
import { canonicalizeHtmlStillTemplateId, collectHtmlStillImageAssetIds, parseHtmlStillTemplateData } from './templates';

export const HTML_STILL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const HTML_STILL_IMAGE_MAX_DIMENSION = 4096;

export type HtmlStillImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ResolvedHtmlStillImage {
  assetId: string;
  mimeType: HtmlStillImageMime;
  dataUri: string;
  sha256: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function imageSlotPattern(assetId: string): RegExp {
  return new RegExp(
    `<([a-zA-Z][a-zA-Z0-9]*)\\b([^>]*\\sdata-html-still-image="${escapeRegExp(assetId)}"[^>]*)>([\\s\\S]*?)<\\/\\1>`,
    'g'
  );
}

function sniffImageMime(bytes: Buffer): HtmlStillImageMime | undefined {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
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

function isTrustedDataUri(image: ResolvedHtmlStillImage): boolean {
  const prefix = `data:${image.mimeType};base64,`;
  if (!image.dataUri.startsWith(prefix)) {
    return false;
  }
  const payload = image.dataUri.slice(prefix.length);
  return payload.length > 0 && /^[A-Za-z0-9+/]+=*$/.test(payload);
}

function toDataUri(mimeType: HtmlStillImageMime, bytes: Buffer): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function assertSafeLocalPath(assetId: string, localPath: string | undefined): string {
  if (!localPath) {
    throw new HtmlStillError('html.image.missing', `HTML still image asset ${assetId} has no local file.`, 400, { assetId });
  }
  if (!isSafeAssetPath(localPath) || localPath.includes(':') || !localPath.startsWith('assets/')) {
    throw new HtmlStillError('html.image.unsafe', `HTML still image asset ${assetId} path is unsafe.`, 400, { assetId });
  }
  return localPath;
}

function findAsset(project: Project, assetId: string): Asset {
  const asset = project.assets.find((entry) => entry.id === assetId);
  if (!asset) {
    throw new HtmlStillError('html.image.missing', `HTML still image asset ${assetId} does not exist.`, 400, { assetId });
  }
  return asset;
}

async function readAssetBytes(projectId: string, assetId: string, localPath: string): Promise<Buffer> {
  const exists = await mediaStore.exists(projectId, localPath);
  if (!exists) {
    throw new HtmlStillError('html.image.missing', `HTML still image asset ${assetId} file is missing.`, 400, { assetId });
  }
  try {
    return await mediaStore.readRelativeFile(projectId, localPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/invalid|unsafe|unsupported/i.test(message)) {
      throw new HtmlStillError('html.image.unsafe', `HTML still image asset ${assetId} path is unsafe.`, 400, { assetId });
    }
    throw new HtmlStillError('html.image.missing', `HTML still image asset ${assetId} file is missing.`, 400, { assetId });
  }
}

function hashImageBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeImage(assetId: string, bytes: Buffer): { mimeType: HtmlStillImageMime; dataUri: string; sha256: string } {
  if (bytes.length === 0 || bytes.length > HTML_STILL_IMAGE_MAX_BYTES) {
    throw new HtmlStillError('html.image.invalid', `HTML still image asset ${assetId} exceeds size limits.`, 400, { assetId, size: bytes.length });
  }
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) {
    throw new HtmlStillError('html.image.invalid', `HTML still image asset ${assetId} must be a PNG, JPEG, or WebP file.`, 400, { assetId });
  }
  let width: number | undefined;
  let height: number | undefined;
  try {
    const size = imageSize(bytes);
    width = size.width;
    height = size.height;
  } catch {
    throw new HtmlStillError('html.image.invalid', `HTML still image asset ${assetId} is not a readable raster image.`, 400, { assetId });
  }
  if (!width || !height || width < 1 || height < 1 || width > HTML_STILL_IMAGE_MAX_DIMENSION || height > HTML_STILL_IMAGE_MAX_DIMENSION) {
    throw new HtmlStillError('html.image.invalid', `HTML still image asset ${assetId} dimensions are invalid.`, 400, { assetId, width, height });
  }
  return { mimeType, dataUri: toDataUri(mimeType, bytes), sha256: hashImageBytes(bytes) };
}

export async function resolveHtmlStillImageAsset(project: Project, assetId: string): Promise<ResolvedHtmlStillImage> {
  const asset = findAsset(project, assetId);
  if (asset.type !== 'image') {
    throw new HtmlStillError('html.image.invalid', `HTML still image asset ${assetId} is not an image.`, 400, { assetId });
  }
  const localPath = assertSafeLocalPath(assetId, asset.localPath);
  const bytes = await readAssetBytes(project.id, assetId, localPath);
  const decoded = decodeImage(assetId, bytes);
  return {
    assetId,
    mimeType: decoded.mimeType,
    dataUri: decoded.dataUri,
    sha256: decoded.sha256
  };
}

export async function resolveHtmlStillImages(project: Project, visual: HtmlVisual): Promise<ResolvedHtmlStillImage[]> {
  if (!visual.template) {
    return [];
  }
  const canonical = canonicalizeHtmlStillTemplateId(visual.template);
  if (!canonical) {
    throw new HtmlStillError('html.template.unknown', `Unknown HTML still template: ${visual.template}.`);
  }
  const parsed = parseHtmlStillTemplateData(canonical, visual.templateData ?? {});
  const ids = [...new Set(collectHtmlStillImageAssetIds(parsed))];
  const images: ResolvedHtmlStillImage[] = [];
  for (const assetId of ids) {
    images.push(await resolveHtmlStillImageAsset(project, assetId));
  }
  return images;
}

export function injectTrustedHtmlStillImages(html: string, images: readonly ResolvedHtmlStillImage[]): string {
  if (images.length === 0) {
    return html;
  }
  let output = html;
  for (const image of images) {
    if (!isTrustedDataUri(image)) {
      throw new HtmlStillError('html.image.invalid', `Rejected untrusted image data URI for ${image.assetId}.`, 400, { assetId: image.assetId });
    }
    const next = output.replace(imageSlotPattern(image.assetId), `<$1$2><img alt="" src="${image.dataUri}"></$1>`);
    if (next === output) {
      throw new HtmlStillError('html.image.invalid', `HTML still image slot for ${image.assetId} was not found.`, 400, { assetId: image.assetId });
    }
    output = next;
  }
  return output;
}
