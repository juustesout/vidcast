import { createHash } from 'node:crypto';

import type { HtmlVisual } from '@/lib/types/scene';

export function createHtmlStillFingerprint(visual: Pick<HtmlVisual, 'template' | 'html' | 'css' | 'templateData' | 'width' | 'height' | 'background'>): string {
  return createHash('sha256')
    .update(JSON.stringify({
      template: visual.template ?? null,
      html: visual.html ?? '',
      css: visual.css ?? '',
      templateData: visual.templateData ?? {},
      width: visual.width ?? 1920,
      height: visual.height ?? 1080,
      background: visual.background ?? 'opaque'
    }))
    .digest('hex');
}

export function htmlStillAssetIsCurrent(visual: HtmlVisual): boolean {
  if (!visual.assetId || !visual.fingerprint) {
    return false;
  }
  return visual.fingerprint === createHtmlStillFingerprint(visual);
}
