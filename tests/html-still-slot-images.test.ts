import { describe, expect, it } from 'vitest';

import { applyHtmlStillSlotImage, htmlStillSlotImageAssetIds, isHtmlStillSlotImageAsset, listHtmlStillSlotImageAssets } from '@/lib/projects/html-still-slot-images';
import { getAssetUsage } from '@/lib/projects/usage';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import type { HtmlVisual, Scene } from '@/lib/types/scene';

const NOW = '2026-10-22T00:00:00.000Z';

function makeAsset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    type: 'image',
    status: 'available',
    provenance: 'imported',
    filename: `${id}.png`,
    localPath: `assets/${id}.png`,
    mimeType: 'image/png',
    width: 800,
    height: 600,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function makeHtmlScene(id: string, visual: HtmlVisual): Scene {
  return {
    id,
    order: 1,
    duration: 4,
    type: 'html',
    visual,
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: ''
  };
}

function makeProject(scenes: Scene[], assets: Asset[]): Project {
  return {
    id: 'project-slot-images',
    title: 'Slot images',
    description: '',
    durationTarget: 4,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: NOW,
    updatedAt: NOW,
    narration: { text: '', segments: [] },
    scenes,
    assets,
    references: [],
    compositions: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: false
    }
  };
}

describe('HTML still slot image candidates', () => {
  it('keeps PNG, JPEG, and WebP project images and excludes derived stills and non-images', () => {
    const png = makeAsset('photo-png');
    const jpeg = makeAsset('photo-jpeg', { filename: 'photo.jpg', mimeType: 'image/jpeg' });
    const webp = makeAsset('photo-webp', { filename: 'photo.webp', mimeType: 'image/webp' });
    const gif = makeAsset('photo-gif', { filename: 'photo.gif', mimeType: 'image/gif' });
    const still = makeAsset('html-still', { provenance: 'generated', metadata: { htmlStill: true } });
    const video = makeAsset('clip', { type: 'video', filename: 'clip.mp4', mimeType: 'video/mp4' });
    const graphic = makeAsset('card', { type: 'graphic', filename: 'card.png', mimeType: 'image/png' });

    expect(isHtmlStillSlotImageAsset(png)).toBe(true);
    expect(isHtmlStillSlotImageAsset(jpeg)).toBe(true);
    expect(isHtmlStillSlotImageAsset(webp)).toBe(true);
    expect(isHtmlStillSlotImageAsset(gif)).toBe(false);
    expect(isHtmlStillSlotImageAsset(still)).toBe(false);
    expect(isHtmlStillSlotImageAsset(video)).toBe(false);
    expect(isHtmlStillSlotImageAsset(graphic)).toBe(false);

    expect(listHtmlStillSlotImageAssets([png, jpeg, webp, gif, still, video, graphic], { excludeAssetIds: [still.id] }).map((asset) => asset.id)).toEqual([
      'photo-png',
      'photo-jpeg',
      'photo-webp'
    ]);
  });

  it('collects slot ids from headline, product, comparison, and callout templates', () => {
    expect(htmlStillSlotImageAssetIds({ template: 'headline', templateData: { title: 'Live', imageAssetId: 'hero-1' } })).toEqual(['hero-1']);
    expect(htmlStillSlotImageAssetIds({ template: 'product_card', templateData: { name: 'Hub', imageAssetId: 'product-1' } })).toEqual(['product-1']);
    expect(htmlStillSlotImageAssetIds({
      template: 'product_comparison',
      templateData: {
        title: 'Compare',
        products: [
          { name: 'Air', imageAssetId: 'air-1', features: [{ label: 'Weight', value: '1 kg' }] },
          { name: 'Pro', imageAssetId: 'pro-1', features: [{ label: 'Weight', value: '2 kg' }] }
        ]
      }
    })).toEqual(['air-1', 'pro-1']);
    expect(htmlStillSlotImageAssetIds({ template: 'feature_callouts', templateData: { name: 'Hub', imageAssetId: 'hub-1', callouts: [{ label: 'Lens', detail: 'Wide' }] } })).toEqual(['hub-1']);
  });

  it('selects, clears, and imports into every supported slot without writing URLs', () => {
    expect(applyHtmlStillSlotImage({ title: 'Live' }, 'hero-1').imageAssetId).toBe('hero-1');
    expect(applyHtmlStillSlotImage({ title: 'Live', imageAssetId: 'hero-1' }, undefined).imageAssetId).toBeUndefined();
    expect(applyHtmlStillSlotImage({ name: 'Hub' }, 'imported-1').imageAssetId).toBe('imported-1');

    const compared = applyHtmlStillSlotImage({
      title: 'Compare',
      products: [
        { name: 'Air', features: [{ label: 'Weight', value: '1 kg' }] },
        { name: 'Pro', imageAssetId: 'old-pro', features: [{ label: 'Weight', value: '2 kg' }] }
      ]
    }, 'air-imported', 0);
    expect((compared.products as Array<{ imageAssetId?: string }>)[0].imageAssetId).toBe('air-imported');
    expect((compared.products as Array<{ imageAssetId?: string }>)[1].imageAssetId).toBe('old-pro');
    expect(applyHtmlStillSlotImage(compared, undefined, 1).products).toEqual([
      { name: 'Air', features: [{ label: 'Weight', value: '1 kg' }], imageAssetId: 'air-imported' },
      { name: 'Pro', features: [{ label: 'Weight', value: '2 kg' }] }
    ]);
  });
});

describe('HTML still slot asset usage', () => {
  it('blocks deletion of images used by each supported slot type', () => {
    const hero = makeAsset('hero-1');
    const unused = makeAsset('unused-1');
    const project = makeProject([
      makeHtmlScene('scene-headline', { kind: 'html', template: 'headline', templateData: { title: 'Live', imageAssetId: 'hero-1' } }),
      makeHtmlScene('scene-product', { kind: 'html', template: 'product_card', templateData: { name: 'Hub', imageAssetId: 'hero-1' } }),
      makeHtmlScene('scene-compare', {
        kind: 'html',
        template: 'product_comparison',
        templateData: {
          title: 'Compare',
          products: [
            { name: 'Air', imageAssetId: 'hero-1', features: [{ label: 'Weight', value: '1 kg' }] },
            { name: 'Pro', features: [{ label: 'Weight', value: '2 kg' }] }
          ]
        }
      }),
      makeHtmlScene('scene-callouts', { kind: 'html', template: 'feature_callouts', templateData: { name: 'Hub', imageAssetId: 'hero-1', callouts: [{ label: 'Lens', detail: 'Wide' }] } })
    ], [hero, unused]);

    expect(getAssetUsage(project, 'hero-1')).toEqual(['scene-headline', 'scene-product', 'scene-compare', 'scene-callouts']);
    expect(getAssetUsage(project, 'unused-1')).toEqual([]);
  });

  it('still counts a derived HTML still PNG as used via visual.assetId', () => {
    const still = makeAsset('html-1', { provenance: 'generated', metadata: { htmlStill: true } });
    const project = makeProject([
      makeHtmlScene('scene-html', { kind: 'html', template: 'headline', templateData: { title: 'Live' }, assetId: 'html-1' })
    ], [still]);

    expect(getAssetUsage(project, 'html-1')).toEqual(['scene-html']);
  });
});
