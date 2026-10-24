import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { HtmlStillSlotImagePicker } from '@/components/project/html-still-slot-image-picker';
import type { Asset } from '@/lib/types/asset';

vi.mock('next/image', () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => React.createElement('img', props)
}));

const NOW = '2026-10-22T00:00:00.000Z';

function makeAsset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    type: 'image',
    status: 'available',
    provenance: 'imported',
    filename: `${id}.png`,
    originalFilename: `${id}.png`,
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

describe('HtmlStillSlotImagePicker', () => {
  it('lists PNG, JPEG, and WebP project images and excludes derived stills and non-images', () => {
    const html = renderToStaticMarkup(React.createElement(HtmlStillSlotImagePicker, {
      projectId: 'project-1',
      assets: [
        makeAsset('photo-png', { originalFilename: 'hero.png' }),
        makeAsset('photo-jpeg', { filename: 'hero.jpg', originalFilename: 'hero.jpg', mimeType: 'image/jpeg' }),
        makeAsset('photo-webp', { filename: 'hero.webp', originalFilename: 'hero.webp', mimeType: 'image/webp' }),
        makeAsset('html-still', { provenance: 'generated', metadata: { htmlStill: true }, originalFilename: 'scene-01-html-still.png' }),
        makeAsset('clip', { type: 'video', filename: 'clip.mp4', mimeType: 'video/mp4' }),
        makeAsset('photo-gif', { filename: 'anim.gif', mimeType: 'image/gif' })
      ],
      excludeAssetIds: ['html-still'],
      value: 'photo-png',
      onSelect: () => undefined,
      onImport: () => undefined
    }));

    expect(html).toContain('hero.png');
    expect(html).toContain('hero.jpg');
    expect(html).toContain('hero.webp');
    expect(html).toContain('No image');
    expect(html).toContain('Clear image');
    expect(html).toContain('Import image');
    expect(html).toContain('/api/projects/project-1/assets/photo-png/file');
    expect(html).not.toContain('scene-01-html-still.png');
    expect(html).not.toContain('clip.mp4');
    expect(html).not.toContain('anim.gif');
  });

  it('keeps a clear option and does not treat a URL as a selectable asset', () => {
    const html = renderToStaticMarkup(React.createElement(HtmlStillSlotImagePicker, {
      projectId: 'project-1',
      assets: [makeAsset('photo-png')],
      value: 'https://example.com/x.png',
      onSelect: () => undefined,
      onImport: () => undefined
    }));

    expect(html).toContain('value=""');
    expect(html).toContain('No image');
    expect(html).toContain('Selected image is not a usable PNG, JPEG, or WebP project asset.');
    expect(html).not.toContain('https://example.com/x.png');
  });
});
