import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeStockProvider } from '@/lib/ai/stock/fake-provider';
import type { StockProviderRegistry } from '@/lib/ai/stock/registry';
import { InMemoryStockStateStore } from '@/lib/ai/stock/stock-state-store';
import { StockProviderError, type StockProvider } from '@/lib/ai/stock/stock-provider';
import { StockRouter } from '@/lib/ai/stock/stock-router';
import { STOCK_PROVIDER_IDS } from '@/lib/ai/stock/catalog';
import { stampHumanApproval } from '@/lib/explainer/human-approval';
import { buildStockSelectionDependencies, selectSceneStockImage, selectSceneStockPhoto } from '@/lib/generation/stock-image-service';
import { deriveProductionPlan } from '@/lib/production/production-planner';
import { normalizeProject } from '@/lib/projects/normalize-project';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import type { Scene, StockImageVisual } from '@/lib/types/scene';
import type { StockPhoto, StockProviderId, StockSelection } from '@/lib/types/stock';
import { InMemoryExclusiveLock } from '@/lib/utils/exclusive-file-lock';

const NOW = 1_000_000;

function stockPhoto(provider: StockProviderId, photoId: string): StockPhoto {
  return {
    provider,
    photoId,
    width: 1280,
    height: 720,
    imageUrl: `https://images.example/${provider}/${photoId}.jpg`,
    downloadUrl: `https://images.example/${provider}/${photoId}.jpg`,
    sourceUrl: `https://example.com/${provider}/${photoId}`,
    photographerName: 'Photographer',
    usagePolicy: provider === 'unsplash' ? 'hotlink' : 'download',
    attribution: {
      provider,
      providerName: provider,
      photoId,
      photographerName: 'Photographer',
      sourceUrl: `https://example.com/${provider}/${photoId}`,
      license: 'Test License'
    }
  };
}

function stockSelection(provider: StockProviderId, photoId: string, origin: 'auto' | 'manual' = 'auto'): StockSelection {
  const photo = stockPhoto(provider, photoId);
  return {
    provider: photo.provider,
    photoId: photo.photoId,
    query: 'forest path',
    orientation: 'landscape',
    usagePolicy: photo.usagePolicy,
    attribution: photo.attribution,
    sourceUrl: photo.sourceUrl,
    imageUrl: photo.imageUrl,
    downloadUrl: photo.downloadUrl,
    width: photo.width,
    height: photo.height,
    selectedAt: new Date(NOW).toISOString(),
    selectionKey: 'landscape::forest path',
    origin
  };
}

function stubProvider(
  providerId: StockProviderId,
  options: {
    configured?: boolean;
    result?: () => Promise<StockPhoto[]>;
    calls?: { count: number };
  } = {}
): StockProvider {
  const photo = stockPhoto(providerId, `${providerId}-1`);
  return {
    providerId,
    displayName: providerId,
    usagePolicy: photo.usagePolicy,
    license: 'Test License',
    isConfigured: () => options.configured ?? true,
    async searchPhotos() {
      if (options.calls) {
        options.calls.count += 1;
      }
      const photos = options.result ? await options.result() : [photo];
      return { provider: providerId, query: 'forest path', photos };
    },
    async fetchPhoto() {
      return { mimeType: 'image/jpeg', data: Buffer.from(`${providerId}-bytes`) };
    }
  };
}

function registryWith(providers: Partial<Record<StockProviderId, StockProvider>>, calls?: Record<string, number>): StockProviderRegistry {
  return {
    getProvider(id) {
      if (calls) {
        calls[id] = (calls[id] ?? 0) + 1;
      }
      if (id === 'fake') {
        return new FakeStockProvider();
      }
      const provider = providers[id];
      if (!provider) {
        throw new Error(`unexpected provider ${id}`);
      }
      return provider;
    },
    listProviders: () => [],
    configurationStatus: () => []
  };
}

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

function makeProject(visual: StockImageVisual, assets: Asset[] = []): Project {
  const project = normalizeProject({
    id: 'project-1',
    title: 'P31 forensics',
    description: '',
    durationTarget: 5,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    narration: { text: '', segments: [] },
    scenes: [makeScene(visual)],
    assets,
    references: [],
    compositions: []
  } as unknown as Project);
  return {
    ...project,
    explainer: {
      ...project.explainer!,
      humanApproval: stampHumanApproval(project, { subject: 'user_test' })
    }
  };
}

