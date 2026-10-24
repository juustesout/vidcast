import type { HtmlVisual } from '@/lib/types/scene';

export interface HtmlStillImageDigest {
  assetId: string;
  sha256: string;
}

function referencedHtmlStillImageAssetIds(visual: Pick<HtmlVisual, 'template' | 'templateData'>): string[] {
  if (!visual.template) {
    return [];
  }
  const data = visual.templateData;
  if (!data || typeof data !== 'object') {
    return [];
  }
  const ids: string[] = [];
  if (typeof data.imageAssetId === 'string' && data.imageAssetId) {
    ids.push(data.imageAssetId);
  }
  if (Array.isArray(data.products)) {
    for (const product of data.products) {
      if (product && typeof product === 'object' && typeof product.imageAssetId === 'string' && product.imageAssetId) {
        ids.push(product.imageAssetId);
      }
    }
  }
  return [...new Set(ids)];
}

export function normalizeHtmlStillImageDigests(images: readonly HtmlStillImageDigest[] = []): HtmlStillImageDigest[] {
  return images
    .map((image) => ({ assetId: image.assetId, sha256: image.sha256 }))
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
}

export function createHtmlStillFingerprint(
  visual: Pick<HtmlVisual, 'template' | 'html' | 'css' | 'templateData' | 'width' | 'height' | 'background'>,
  images: readonly HtmlStillImageDigest[] = []
): string {
  const payload: {
    template: string | null;
    html: string;
    css: string;
    templateData: Record<string, unknown>;
    width: number;
    height: number;
    background: string;
    images?: HtmlStillImageDigest[];
  } = {
    template: visual.template ?? null,
    html: visual.html ?? '',
    css: visual.css ?? '',
    templateData: visual.templateData ?? {},
    width: visual.width ?? 1920,
    height: visual.height ?? 1080,
    background: visual.background ?? 'opaque'
  };
  const referenced = new Set(referencedHtmlStillImageAssetIds(visual));
  const digests = normalizeHtmlStillImageDigests(images).filter((image) => referenced.has(image.assetId));
  if (digests.length > 0) {
    payload.images = digests;
  }
  return JSON.stringify(payload);
}

export function htmlStillAssetIsCurrent(visual: HtmlVisual, images: readonly HtmlStillImageDigest[] = []): boolean {
  if (!visual.assetId || !visual.fingerprint) {
    return false;
  }
  if (referencedHtmlStillImageAssetIds(visual).length > 0 && images.length === 0) {
    return false;
  }
  return visual.fingerprint === createHtmlStillFingerprint(visual, images);
}
