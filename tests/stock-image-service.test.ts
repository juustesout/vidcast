import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import { FakeStockProvider } from '@/lib/ai/stock/fake-provider';
import type { StockProviderRegistry } from '@/lib/ai/stock/registry';
import { InMemoryStockStateStore } from '@/lib/ai/stock/stock-state-store';
import { StockProviderError, type StockProvider } from '@/lib/ai/stock/stock-provider';
import { buildStockSelectionDependencies, selectSceneStockImage, selectSceneStockPhoto } from '@/lib/generation/stock-image-service';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import type { Scene, StockImageVisual } from '@/lib/types/scene';
import type { StockPhoto } from '@/lib/types/stock';
import { FileExclusiveLock, InMemoryExclusiveLock } from '@/lib/utils/exclusive-file-lock';

function makeScene(visual: StockImageVisual): Scene {
  return {
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
  } as unknown as Scene;
}

function makeProject(visual: StockImageVisual): Project {
  return {
    id: 'project-1',
    title: 'Stock',
    scenes: [makeScene(visual)],
    assets: []
  } as unknown as Project;
}

function makeAsset(id: string): Asset {
  return {
    id,
    type: 'image',
    status: 'available',
    provenance: 'stock',
    filename: `${id}.png`,
    metadata: {},
    createdAt: new Date(1000).toISOString()
  };
}

function createHarness(visual: StockImageVisual) {
  let project = makeProject(visual);
  let assetCounter = 0;

  const store = {
    getProject: vi.fn(async (id: string) => (id === project.id ? project : null)),
    mutateProject: vi.fn(async (id: string, mutator: (current: Project) => Project) => {
      if (id !== project.id) return null;
      project = mutator(project);
      return project;
    })
  };

  const saveStockImage = vi.fn(async () => makeAsset(`asset-${(assetCounter += 1)}`));
  const realProviderRequested = vi.fn();

  const registry: StockProviderRegistry = {
    getProvider: (id) => {
      if (id !== 'fake') {
        realProviderRequested(id);
        throw new Error(`real provider ${id} must not be contacted in mock mode`);
      }
      return new FakeStockProvider();
    },
    listProviders: () => [],
    configurationStatus: () => []
  };

  const dependencies = buildStockSelectionDependencies({
    store,
    media: { saveStockImage },
    registry,
    stateStore: new InMemoryStockStateStore({ now: () => 1000 }),
    now: () => 1000,
    submitLocks: new InMemoryExclusiveLock()
  });

  return {
    dependencies,
    saveStockImage,
    realProviderRequested,
    getProject: () => project
  };
}

