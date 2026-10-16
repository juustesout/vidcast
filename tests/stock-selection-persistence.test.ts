import { describe, expect, it } from 'vitest';

import { normalizeProject } from '@/lib/projects/normalize-project';
import type { Project } from '@/lib/types/render';

const now = new Date(1000).toISOString();

const manualSelection = {
  provider: 'pexels' as const,
  photoId: '42',
  query: 'sunset',
  orientation: 'landscape' as const,
  usagePolicy: 'download' as const,
  attribution: {
    provider: 'pexels' as const,
    providerName: 'Pexels',
    photoId: '42',
    photographerName: 'Ada',
    sourceUrl: 'https://pexels.com/42',
    license: 'Pexels License'
  },
  sourceUrl: 'https://pexels.com/42',
  imageUrl: 'https://images.pexels.com/42.jpg',
  width: 1200,
  height: 800,
  selectedAt: now,
  selectionKey: 'landscape::sunset',
  origin: 'manual' as const
};

function buildProject(visual: Record<string, unknown>): Project {
  return {
    id: 'project-stock',
    title: 'Stock persistence',
    description: '',
    durationTarget: 30,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 5,
        type: 'image',
        narration: { text: '' },
        visual,
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ],
    assets: [
      { id: 'asset-1', type: 'image', status: 'available', provenance: 'stock', filename: 'asset-1.png', metadata: {}, createdAt: now }
    ],
    references: [],
    compositions: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    }
  } as unknown as Project;
}

describe('normalizeProject stock selection persistence', () => {
  it('preserves a download-policy stock selection verbatim (never coerced to asset/generated_image)', () => {
    const project = normalizeProject(
      buildProject({
        kind: 'stock_image',
        query: 'sunset',
        orientation: 'landscape',
        preferredProviders: ['pexels'],
        assetId: 'asset-1',
        selection: manualSelection
      })
    );

    const visual = project.scenes[0].visual as unknown as Record<string, unknown>;
    expect(visual.kind).toBe('stock_image');
    expect(visual.query).toBe('sunset');
    expect(visual.orientation).toBe('landscape');
    expect(visual.preferredProviders).toEqual(['pexels']);
    expect(visual.assetId).toBe('asset-1');
    expect(visual.selection).toEqual(manualSelection);
  });

  it('keeps a hotlink stock visual without an asset as stock_image', () => {
    const project = normalizeProject(
      buildProject({ kind: 'stock_image', query: 'city', selection: { ...manualSelection, usagePolicy: 'hotlink', assetId: undefined } })
    );

    const visual = project.scenes[0].visual as unknown as Record<string, unknown>;
    expect(visual.kind).toBe('stock_image');
    expect(visual.selection).toMatchObject({ usagePolicy: 'hotlink', origin: 'manual' });
  });

  it('normalization is idempotent for a stock_image visual', () => {
    const once = normalizeProject(
      buildProject({ kind: 'stock_image', query: 'sunset', selection: manualSelection })
    );
    const twice = normalizeProject(once);

    expect(twice.scenes[0].visual).toEqual(once.scenes[0].visual);
  });
});