function fakeAsset(): Asset {
  return {
    id: 'asset-fake',
    type: 'image',
    status: 'available',
    provenance: 'stock',
    filename: 'fake.png',
    metadata: {},
    createdAt: new Date(NOW).toISOString()
  } as unknown as Asset;
}

function createServiceHarness(visual: StockImageVisual, assets: Asset[] = []) {
  let project = makeProject(visual, assets);
  const saveStockImage = vi.fn(async () => fakeAsset());
  const stateStore = new InMemoryStockStateStore({ now: () => NOW });
  const registry = registryWith({
    unsplash: stubProvider('unsplash', { configured: false }),
    pexels: stubProvider('pexels', { configured: false }),
    pixabay: stubProvider('pixabay')
  });

  const store = {
    getProject: vi.fn(async (id: string) => (id === project.id ? project : null)),
    mutateProject: vi.fn(async (id: string, mutator: (current: Project) => Project) => {
      if (id !== project.id) return null;
      project = mutator(project);
      return project;
    })
  };

  const dependencies = buildStockSelectionDependencies({
    store,
    media: { saveStockImage },
    registry,
    stateStore,
    now: () => NOW,
    submitLocks: new InMemoryExclusiveLock()
  });

  return {
    dependencies,
    stateStore,
    saveStockImage,
    getProject: () => project
  };
}

function enablePaidSpendCap(overrides: Record<string, string> = {}): void {
  vi.stubEnv('PAID_SPEND_CAP_ENABLED', 'true');
  vi.stubEnv('PAID_SPEND_CAP_WINDOW_HOURS', '24');
  vi.stubEnv('PAID_SPEND_CAP_MAX_SUBMITS', '10');
  vi.stubEnv('PAID_SPEND_CAP_MAX_IMAGE_SUBMITS', '4');
  vi.stubEnv('PAID_SPEND_CAP_MAX_VIDEO_SUBMITS', '2');
  vi.stubEnv('PAID_SPEND_CAP_MAX_NARRATION_SUBMITS', '4');
  vi.stubEnv('PAID_SPEND_CAP_MAX_MUSIC_SUBMITS', '1');
  vi.stubEnv('PAID_SPEND_CAP_MAX_PRESENTER_SUBMITS', '1');
  for (const [name, value] of Object.entries(overrides)) {
    vi.stubEnv(name, value);
  }
}

