import { resolveStockProviderOrder, STOCK_PROVIDER_IDS } from '@/lib/ai/stock/catalog';
import {
  createStockProviderRegistry,
  type StockProviderRegistry
} from '@/lib/ai/stock/registry';
import { resolveStockQuotaReserve, FileStockStateStore, type StockStateStore } from '@/lib/ai/stock/stock-state-store';
import { StockProviderError } from '@/lib/ai/stock/stock-provider';
import { StockRouter, StockRoutingError, type StockRouterDiagnostic } from '@/lib/ai/stock/stock-router';
import { resolveRunPolicyServerConfig } from '@/lib/production/run-policy';
import type { RunMode } from '@/lib/production/run-types';
import { mediaStore } from '@/lib/storage/media-store';
import { projectStore, type ProjectStore } from '@/lib/storage/project-store';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';
import type { StockAttribution, StockOrientation, StockPhoto, StockProviderId, StockSelection, StockUsagePolicy } from '@/lib/types/stock';
import { stockSelectionKey } from '@/lib/types/stock';

const activeSelectionLocks = new Set<string>();

export class StockImageSelectionError extends Error {
  readonly status: number;
  readonly code: string;
  readonly diagnostics?: StockRouterDiagnostic[];

  constructor(message: string, status: number, code: string, diagnostics?: StockRouterDiagnostic[]) {
    super(message);
    this.name = 'StockImageSelectionError';
    this.status = status;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface StockSelectionExecutionResult {
  sceneId: string;
  status: 'selected' | 'current';
  provider: StockProviderId;
  photoId: string;
  usagePolicy: StockUsagePolicy;
  assetId?: string;
  cached: boolean;
  attribution: StockAttribution;
}

export interface StockSelectionRequest {
  regenerate?: boolean;
  mode?: RunMode;
}

interface StockSelectionDependencies {
  store: Pick<ProjectStore, 'getProject' | 'mutateProject'>;
  media: Pick<typeof mediaStore, 'saveStockImage'>;
  registry: StockProviderRegistry;
  stateStore: StockStateStore;
  now: () => number;
}

let defaultStateStore: StockStateStore | undefined;

function getDefaultStateStore(): StockStateStore {
  defaultStateStore ??= new FileStockStateStore();
  return defaultStateStore;
}

const defaultDependencies: StockSelectionDependencies = {
  store: projectStore,
  media: mediaStore,
  registry: createStockProviderRegistry(),
  get stateStore() {
    return getDefaultStateStore();
  },
  now: () => Date.now()
};

export interface StockModeResolution {
  mode: RunMode;
  allowedProviders: StockProviderId[];
  order: StockProviderId[];
}

// Resolves which stock providers a single selection call may contact. Mock mode
// is locked to the local `fake` provider so a stock request can never silently
// trigger a real (paid/quota-consuming) provider call.
export function resolveStockMode(
  options: { mode?: RunMode } = {},
  env: NodeJS.ProcessEnv = process.env
): StockModeResolution {
  const serverConfig = resolveRunPolicyServerConfig();
  const mode = options.mode ?? serverConfig.defaultMode;

  if (mode === 'real' && !serverConfig.allowRealProviders) {
    throw new StockImageSelectionError('Real provider mode is disabled on this server.', 403, 'stock.policy.denied');
  }

  const order = resolveStockProviderOrder(env.STOCK_IMAGE_PROVIDER_ORDER);

  if (mode === 'mock') {
    // The local fake provider is not part of the real catalog order, so it must
    // be prepended explicitly; otherwise a mock run would find no provider and
    // fail closed with NO_PROVIDER_AVAILABLE.
    return { mode, allowedProviders: ['fake'], order: ['fake', ...order] };
  }

  return { mode, allowedProviders: STOCK_PROVIDER_IDS, order };
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function getScene(project: Project, sceneId: string): Scene {
  const scene = project.scenes.find((entry) => entry.id === sceneId);
  if (!scene) {
    throw new StockImageSelectionError(`Scene ${sceneId} not found.`, 404, 'stock.scene.notFound');
  }
  return scene;
}

function ensureStockScene(scene: Scene): asserts scene is Scene & { visual: Extract<NonNullable<Scene['visual']>, { kind: 'stock_image' }> } {
  if (!scene.visual || scene.visual.kind !== 'stock_image') {
    throw new StockImageSelectionError('Scene is not a stock image scene.', 400, 'stock.scene.invalidVisualKind');
  }
}

function updateScene(project: Project, sceneId: string, updater: (scene: Scene) => Scene): Project {
  return {
    ...project,
    scenes: project.scenes.map((scene) => (scene.id === sceneId ? updater(scene) : scene))
  };
}

function findUsableAsset(project: Project, assetId?: string): Asset | undefined {
  if (!assetId) {
    return undefined;
  }
  const asset = project.assets.find((entry) => entry.id === assetId);
  return asset && asset.status === 'available' ? asset : undefined;
}

function isSelectionCurrent(project: Project, selection: StockSelection | undefined, assetId: string | undefined): boolean {
  if (!selection) {
    return false;
  }
  if (selection.usagePolicy === 'hotlink') {
    // Hotlinked selections are referenced by URL at render time; no asset needed.
    return true;
  }
  return Boolean(findUsableAsset(project, assetId));
}

// A persisted selection is reusable when its provider is valid for the current
// mode. Mock mode may reuse any existing selection because doing so never
// contacts a provider; real mode must never treat a fake selection as current.
function isSelectionUsableInMode(
  provider: StockProviderId,
  mode: RunMode,
  allowedProviders: StockProviderId[]
): boolean {
  if (mode === 'mock') {
    return true;
  }
  return allowedProviders.includes(provider);
}

export async function selectSceneStockImage(
  projectId: string,
  sceneId: string,
  options: StockSelectionRequest = {},
  dependencies: StockSelectionDependencies = defaultDependencies
): Promise<StockSelectionExecutionResult> {
  const lockKey = `${projectId}:${sceneId}`;
  if (activeSelectionLocks.has(lockKey)) {
    throw new StockImageSelectionError('Stock selection is already running for this scene.', 409, 'stock.scene.alreadyRunning');
  }
  activeSelectionLocks.add(lockKey);

  try {
    const project = await dependencies.store.getProject(projectId);
    if (!project) {
      throw new StockImageSelectionError(`Project ${projectId} not found.`, 404, 'stock.project.notFound');
    }

    const scene = getScene(project, sceneId);
    ensureStockScene(scene);

    const { mode, allowedProviders, order } = resolveStockMode({ mode: options.mode });

    const existing = scene.visual.selection;
    const existingUsable = existing ? isSelectionUsableInMode(existing.provider, mode, allowedProviders) : false;

    // Never silently replace an author-chosen selection that is invalid for the
    // current mode. The caller must choose a compatible photo or change modes.
    if (existing && !existingUsable && existing.origin === 'manual') {
      throw new StockImageSelectionError(
        `The saved manual stock selection uses ${existing.provider}, which is not available in ${mode} mode. Choose a real stock photo or change the run mode.`,
        409,
        'stock.selection.incompatible'
      );
    }

    if (!options.regenerate && existingUsable && isSelectionCurrent(project, existing, scene.visual.assetId)) {
      return {
        sceneId,
        status: 'current',
        provider: existing!.provider,
        photoId: existing!.photoId,
        usagePolicy: existing!.usagePolicy,
        assetId: scene.visual.assetId,
        cached: true,
        attribution: existing!.attribution
      };
    }

    if (!scene.visual.query.trim()) {
      throw new StockImageSelectionError('Stock search query is required.', 400, 'stock.scene.missingQuery');
    }

    const router = new StockRouter({
      store: dependencies.stateStore,
      getProvider: (id) => dependencies.registry.getProvider(id),
      order,
      allowedProviders,
      reserve: resolveStockQuotaReserve(),
      now: dependencies.now
    });

    let routed;
    try {
      routed = await router.resolve({
        query: scene.visual.query,
        orientation: scene.visual.orientation,
        preferredProviders: scene.visual.preferredProviders
      });
    } catch (error) {
      if (error instanceof StockRoutingError) {
        throw new StockImageSelectionError(error.message, error.status, 'stock.routing.failed', error.diagnostics);
      }
      throw error;
    }

    const { selection } = routed;
    if (!allowedProviders.includes(selection.provider)) {
      throw new StockImageSelectionError(
        `Stock provider ${selection.provider} is not available in ${mode} mode.`,
        403,
        'stock.provider.notAllowed',
        routed.diagnostics
      );
    }

    return await persistSceneSelection(
      dependencies,
      projectId,
      sceneId,
      scene,
      { ...selection, origin: 'auto' },
      routed.cached
    );
  } finally {
    activeSelectionLocks.delete(lockKey);
  }
}

// Applies an explicitly chosen search candidate to a scene. The caller must
// have resolved `photo` from the server-side search cache; a client never
// supplies an arbitrary image URL. This is the manual (`origin: 'manual'`) path
// and is pinned against forced regeneration in planning.
export async function selectSceneStockPhoto(
  projectId: string,
  sceneId: string,
  photo: StockPhoto,
  options: { query: string; orientation?: StockOrientation; regenerate?: boolean; mode?: RunMode } ,
  dependencies: StockSelectionDependencies = defaultDependencies
): Promise<StockSelectionExecutionResult> {
  const lockKey = `${projectId}:${sceneId}`;
  if (activeSelectionLocks.has(lockKey)) {
    throw new StockImageSelectionError('Stock selection is already running for this scene.', 409, 'stock.scene.alreadyRunning');
  }
  activeSelectionLocks.add(lockKey);

  try {
    const project = await dependencies.store.getProject(projectId);
    if (!project) {
      throw new StockImageSelectionError(`Project ${projectId} not found.`, 404, 'stock.project.notFound');
    }

    const scene = getScene(project, sceneId);
    ensureStockScene(scene);

    const { allowedProviders } = resolveStockMode({ mode: options.mode });

    if (!photo || !photo.provider || !photo.photoId || !photo.imageUrl) {
      throw new StockImageSelectionError('Invalid stock photo selection.', 400, 'stock.photo.invalid');
    }
    if (!allowedProviders.includes(photo.provider)) {
      throw new StockImageSelectionError(`Stock provider ${photo.provider} is not available in this mode.`, 403, 'stock.provider.notAllowed');
    }

    const existing = scene.visual.selection;
    if (!options.regenerate && isSelectionCurrent(project, existing, scene.visual.assetId) && existing?.provider === photo.provider && existing?.photoId === photo.photoId) {
      return {
        sceneId,
        status: 'current',
        provider: existing.provider,
        photoId: existing.photoId,
        usagePolicy: existing.usagePolicy,
        assetId: scene.visual.assetId,
        cached: true,
        attribution: existing.attribution
      };
    }

    const query = (options.query ?? '').trim() || scene.visual.query.trim();
    if (!query) {
      throw new StockImageSelectionError('Stock search query is required.', 400, 'stock.scene.missingQuery');
    }

    const orientation = options.orientation ?? scene.visual.orientation;
    const selection: StockSelection = {
      provider: photo.provider,
      photoId: photo.photoId,
      query,
      orientation,
      usagePolicy: photo.usagePolicy,
      attribution: photo.attribution,
      sourceUrl: photo.sourceUrl,
      imageUrl: photo.imageUrl,
      downloadUrl: photo.downloadUrl,
      downloadTrackingUrl: photo.downloadTrackingUrl,
      width: photo.width,
      height: photo.height,
      selectedAt: nowIso(dependencies.now),
      selectionKey: stockSelectionKey(query, orientation),
      origin: 'manual'
    };

    return await persistSceneSelection(dependencies, projectId, sceneId, scene, selection, false);
  } finally {
    activeSelectionLocks.delete(lockKey);
  }
}

async function persistSceneSelection(
  dependencies: StockSelectionDependencies,
  projectId: string,
  sceneId: string,
  scene: Scene,
  selection: StockSelection,
  cached: boolean
): Promise<StockSelectionExecutionResult> {
  let asset: Asset | undefined;

  if (selection.usagePolicy === 'download') {
    const provider = dependencies.registry.getProvider(selection.provider);
    try {
      const bytes = await provider.fetchPhoto(selection);
      asset = await dependencies.media.saveStockImage({
        projectId,
        sceneOrder: scene.order,
        selection,
        mimeType: bytes.mimeType,
        data: bytes.data
      });
    } catch (error) {
      const message = error instanceof StockProviderError ? error.message : 'Stock image download failed.';
      throw new StockImageSelectionError(message, error instanceof StockProviderError ? error.status : 502, 'stock.download.failed');
    }
  }

  const persistedSelection: StockSelection = { ...selection, selectedAt: nowIso(dependencies.now) };

  await dependencies.store.mutateProject(projectId, (fresh) => {
    const next = updateScene(fresh, sceneId, (entry) => {
      ensureStockScene(entry);
      return {
        ...entry,
        visual: {
          ...entry.visual,
          selection: persistedSelection,
          assetId: asset?.id
        }
      };
    });
    return asset ? { ...next, assets: [...next.assets, asset] } : next;
  });

  return {
    sceneId,
    status: 'selected',
    provider: selection.provider,
    photoId: selection.photoId,
    usagePolicy: selection.usagePolicy,
    assetId: asset?.id,
    cached,
    attribution: selection.attribution
  };
}

// Exposed for tests to inject an isolated, in-memory state store.
export function buildStockSelectionDependencies(overrides: Partial<StockSelectionDependencies>): StockSelectionDependencies {
  return { ...defaultDependencies, ...overrides };
}