describe('selectSceneStockImage', () => {
  it('selects a fake stock photo in mock mode and persists a downloadable asset', async () => {
    const harness = createHarness({ kind: 'stock_image', query: 'sunset over mountains', orientation: 'landscape' });

    const result = await selectSceneStockImage('project-1', 'scene-1', { mode: 'mock' }, harness.dependencies);

    expect(result.status).toBe('selected');
    expect(result.provider).toBe('fake');
    expect(result.usagePolicy).toBe('download');
    expect(result.assetId).toBe('asset-1');
    expect(harness.saveStockImage).toHaveBeenCalledTimes(1);
    expect(harness.realProviderRequested).not.toHaveBeenCalled();

    const persistedScene = harness.getProject().scenes[0];
    expect(persistedScene.visual).toMatchObject({
      kind: 'stock_image',
      assetId: 'asset-1',
      selection: { provider: 'fake', usagePolicy: 'download' }
    });
    expect(harness.getProject().assets).toHaveLength(1);
  });

  it('is idempotent: a second call reports current and does not re-download', async () => {
    const harness = createHarness({ kind: 'stock_image', query: 'forest path' });

    await selectSceneStockImage('project-1', 'scene-1', { mode: 'mock' }, harness.dependencies);
    const second = await selectSceneStockImage('project-1', 'scene-1', { mode: 'mock' }, harness.dependencies);

    expect(second.status).toBe('current');
    expect(second.cached).toBe(true);
    expect(harness.saveStockImage).toHaveBeenCalledTimes(1);
    expect(harness.getProject().assets).toHaveLength(1);
  });

  it('falls back to another candidate when the selected image download fails', async () => {
    const visual: StockImageVisual = { kind: 'stock_image', query: 'transient download failure', orientation: 'landscape' };
    let project = makeProject(visual);
    const store = {
      getProject: vi.fn(async (id: string) => (id === project.id ? project : null)),
      mutateProject: vi.fn(async (id: string, mutator: (current: Project) => Project) => {
        if (id !== project.id) return null;
        project = mutator(project);
        return project;
      })
    };
    const saveStockImage = vi.fn(async () => makeAsset('asset-fallback'));
    const fetchedPhotoIds: string[] = [];
    const searchPhotos = vi.fn(async (query: { query: string }) => ({
      provider: 'fake' as const,
      query: query.query,
      photos: [0, 1, 2, 3].map((index) => ({
        provider: 'fake' as const,
        photoId: `fake-fallback-${index}`,
        width: 1280,
        height: 720,
        imageUrl: `https://cdn.local/fake-fallback-${index}.jpg`,
        downloadUrl: `https://cdn.local/fake-fallback-${index}.jpg`,
        sourceUrl: `https://fake.local/fake-fallback-${index}`,
        photographerName: 'Fake Photographer',
        usagePolicy: 'download' as const,
        attribution: {
          provider: 'fake' as const,
          providerName: 'Fake',
          photoId: `fake-fallback-${index}`,
          photographerName: 'Fake Photographer',
          sourceUrl: `https://fake.local/fake-fallback-${index}`,
          license: 'Synthetic fixture'
        }
      }))
    }));

    const provider: StockProvider = {
      providerId: 'fake',
      displayName: 'Fake',
      usagePolicy: 'download',
      license: 'Synthetic fixture',
      isConfigured: () => true,
      searchPhotos,
      fetchPhoto: async (photo) => {
        fetchedPhotoIds.push(photo.photoId);
        if (fetchedPhotoIds.length === 1) {
          throw new StockProviderError('Fake image download failed (400).', 'PROVIDER_ERROR', 400, { provider: 'fake' });
        }
        return { mimeType: 'image/png', data: Buffer.from('fake-bytes') };
      }
    };

    const dependencies = buildStockSelectionDependencies({
      store,
      media: { saveStockImage },
      registry: {
        getProvider: () => provider,
        listProviders: () => [],
        configurationStatus: () => []
      },
      stateStore: new InMemoryStockStateStore({ now: () => 1000 }),
      now: () => 1000,
      submitLocks: new InMemoryExclusiveLock()
    });

    const result = await selectSceneStockImage('project-1', 'scene-1', { mode: 'mock' }, dependencies);

    expect(result.status).toBe('selected');
    expect(fetchedPhotoIds).toHaveLength(2);
    expect(fetchedPhotoIds[1]).not.toBe(fetchedPhotoIds[0]);
    expect(result.photoId).toBe(fetchedPhotoIds[1]);
    expect(saveStockImage).toHaveBeenCalledTimes(1);
    expect(searchPhotos).toHaveBeenCalledTimes(2);
    const selection = (project.scenes[0].visual as StockImageVisual).selection;
    expect(selection?.photoId).toBe(fetchedPhotoIds[1]);
  });

  it('treats an existing hotlink selection as current without storing an asset', async () => {
    const harness = createHarness({
      kind: 'stock_image',
      query: 'city skyline',
      selection: {
        provider: 'unsplash',
        photoId: 'abc',
        query: 'city skyline',
        usagePolicy: 'hotlink',
        attribution: {
          provider: 'unsplash',
          providerName: 'Unsplash',
          photoId: 'abc',
          photographerName: 'Jane',
          sourceUrl: 'https://unsplash.com/photos/abc',
          license: 'Unsplash License'
        },
        sourceUrl: 'https://unsplash.com/photos/abc',
        imageUrl: 'https://images.unsplash.com/abc',
        width: 1000,
        height: 1000,
        selectedAt: new Date(1000).toISOString(),
        selectionKey: 'any::city skyline'
      }
    });

    const result = await selectSceneStockImage('project-1', 'scene-1', { mode: 'mock' }, harness.dependencies);

    expect(result.status).toBe('current');
    expect(result.usagePolicy).toBe('hotlink');
    expect(harness.saveStockImage).not.toHaveBeenCalled();
  });

  it('rejects a scene without a search query', async () => {
    const harness = createHarness({ kind: 'stock_image', query: '   ' });

    await expect(
      selectSceneStockImage('project-1', 'scene-1', { mode: 'mock' }, harness.dependencies)
    ).rejects.toMatchObject({ code: 'stock.scene.missingQuery' });
  });

  describe('concurrent scene submit reservation', () => {
    it('lets only one of two overlapping auto-selects reach the provider', async () => {
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let enteredSearch: () => void = () => {};
      const searchEntered = new Promise<void>((resolve) => {
        enteredSearch = resolve;
      });
      const harness = createHarness({ kind: 'stock_image', query: 'sunset over mountains', orientation: 'landscape' });
      const inner = new FakeStockProvider();
      let searchCalls = 0;
      const gated: StockProvider = {
        providerId: inner.providerId,
        displayName: inner.displayName,
        usagePolicy: inner.usagePolicy,
        license: inner.license,
        isConfigured: () => inner.isConfigured(),
        async searchPhotos(query) {
          searchCalls += 1;
          enteredSearch();
          await gate;
          return inner.searchPhotos(query);
        },
        fetchPhoto: (photo) => inner.fetchPhoto(photo)
      };
      const dependencies = buildStockSelectionDependencies({
        ...harness.dependencies,
        registry: {
          getProvider: () => gated,
          listProviders: () => [],
          configurationStatus: () => []
        }
      });

      const first = selectSceneStockImage('project-1', 'scene-1', { mode: 'mock' }, dependencies);
      await searchEntered;
      await expect(
        selectSceneStockImage('project-1', 'scene-1', { mode: 'mock' }, dependencies)
      ).rejects.toMatchObject({ code: 'stock.scene.alreadyRunning' });
      releaseGate();
      await first;
      expect(searchCalls).toBe(1);
    });

    it('lets only one of two independent file locks reach the stock provider', async () => {
      const dir = path.join(os.tmpdir(), `stock-select-lock-${process.pid}-${Date.now()}`);
      const resolvePath = (key: string) => path.join(dir, `${key.replace(/[^A-Za-z0-9._-]+/g, '_')}.lock`);
      const holder = new FileExclusiveLock({ resolvePath });
      const challenger = new FileExclusiveLock({ resolvePath });
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let enteredSearch: () => void = () => {};
      const searchEntered = new Promise<void>((resolve) => {
        enteredSearch = resolve;
      });
      const harness = createHarness({ kind: 'stock_image', query: 'sunset over mountains', orientation: 'landscape' });
      const inner = new FakeStockProvider();
      let searchCalls = 0;
      const gated: StockProvider = {
        providerId: inner.providerId,
        displayName: inner.displayName,
        usagePolicy: inner.usagePolicy,
        license: inner.license,
        isConfigured: () => inner.isConfigured(),
        async searchPhotos(query) {
          searchCalls += 1;
          enteredSearch();
          await gate;
          return inner.searchPhotos(query);
        },
        fetchPhoto: (photo) => inner.fetchPhoto(photo)
      };
      const base = buildStockSelectionDependencies({
        ...harness.dependencies,
        registry: {
          getProvider: () => gated,
          listProviders: () => [],
          configurationStatus: () => []
        }
      });

      const first = selectSceneStockImage('project-1', 'scene-1', { mode: 'mock' }, {
        ...base,
        submitLocks: holder
      });
      await searchEntered;
      await expect(
        selectSceneStockImage('project-1', 'scene-1', { mode: 'mock' }, {
          ...base,
          submitLocks: challenger
        })
      ).rejects.toMatchObject({ code: 'stock.scene.alreadyRunning' });
      releaseGate();
      await first;
      expect(searchCalls).toBe(1);
    });
  });
});