beforeEach(() => {
  vi.stubEnv('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS', 'true');
  vi.stubEnv('STOCK_IMAGE_PROVIDER_ORDER', 'pixabay,pexels,unsplash');
  enablePaidSpendCap();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('P31.1 stock routing forensics', () => {
  it('does not reuse a mock-cached fake selection in real mode', async () => {
    const stateStore = new InMemoryStockStateStore({ now: () => NOW });
    const pixabay = stubProvider('pixabay');
    const registry = registryWith(
      {
        unsplash: stubProvider('unsplash', { configured: false }),
        pexels: stubProvider('pexels', { configured: false }),
        pixabay
      },
      {}
    );

    const mockRouter = new StockRouter({
      store: stateStore,
      getProvider: (id) => registry.getProvider(id),
      order: ['fake'],
      allowedProviders: ['fake'],
      now: () => NOW
    });
    const mock = await mockRouter.resolve({ query: 'forest path', orientation: 'landscape' });
    expect(mock.selection.provider).toBe('fake');

    const pixabayCalls = { count: 0 };
    const realRegistry = registryWith({
      unsplash: stubProvider('unsplash', { configured: false }),
      pexels: stubProvider('pexels', { configured: false }),
      pixabay: stubProvider('pixabay', { calls: pixabayCalls })
    });
    const realRouter = new StockRouter({
      store: stateStore,
      getProvider: (id) => realRegistry.getProvider(id),
      order: ['pixabay', ...STOCK_PROVIDER_IDS],
      allowedProviders: STOCK_PROVIDER_IDS,
      now: () => NOW
    });

    const real = await realRouter.resolve({ query: 'forest path', orientation: 'landscape' });

    expect(real.cached).toBe(false);
    expect(real.selection.provider).not.toBe('fake');
    expect(pixabayCalls.count).toBe(1);
  });

  it('does not treat a mock auto selection as current in real mode', async () => {
    const harness = createServiceHarness(
      {
        kind: 'stock_image',
        query: 'forest path',
        orientation: 'landscape',
        assetId: 'asset-fake',
        selection: stockSelection('fake', 'fake-1')
      },
      [fakeAsset()]
    );

    const result = await selectSceneStockImage('project-1', 'scene-1', { mode: 'real' }, harness.dependencies);

    expect(result.provider).not.toBe('fake');
    expect(result.status).toBe('selected');
    expect(harness.saveStockImage).toHaveBeenCalledTimes(1);
  });

  it('force re-selection ignores a cached fake selection in real mode', async () => {
    const harness = createServiceHarness(
      {
        kind: 'stock_image',
        query: 'forest path',
        orientation: 'landscape',
        assetId: 'asset-fake',
        selection: stockSelection('fake', 'fake-1')
      },
      [fakeAsset()]
    );
    await harness.stateStore.setCachedSelection('landscape::forest path', stockSelection('fake', 'fake-1'));

    const result = await selectSceneStockImage(
      'project-1',
      'scene-1',
      { mode: 'real', regenerate: true },
      harness.dependencies
    );

    expect(result.provider).toBe('pixabay');
    expect(harness.saveStockImage).toHaveBeenCalledTimes(1);
  });

  it('keeps an author-chosen manual selection pinned under force', () => {
    const project = makeProject(
      {
        kind: 'stock_image',
        query: 'forest path',
        orientation: 'landscape',
        assetId: 'asset-fake',
        selection: stockSelection('pixabay', 'pixabay-1', 'manual')
      },
      [fakeAsset()]
    );

    const plan = deriveProductionPlan(project, { force: true });
    const action = plan.actions.find((entry) => entry.type === 'stock_select');

    expect(action?.execute).toBe(false);
    expect(action?.reason).toContain('Manual');
  });

  it('re-runs an automatic selection under force', () => {
    const project = makeProject(
      {
        kind: 'stock_image',
        query: 'forest path',
        orientation: 'landscape',
        assetId: 'asset-fake',
        selection: stockSelection('fake', 'fake-1', 'auto')
      },
      [fakeAsset()]
    );

    const plan = deriveProductionPlan(project, { force: true });
    const action = plan.actions.find((entry) => entry.type === 'stock_select');

    expect(action?.execute).toBe(true);
    expect(action?.payload).toMatchObject({ regenerate: true });
  });

  it('fails closed when every real provider fails and never falls back to fake', async () => {
    const fakeCalls = { count: 0 };
    const registry = registryWith(
      {
        unsplash: stubProvider('unsplash', {
          configured: true,
          result: async () => {
            throw new StockProviderError('auth', 'AUTH_FAILED', 401, { provider: 'unsplash' });
          }
        }),
        pexels: stubProvider('pexels', {
          configured: true,
          result: async () => {
            throw new StockProviderError('down', 'PROVIDER_ERROR', 502, { provider: 'pexels' });
          }
        }),
        pixabay: stubProvider('pixabay', {
          configured: true,
          result: async () => {
            throw new StockProviderError('down', 'PROVIDER_ERROR', 502, { provider: 'pixabay' });
          }
        })
      },
      fakeCalls
    );
    const router = new StockRouter({
      store: new InMemoryStockStateStore({ now: () => NOW }),
      getProvider: (id) => registry.getProvider(id),
      order: [...STOCK_PROVIDER_IDS],
      allowedProviders: STOCK_PROVIDER_IDS,
      now: () => NOW
    });

    await expect(router.resolve({ query: 'forest path', orientation: 'landscape' })).rejects.toMatchObject({
      code: 'ALL_PROVIDERS_FAILED'
    });
    expect(fakeCalls.count).toBe(0);
  });

  it('falls back only to another allowed real provider', async () => {
    const registry = registryWith({
      unsplash: stubProvider('unsplash', {
        configured: true,
        result: async () => {
          throw new StockProviderError('auth', 'AUTH_FAILED', 401, { provider: 'unsplash' });
        }
      }),
      pexels: stubProvider('pexels', { result: async () => [] }),
      pixabay: stubProvider('pixabay')
    });
    const router = new StockRouter({
      store: new InMemoryStockStateStore({ now: () => NOW }),
      getProvider: (id) => registry.getProvider(id),
      order: [...STOCK_PROVIDER_IDS],
      allowedProviders: STOCK_PROVIDER_IDS,
      now: () => NOW
    });

    const result = await router.resolve({ query: 'forest path', orientation: 'landscape' });

    expect(result.selection.provider).toBe('pixabay');
    expect(result.diagnostics.map((entry) => entry.outcome)).toEqual(
      expect.arrayContaining(['auth_failed', 'empty', 'selected'])
    );
  });

  it('locks mock mode to the fake provider', async () => {
    const realCalls = { count: 0 };
    const registry = registryWith(
      {
        unsplash: stubProvider('unsplash', { calls: realCalls }),
        pexels: stubProvider('pexels', { calls: realCalls }),
        pixabay: stubProvider('pixabay', { calls: realCalls })
      },
      {}
    );
    const router = new StockRouter({
      store: new InMemoryStockStateStore({ now: () => NOW }),
      getProvider: (id) => registry.getProvider(id),
      order: ['fake', ...STOCK_PROVIDER_IDS],
      allowedProviders: ['fake'],
      now: () => NOW
    });

    const result = await router.resolve({ query: 'forest path', orientation: 'landscape' });

    expect(result.selection.provider).toBe('fake');
    expect(realCalls.count).toBe(0);
  });

  it('fails closed for real auto-select when the spend cap is disabled', async () => {
    vi.stubEnv('PAID_SPEND_CAP_ENABLED', 'false');
    const harness = createServiceHarness({
      kind: 'stock_image',
      query: 'forest path',
      orientation: 'landscape'
    });

    await expect(
      selectSceneStockImage('project-1', 'scene-1', { mode: 'real' }, harness.dependencies)
    ).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.invalid'
    });
    expect(harness.saveStockImage).not.toHaveBeenCalled();
  });

  it('fails closed for a real download choose when the spend cap is disabled', async () => {
    vi.stubEnv('PAID_SPEND_CAP_ENABLED', 'false');
    const harness = createServiceHarness({
      kind: 'stock_image',
      query: 'forest path',
      orientation: 'landscape'
    });

    await expect(
      selectSceneStockPhoto(
        'project-1',
        'scene-1',
        stockPhoto('pixabay', 'pixabay-1'),
        { query: 'forest path', mode: 'real' },
        harness.dependencies
      )
    ).rejects.toMatchObject({
      status: 403,
      code: 'paid.spend.cap.invalid'
    });
    expect(harness.saveStockImage).not.toHaveBeenCalled();
  });

  it('allows a real Unsplash hotlink choose when the spend cap is disabled', async () => {
    vi.stubEnv('PAID_SPEND_CAP_ENABLED', 'false');
    const harness = createServiceHarness({
      kind: 'stock_image',
      query: 'forest path',
      orientation: 'landscape'
    });

    const result = await selectSceneStockPhoto(
      'project-1',
      'scene-1',
      stockPhoto('unsplash', 'unsplash-1'),
      { query: 'forest path', mode: 'real' },
      harness.dependencies
    );

    expect(result.status).toBe('selected');
    expect(result.provider).toBe('unsplash');
    expect(result.usagePolicy).toBe('hotlink');
    expect(result.assetId).toBeUndefined();
    expect(harness.saveStockImage).not.toHaveBeenCalled();
  });

  it('rejects an explicit fake photo in real mode', async () => {
    const harness = createServiceHarness({
      kind: 'stock_image',
      query: 'forest path',
      orientation: 'landscape'
    });

    await expect(
      selectSceneStockPhoto('project-1', 'scene-1', stockPhoto('fake', 'fake-1'), { query: 'forest path', mode: 'real' }, harness.dependencies)
    ).rejects.toMatchObject({ code: 'stock.provider.notAllowed' });
  });

  it('surfaces a routing error instead of fake when the only real provider is unavailable', async () => {
    const harness = createServiceHarness(
      {
        kind: 'stock_image',
        query: 'forest path',
        orientation: 'landscape',
        assetId: 'asset-fake',
        selection: stockSelection('fake', 'fake-1')
      },
      [fakeAsset()]
    );
    const failingRegistry = registryWith({
      unsplash: stubProvider('unsplash', { configured: false }),
      pexels: stubProvider('pexels', { configured: false }),
      pixabay: stubProvider('pixabay', {
        configured: true,
        result: async () => {
          throw new StockProviderError('down', 'PROVIDER_ERROR', 502, { provider: 'pixabay' });
        }
      })
    });
    const dependencies = { ...harness.dependencies, registry: failingRegistry };

    await expect(
      selectSceneStockImage('project-1', 'scene-1', { mode: 'real', regenerate: true }, dependencies)
    ).rejects.toMatchObject({ code: 'stock.routing.failed' });
    expect(harness.saveStockImage).not.toHaveBeenCalled();
  });

  it('reuses a real cached selection in real mode without contacting a provider', async () => {
    const stateStore = new InMemoryStockStateStore({ now: () => NOW });
    await stateStore.setCachedSelection('landscape::forest path', stockSelection('pixabay', 'pixabay-1'));
    const calls = { count: 0 };
    const registry = registryWith({
      unsplash: stubProvider('unsplash', { configured: false }),
      pexels: stubProvider('pexels', { configured: false }),
      pixabay: stubProvider('pixabay', { calls })
    });
    const router = new StockRouter({
      store: stateStore,
      getProvider: (id) => registry.getProvider(id),
      order: [...STOCK_PROVIDER_IDS],
      allowedProviders: STOCK_PROVIDER_IDS,
      now: () => NOW
    });

    const result = await router.resolve({ query: 'forest path', orientation: 'landscape' });

    expect(result.cached).toBe(true);
    expect(result.selection.provider).toBe('pixabay');
    expect(calls.count).toBe(0);
  });

  it('accepts a fake cache hit in mock mode', async () => {
    const stateStore = new InMemoryStockStateStore({ now: () => NOW });
    await stateStore.setCachedSelection('landscape::forest path', stockSelection('fake', 'fake-1'));
    const realCalls = { count: 0 };
    const registry = registryWith(
      {
        unsplash: stubProvider('unsplash', { calls: realCalls }),
        pexels: stubProvider('pexels', { calls: realCalls }),
        pixabay: stubProvider('pixabay', { calls: realCalls })
      },
      {}
    );
    const router = new StockRouter({
      store: stateStore,
      getProvider: (id) => registry.getProvider(id),
      order: ['fake', ...STOCK_PROVIDER_IDS],
      allowedProviders: ['fake'],
      now: () => NOW
    });

    const result = await router.resolve({ query: 'forest path', orientation: 'landscape' });

    expect(result.cached).toBe(true);
    expect(result.selection.provider).toBe('fake');
    expect(realCalls.count).toBe(0);
  });

  it('re-plans an automatic fake selection in real mode without force', () => {
    const project = makeProject(
      {
        kind: 'stock_image',
        query: 'forest path',
        orientation: 'landscape',
        assetId: 'asset-fake',
        selection: stockSelection('fake', 'fake-1', 'auto')
      },
      [fakeAsset()]
    );

    const plan = deriveProductionPlan(project, { mode: 'real' });
    const action = plan.actions.find((entry) => entry.type === 'stock_select');

    expect(action?.status).toBe('ready');
    expect(action?.execute).toBe(true);
    expect(action?.payload).toMatchObject({ regenerate: true });
    expect(action?.reason).toContain('not valid for this mode');
  });

  it('blocks an incompatible manual fake selection in real mode instead of replacing it', () => {
    const project = makeProject(
      {
        kind: 'stock_image',
        query: 'forest path',
        orientation: 'landscape',
        assetId: 'asset-fake',
        selection: stockSelection('fake', 'fake-1', 'manual')
      },
      [fakeAsset()]
    );

    const plan = deriveProductionPlan(project, { mode: 'real' });
    const action = plan.actions.find((entry) => entry.type === 'stock_select');

    expect(action?.status).toBe('blocked');
    expect(action?.execute).toBe(false);
    expect(action?.reason).toContain('not available in real mode');
  });

  it('keeps a compatible manual selection pinned in real mode', () => {
    const project = makeProject(
      {
        kind: 'stock_image',
        query: 'forest path',
        orientation: 'landscape',
        assetId: 'asset-fake',
        selection: stockSelection('pixabay', 'pixabay-1', 'manual')
      },
      [fakeAsset()]
    );

    const plan = deriveProductionPlan(project, { mode: 'real', force: true });
    const action = plan.actions.find((entry) => entry.type === 'stock_select');

    expect(action?.status).toBe('current');
    expect(action?.execute).toBe(false);
    expect(action?.reason).toContain('Manual');
  });

  it('rejects an incompatible manual fake selection without overwriting it', async () => {
    const harness = createServiceHarness(
      {
        kind: 'stock_image',
        query: 'forest path',
        orientation: 'landscape',
        assetId: 'asset-fake',
        selection: stockSelection('fake', 'fake-1', 'manual')
      },
      [fakeAsset()]
    );

    await expect(
      selectSceneStockImage('project-1', 'scene-1', { mode: 'real' }, harness.dependencies)
    ).rejects.toMatchObject({ code: 'stock.selection.incompatible' });

    expect(harness.saveStockImage).not.toHaveBeenCalled();
    expect(harness.getProject().scenes[0].visual).toMatchObject({
      selection: { provider: 'fake', photoId: 'fake-1', origin: 'manual' }
    });
  });
});
