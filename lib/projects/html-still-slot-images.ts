import { canonicalizeHtmlStillTemplateId, collectHtmlStillImageAssetIds, parseHtmlStillTemplateData } from '@/lib/render/html-still/templates';
import type { Asset } from '@/lib/types/asset';
import type { HtmlVisual } from '@/lib/types/scene';

export const HTML_STILL_SLOT_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;

const SLOT_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

function normalizeSlotImageMime(mimeType: string | undefined): (typeof HTML_STILL_SLOT_IMAGE_MIMES)[number] | undefined {
  const mime = mimeType?.trim().toLowerCase();
  if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp') {
    return mime;
  }
  if (mime === 'image/jpg') {
    return 'image/jpeg';
  }
  return undefined;
}

function mimeFromFilename(filename: string | undefined): (typeof HTML_STILL_SLOT_IMAGE_MIMES)[number] | undefined {
  const extension = filename?.split('.').pop()?.toLowerCase();
  if (!extension || !SLOT_IMAGE_EXTENSIONS.has(extension)) {
    return undefined;
  }
  if (extension === 'png') {
    return 'image/png';
  }
  if (extension === 'webp') {
    return 'image/webp';
  }
  return 'image/jpeg';
}

export function isDerivedHtmlStillAsset(asset: Pick<Asset, 'metadata'>): boolean {
  return asset.metadata?.htmlStill === true;
}

export function isHtmlStillSlotImageAsset(asset: Pick<Asset, 'type' | 'mimeType' | 'filename' | 'metadata'>): boolean {
  if (asset.type !== 'image' || isDerivedHtmlStillAsset(asset)) {
    return false;
  }
  return Boolean(normalizeSlotImageMime(asset.mimeType) ?? mimeFromFilename(asset.filename));
}

export function listHtmlStillSlotImageAssets(
  assets: readonly Asset[],
  options: { excludeAssetIds?: readonly string[] } = {}
): Asset[] {
  const excluded = new Set(options.excludeAssetIds ?? []);
  return assets.filter((asset) => isHtmlStillSlotImageAsset(asset) && !excluded.has(asset.id));
}

function rawHtmlStillSlotImageAssetIds(templateData: Record<string, unknown> | undefined): string[] {
  if (!templateData) {
    return [];
  }
  const ids: string[] = [];
  if (typeof templateData.imageAssetId === 'string' && templateData.imageAssetId.trim()) {
    ids.push(templateData.imageAssetId.trim());
  }
  if (Array.isArray(templateData.products)) {
    for (const product of templateData.products) {
      if (product && typeof product === 'object' && typeof (product as { imageAssetId?: unknown }).imageAssetId === 'string') {
        const imageAssetId = (product as { imageAssetId: string }).imageAssetId.trim();
        if (imageAssetId) {
          ids.push(imageAssetId);
        }
      }
    }
  }
  return [...new Set(ids)];
}

export function htmlStillSlotImageAssetIds(visual: Pick<HtmlVisual, 'template' | 'templateData'>): string[] {
  const canonical = canonicalizeHtmlStillTemplateId(visual.template);
  if (!canonical) {
    return [];
  }
  try {
    return [...new Set(collectHtmlStillImageAssetIds(parseHtmlStillTemplateData(canonical, visual.templateData ?? {})))];
  } catch {
    return rawHtmlStillSlotImageAssetIds(visual.templateData);
  }
}

export function applyHtmlStillSlotImage(
  templateData: Record<string, unknown> | undefined,
  assetId: string | undefined,
  productIndex?: number
): Record<string, unknown> {
  const next = { ...(templateData ?? {}) };
  if (typeof productIndex === 'number') {
    const products = Array.isArray(next.products)
      ? (next.products as Array<Record<string, unknown>>).map((product, index) => {
          if (index !== productIndex) {
            return product;
          }
          const updated = { ...product };
          if (!assetId) {
            delete updated.imageAssetId;
          } else {
            updated.imageAssetId = assetId;
          }
          return updated;
        })
      : [];
    return { ...next, products };
  }
  if (!assetId) {
    delete next.imageAssetId;
  } else {
    next.imageAssetId = assetId;
  }
  return next;
}