function manualPhoto(overrides: Partial<StockPhoto> = {}): StockPhoto {
  return {
    provider: 'fake',
    photoId: 'fake-7',
    width: 1200,
    height: 800,
    imageUrl: 'https://cdn.local/fake-7.jpg',
    sourceUrl: 'https://fake.local/fake-7',
    photographerName: 'Sam',
    usagePolicy: 'download',
    attribution: {
      provider: 'fake',
      providerName: 'Fake',
      photoId: 'fake-7',
      photographerName: 'Sam',
      sourceUrl: 'https://fake.local/fake-7',
      license: 'Synthetic fixture'
    },
    ...overrides
  };
}

describe('selectSceneStockPhoto', () => {
  it('persists an explicitly chosen photo with manual origin and attribution', async () => {
    const harness = createHarness({ kind: 'stock_image', query: 'old query' });

    const result = await selectSceneStockPhoto(
      'project-1',
      'scene-1',
      manualPhoto(),
      { query: 'chosen query', orientation: 'landscape', mode: 'mock' },
      harness.dependencies
    );

    expect(result.status).toBe('selected');
    expect(result.provider).toBe('fake');
    expect(result.assetId).toBe('asset-1');
    expect(harness.saveStockImage).toHaveBeenCalledTimes(1);

    const visual = harness.getProject().scenes[0].visual as StockImageVisual;
    expect(visual.selection).toMatchObject({
      provider: 'fake',
      photoId: 'fake-7',
      origin: 'manual',
      query: 'chosen query',
      orientation: 'landscape',
      attribution: { photographerName: 'Sam', license: 'Synthetic fixture' }
    });
  });

  it('is idempotent for the same chosen photo', async () => {
    const harness = createHarness({ kind: 'stock_image', query: 'old query' });

    await selectSceneStockPhoto('project-1', 'scene-1', manualPhoto(), { query: 'q', mode: 'mock' }, harness.dependencies);
    const second = await selectSceneStockPhoto('project-1', 'scene-1', manualPhoto(), { query: 'q', mode: 'mock' }, harness.dependencies);

    expect(second.status).toBe('current');
    expect(harness.saveStockImage).toHaveBeenCalledTimes(1);
  });

  it('rejects a provider that is not available in the current mode', async () => {
    const harness = createHarness({ kind: 'stock_image', query: 'anything' });

    await expect(
      selectSceneStockPhoto(
        'project-1',
        'scene-1',
        manualPhoto({ provider: 'pexels', usagePolicy: 'download' }),
        { query: 'anything', mode: 'mock' },
        harness.dependencies
      )
    ).rejects.toMatchObject({ code: 'stock.provider.notAllowed', status: 403 });
    expect(harness.saveStockImage).not.toHaveBeenCalled();
  });

  it('rejects an invalid photo payload', async () => {
    const harness = createHarness({ kind: 'stock_image', query: 'anything' });

    await expect(
      selectSceneStockPhoto(
        'project-1',
        'scene-1',
        manualPhoto({ imageUrl: '' }),
        { query: 'anything', mode: 'mock' },
        harness.dependencies
      )
    ).rejects.toMatchObject({ code: 'stock.photo.invalid' });
  });
});
