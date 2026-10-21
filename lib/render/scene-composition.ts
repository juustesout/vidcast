import type { Project } from '@/lib/types/render';
import type { RenderIssue } from '@/lib/types/render';
import type {
  SceneCompositionCanvas,
  SceneCompositionFit,
  SceneCompositionLayer,
  SceneCompositionLayerType,
  SceneCompositionMediaLayer,
  SceneCompositionOverlayLayer,
  SceneCompositionPipPresetName,
  SceneCompositionPresenterLayer,
  SceneCompositionPresenterMode,
  SceneCompositionPresetName,
  SceneCompositionRect,
  SceneCompositionSpec
} from '@/lib/types/scene-composition';
import { SCENE_COMPOSITION_SCHEMA_VERSION } from '@/lib/types/scene-composition';
import { STUDIO_PIP_PRESETS } from '@/lib/render/studio-compositions';

export const SCENE_COMPOSITION_LAYER_TYPES: SceneCompositionLayerType[] = ['background', 'image', 'presenter', 'overlay', 'foreground'];
export const SCENE_COMPOSITION_FITS: SceneCompositionFit[] = ['contain', 'cover'];
export const SCENE_COMPOSITION_PRESENTER_MODES: SceneCompositionPresenterMode[] = ['full_canvas', 'pip'];
export const SCENE_COMPOSITION_PIP_PRESETS: SceneCompositionPipPresetName[] = ['intro', 'news'];
export const SCENE_COMPOSITION_PRESETS: SceneCompositionPresetName[] = ['studio'];

export const STUDIO_COMPOSITION_CANVAS: SceneCompositionCanvas = { width: 1920, height: 1080 };

export const STUDIO_BIGSCREEN_RECT: SceneCompositionRect = {
  x: 293,
  y: 98,
  width: 1346,
  height: 761
};

export const STUDIO_LAYER_IDS = {
  background: 'studio-back',
  image: 'studio-screen',
  presenter: 'studio-presenter',
  overlay: 'studio-overlay',
  foreground: 'studio-desk'
} as const;

export const STUDIO_OVERLAY_RECT: SceneCompositionRect = {
  x: 1648,
  y: 200,
  width: 260,
  height: 390
};

const DEFAULT_Z_INDEX: Record<SceneCompositionLayerType, number> = {
  background: 0,
  image: 10,
  presenter: 20,
  overlay: 25,
  foreground: 30
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isSceneCompositionFit(value: unknown): value is SceneCompositionFit {
  return value === 'contain' || value === 'cover';
}

export function isSceneCompositionLayerType(value: unknown): value is SceneCompositionLayerType {
  return typeof value === 'string' && (SCENE_COMPOSITION_LAYER_TYPES as string[]).includes(value);
}

export function isSceneCompositionPresenterMode(value: unknown): value is SceneCompositionPresenterMode {
  return value === 'full_canvas' || value === 'pip';
}

export function isSceneCompositionPipPreset(value: unknown): value is SceneCompositionPipPresetName {
  return value === 'intro' || value === 'news';
}

export function isSceneCompositionPreset(value: unknown): value is SceneCompositionPresetName {
  return value === 'studio';
}

export const STUDIO_PRESENTER_PIP_SCALE = 0.5;
export const STUDIO_PRESENTER_PIP_OFFSET_X = 100;
export const STUDIO_PRESENTER_PIP_OFFSET_Y = 0;

export function resolveStudioPipRect(
  canvas: SceneCompositionCanvas,
  preset: SceneCompositionPipPresetName
): SceneCompositionRect {
  const pip = STUDIO_PIP_PRESETS[preset];
  const width = Math.round(canvas.width * pip.widthRatio);
  const height = Math.round(width * canvas.height / canvas.width);
  const margin = Math.round(canvas.width * pip.marginRatio);
  const x = pip.position.endsWith('right') ? canvas.width - width - margin : margin;
  const y = pip.position.startsWith('top') ? margin : canvas.height - height - margin;
  return { x, y, width, height };
}

export function resolveStudioPresenterRect(
  canvas: SceneCompositionCanvas,
  options: { scale?: number; offsetX?: number; offsetY?: number } = {}
): SceneCompositionRect {
  const scale = options.scale ?? STUDIO_PRESENTER_PIP_SCALE;
  const offsetX = options.offsetX ?? STUDIO_PRESENTER_PIP_OFFSET_X;
  const offsetY = options.offsetY ?? STUDIO_PRESENTER_PIP_OFFSET_Y;
  const width = Math.round(canvas.width * scale);
  const height = Math.round(canvas.height * scale);
  return {
    x: offsetX,
    y: canvas.height - height - offsetY,
    width,
    height
  };
}

function fullCanvasRect(canvas: SceneCompositionCanvas): SceneCompositionRect {
  return { x: 0, y: 0, width: canvas.width, height: canvas.height };
}

export function createStudioComposition(options: {
  canvas?: SceneCompositionCanvas;
  backgroundAssetId?: string;
  backgroundLocalPath?: string;
  imageAssetId?: string;
  imageLocalPath?: string;
  foregroundAssetId?: string;
  foregroundLocalPath?: string;
  presenterMode?: SceneCompositionPresenterMode;
  pipPreset?: SceneCompositionPipPresetName;
  presenterScale?: number;
  presenterOffsetX?: number;
  presenterOffsetY?: number;
  overlayAssetId?: string;
  overlayLocalPath?: string;
  overlayRect?: SceneCompositionRect;
  overlayStartSeconds?: number;
  overlayDurationSeconds?: number;
  overlayEnabled?: boolean;
  imageStartSeconds?: number;
  imageDurationSeconds?: number;
  deskEnabled?: boolean;
  bigscreenEnabled?: boolean;
} = {}): SceneCompositionSpec {
  const canvas = options.canvas ?? STUDIO_COMPOSITION_CANVAS;
  const presenterMode = options.presenterMode ?? 'pip';
  const pipPreset = options.pipPreset;
  const presenterScale = options.presenterScale ?? STUDIO_PRESENTER_PIP_SCALE;
  const presenterOffsetX = options.presenterOffsetX ?? STUDIO_PRESENTER_PIP_OFFSET_X;
  const presenterOffsetY = options.presenterOffsetY ?? STUDIO_PRESENTER_PIP_OFFSET_Y;
  const deskEnabled = options.deskEnabled ?? true;
  const bigscreenEnabled = options.bigscreenEnabled ?? true;

  const background: SceneCompositionMediaLayer = {
    id: STUDIO_LAYER_IDS.background,
    type: 'background',
    enabled: true,
    zIndex: DEFAULT_Z_INDEX.background,
    assetId: options.backgroundAssetId,
    localPath: options.backgroundLocalPath ?? 'assets/studio/studio_back.png',
    rect: fullCanvasRect(canvas),
    fit: 'cover'
  };

  const image: SceneCompositionMediaLayer = {
    id: STUDIO_LAYER_IDS.image,
    type: 'image',
    enabled: bigscreenEnabled,
    zIndex: DEFAULT_Z_INDEX.image,
    assetId: options.imageAssetId,
    localPath: options.imageLocalPath,
    rect: { ...STUDIO_BIGSCREEN_RECT },
    fit: 'contain',
    ...(options.imageStartSeconds !== undefined ? { startSeconds: options.imageStartSeconds } : {}),
    ...(options.imageDurationSeconds !== undefined ? { durationSeconds: options.imageDurationSeconds } : {})
  };

  const presenter: SceneCompositionPresenterLayer = presenterMode === 'pip'
    ? pipPreset
      ? {
          id: STUDIO_LAYER_IDS.presenter,
          type: 'presenter',
          enabled: true,
          zIndex: DEFAULT_Z_INDEX.presenter,
          mode: 'pip',
          pipPreset,
          rect: resolveStudioPipRect(canvas, pipPreset),
          fit: 'contain'
        }
      : {
          id: STUDIO_LAYER_IDS.presenter,
          type: 'presenter',
          enabled: true,
          zIndex: DEFAULT_Z_INDEX.presenter,
          mode: 'pip',
          scale: presenterScale,
          offsetX: presenterOffsetX,
          offsetY: presenterOffsetY,
          rect: resolveStudioPresenterRect(canvas, {
            scale: presenterScale,
            offsetX: presenterOffsetX,
            offsetY: presenterOffsetY
          }),
          fit: 'contain'
        }
    : {
        id: STUDIO_LAYER_IDS.presenter,
        type: 'presenter',
        enabled: true,
        zIndex: DEFAULT_Z_INDEX.presenter,
        mode: 'full_canvas',
        rect: fullCanvasRect(canvas),
        fit: 'contain'
      };

  const overlay: SceneCompositionOverlayLayer = {
    id: STUDIO_LAYER_IDS.overlay,
    type: 'overlay',
    enabled: options.overlayEnabled ?? Boolean(options.overlayAssetId || options.overlayLocalPath),
    zIndex: DEFAULT_Z_INDEX.overlay,
    assetId: options.overlayAssetId,
    localPath: options.overlayLocalPath,
    rect: options.overlayRect ?? { ...STUDIO_OVERLAY_RECT },
    fit: 'contain',
    ...(options.overlayStartSeconds !== undefined ? { startSeconds: options.overlayStartSeconds } : {}),
    ...(options.overlayDurationSeconds !== undefined ? { durationSeconds: options.overlayDurationSeconds } : {})
  };

  const foreground: SceneCompositionMediaLayer = {
    id: STUDIO_LAYER_IDS.foreground,
    type: 'foreground',
    enabled: deskEnabled,
    zIndex: DEFAULT_Z_INDEX.foreground,
    assetId: options.foregroundAssetId,
    localPath: options.foregroundLocalPath ?? 'assets/studio/studio_desk.png',
    rect: fullCanvasRect(canvas),
    fit: 'cover'
  };

  return {
    version: SCENE_COMPOSITION_SCHEMA_VERSION,
    preset: 'studio',
    canvas,
    layers: overlay.enabled ? [background, image, presenter, overlay, foreground] : [background, image, presenter, foreground]
  };
}

function normalizeRect(value: unknown): SceneCompositionRect | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const { x, y, width, height } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    return undefined;
  }
  return { x, y, width, height };
}

function normalizeCanvas(value: unknown, fallback?: SceneCompositionCanvas): SceneCompositionCanvas | undefined {
  if (!isPlainObject(value)) {
    return fallback;
  }
  const { width, height } = value;
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    return fallback;
  }
  return { width, height };
}

function normalizeMediaLayer(
  value: Record<string, unknown>,
  type: SceneCompositionMediaLayer['type'],
  index: number
): SceneCompositionMediaLayer {
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `${type}-${index + 1}`;
  const assetId = typeof value.assetId === 'string' && value.assetId.trim() ? value.assetId.trim() : undefined;
  const localPath = typeof value.localPath === 'string' && value.localPath.trim() ? value.localPath.trim() : undefined;
  const startSeconds = normalizeNonNegativeNumber(value.startSeconds);
  const durationSeconds = normalizePositiveNumber(value.durationSeconds);
  return {
    id,
    type,
    enabled: value.enabled !== false,
    zIndex: isFiniteNumber(value.zIndex) ? value.zIndex : DEFAULT_Z_INDEX[type],
    assetId,
    localPath,
    rect: normalizeRect(value.rect) ?? { x: 0, y: 0, width: 0, height: 0 },
    fit: isSceneCompositionFit(value.fit) ? value.fit : type === 'image' ? 'contain' : 'cover',
    ...(startSeconds !== undefined ? { startSeconds } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {})
  };
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) && value > 0 ? value : undefined;
}

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) && value >= 0 ? value : undefined;
}

function normalizeOverlayLayer(value: Record<string, unknown>, index: number): SceneCompositionOverlayLayer {
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `overlay-${index + 1}`;
  const assetId = typeof value.assetId === 'string' && value.assetId.trim() ? value.assetId.trim() : undefined;
  const localPath = typeof value.localPath === 'string' && value.localPath.trim() ? value.localPath.trim() : undefined;
  const startSeconds = normalizeNonNegativeNumber(value.startSeconds);
  const durationSeconds = normalizePositiveNumber(value.durationSeconds);
  return {
    id,
    type: 'overlay',
    enabled: value.enabled !== false,
    zIndex: isFiniteNumber(value.zIndex) ? value.zIndex : DEFAULT_Z_INDEX.overlay,
    assetId,
    localPath,
    rect: normalizeRect(value.rect) ?? { ...STUDIO_OVERLAY_RECT },
    fit: isSceneCompositionFit(value.fit) ? value.fit : 'contain',
    ...(startSeconds !== undefined ? { startSeconds } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {})
  };
}

function normalizePresenterLayer(value: Record<string, unknown>, index: number, canvas?: SceneCompositionCanvas): SceneCompositionPresenterLayer {
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `presenter-${index + 1}`;
  const mode = isSceneCompositionPresenterMode(value.mode) ? value.mode : 'full_canvas';
  const pipPreset = isSceneCompositionPipPreset(value.pipPreset) ? value.pipPreset : undefined;
  const scale = normalizePositiveNumber(value.scale);
  const offsetX = normalizeNonNegativeNumber(value.offsetX);
  const offsetY = normalizeNonNegativeNumber(value.offsetY);
  const explicitRect = normalizeRect(value.rect);
  const resolvedCanvas = canvas ?? STUDIO_COMPOSITION_CANVAS;
  const rect = explicitRect
    ?? (mode === 'pip' && pipPreset ? resolveStudioPipRect(resolvedCanvas, pipPreset)
      : mode === 'pip' ? resolveStudioPresenterRect(resolvedCanvas, { scale, offsetX, offsetY })
      : mode === 'full_canvas' ? fullCanvasRect(resolvedCanvas) : undefined);

  return {
    id,
    type: 'presenter',
    enabled: value.enabled !== false,
    zIndex: isFiniteNumber(value.zIndex) ? value.zIndex : DEFAULT_Z_INDEX.presenter,
    mode,
    pipPreset,
    ...(scale !== undefined ? { scale } : {}),
    ...(offsetX !== undefined ? { offsetX } : {}),
    ...(offsetY !== undefined ? { offsetY } : {}),
    rect,
    fit: isSceneCompositionFit(value.fit) ? value.fit : 'contain'
  };
}

export function sortCompositionLayers<T extends { id: string; zIndex: number }>(layers: T[]): T[] {
  return layers.slice().sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));
}

export function normalizeSceneComposition(value: unknown): SceneCompositionSpec | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }

  const preset = isSceneCompositionPreset(value.preset) ? value.preset : undefined;
  const canvas = normalizeCanvas(value.canvas, preset === 'studio' ? STUDIO_COMPOSITION_CANVAS : undefined);
  const rawLayers = Array.isArray(value.layers) ? value.layers : [];

  const layers: SceneCompositionLayer[] = [];
  rawLayers.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      return;
    }
    if (raw.type === 'presenter') {
      layers.push(normalizePresenterLayer(raw, index, canvas));
      return;
    }
    if (raw.type === 'overlay') {
      layers.push(normalizeOverlayLayer(raw, index));
      return;
    }
    if (raw.type === 'background' || raw.type === 'image' || raw.type === 'foreground') {
      layers.push(normalizeMediaLayer(raw, raw.type, index));
      return;
    }
    layers.push({
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `layer-${index + 1}`,
      type: raw.type as SceneCompositionMediaLayer['type'],
      enabled: raw.enabled !== false,
      zIndex: isFiniteNumber(raw.zIndex) ? raw.zIndex : index,
      rect: normalizeRect(raw.rect) ?? { x: 0, y: 0, width: 1, height: 1 },
      fit: isSceneCompositionFit(raw.fit) ? raw.fit : 'contain'
    });
  });

  const version = isFiniteNumber(value.version) ? value.version as SceneCompositionSpec['version'] : SCENE_COMPOSITION_SCHEMA_VERSION;

  return {
    version,
    preset,
    canvas,
    layers
  };
}

function pushIssue(
  target: RenderIssue[],
  severity: RenderIssue['severity'],
  code: string,
  path: string,
  message: string
): void {
  target.push({ severity, code, path, message });
}

export function isSafeAssetPath(localPath: string): boolean {
  return localPath.startsWith('assets/') && !localPath.includes('..') && !localPath.includes('\\') && !localPath.startsWith('/');
}

export function sceneBakesPresenter(composition: SceneCompositionSpec | undefined): boolean {
  return Boolean(composition?.layers.some((layer) => layer.type === 'presenter' && layer.enabled !== false));
}

function validateRect(rect: unknown, canvas: SceneCompositionCanvas | undefined, path: string, errors: RenderIssue[]): void {
  if (!isPlainObject(rect)) {
    pushIssue(errors, 'error', 'scene.composition.rect.invalid', path, 'Layer rect must be an object with x, y, width, and height.');
    return;
  }
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    if (!isFiniteNumber(rect[field])) {
      pushIssue(errors, 'error', 'scene.composition.rect.invalid', `${path}.${field}`, `Layer rect.${field} must be a finite number.`);
    }
  }
  if (isFiniteNumber(rect.width) && rect.width <= 0) {
    pushIssue(errors, 'error', 'scene.composition.rect.invalid', `${path}.width`, 'Layer width must be greater than zero.');
  }
  if (isFiniteNumber(rect.height) && rect.height <= 0) {
    pushIssue(errors, 'error', 'scene.composition.rect.invalid', `${path}.height`, 'Layer height must be greater than zero.');
  }
  if (!canvas || !isFiniteNumber(rect.x) || !isFiniteNumber(rect.y) || !isFiniteNumber(rect.width) || !isFiniteNumber(rect.height)) {
    return;
  }
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > canvas.width || rect.y + rect.height > canvas.height) {
    pushIssue(errors, 'error', 'scene.composition.rect.bounds', path, 'Layer rect must stay inside the composition canvas.');
  }
}

export function validateSceneComposition(
  composition: unknown,
  path: string,
  project: Project,
  errors: RenderIssue[],
  warnings: RenderIssue[]
): void {
  if (composition === undefined) {
    return;
  }
  if (!isPlainObject(composition)) {
    pushIssue(errors, 'error', 'scene.composition.invalid', path, 'Scene composition must be an object.');
    return;
  }

  if (composition.version !== SCENE_COMPOSITION_SCHEMA_VERSION) {
    pushIssue(errors, 'error', 'scene.composition.version.invalid', `${path}.version`, `Composition schema version must be ${SCENE_COMPOSITION_SCHEMA_VERSION}.`);
  }

  if (composition.preset !== undefined && composition.preset !== null && !isSceneCompositionPreset(composition.preset)) {
    pushIssue(errors, 'error', 'scene.composition.preset.invalid', `${path}.preset`, 'Composition preset is not supported.');
  }

  let canvas: SceneCompositionCanvas | undefined;
  if (composition.canvas !== undefined && composition.canvas !== null) {
    if (!isPlainObject(composition.canvas)) {
      pushIssue(errors, 'error', 'scene.composition.canvas.invalid', `${path}.canvas`, 'Composition canvas must be an object.');
    } else {
      const { width, height } = composition.canvas;
      if (!isFiniteNumber(width) || width <= 0 || !isFiniteNumber(height) || height <= 0) {
        pushIssue(errors, 'error', 'scene.composition.canvas.invalid', `${path}.canvas`, 'Composition canvas width and height must be finite and greater than zero.');
      } else {
        canvas = { width, height };
      }
    }
  }

  if (!Array.isArray(composition.layers)) {
    pushIssue(errors, 'error', 'scene.composition.layers.invalid', `${path}.layers`, 'Composition layers must be an array.');
    return;
  }

  const seenIds = new Set<string>();
  const zIndexes = new Set<number>();

  composition.layers.forEach((raw, index) => {
    const layerPath = `${path}.layers.${index}`;
    if (!isPlainObject(raw)) {
      pushIssue(errors, 'error', 'scene.composition.layer.invalid', layerPath, 'Each composition layer must be an object.');
      return;
    }

    if (typeof raw.id !== 'string' || !raw.id.trim()) {
      pushIssue(errors, 'error', 'scene.composition.layer.id.invalid', `${layerPath}.id`, 'Each composition layer requires a stable id.');
    } else if (seenIds.has(raw.id.trim())) {
      pushIssue(errors, 'error', 'scene.composition.layer.id.duplicate', `${layerPath}.id`, `Duplicate composition layer id ${raw.id}.`);
    } else {
      seenIds.add(raw.id.trim());
    }

    if (!isSceneCompositionLayerType(raw.type)) {
      pushIssue(errors, 'error', 'scene.composition.layer.type.invalid', `${layerPath}.type`, 'Composition layer type is not supported.');
    }

    if (raw.enabled !== undefined && raw.enabled !== null && typeof raw.enabled !== 'boolean') {
      pushIssue(errors, 'error', 'scene.composition.layer.enabled.invalid', `${layerPath}.enabled`, 'Composition layer enabled must be a boolean.');
    }

    if (!isFiniteNumber(raw.zIndex) || !Number.isInteger(raw.zIndex)) {
      pushIssue(errors, 'error', 'scene.composition.layer.zIndex.invalid', `${layerPath}.zIndex`, 'Composition layer zIndex must be an integer.');
    } else if (zIndexes.has(raw.zIndex)) {
      pushIssue(errors, 'error', 'scene.composition.layer.zIndex.duplicate', `${layerPath}.zIndex`, `Duplicate composition zIndex ${raw.zIndex}.`);
    } else {
      zIndexes.add(raw.zIndex);
    }

    if (raw.type === 'presenter') {
      if (!isSceneCompositionPresenterMode(raw.mode)) {
        pushIssue(errors, 'error', 'scene.composition.presenter.mode.invalid', `${layerPath}.mode`, 'Presenter mode must be full_canvas or pip.');
      }
      if (raw.pipPreset !== undefined && raw.pipPreset !== null && !isSceneCompositionPipPreset(raw.pipPreset)) {
        pushIssue(errors, 'error', 'scene.composition.presenter.pipPreset.invalid', `${layerPath}.pipPreset`, 'Presenter PiP preset must be intro or news.');
      }
      if (raw.mode === 'pip' && raw.rect === undefined && raw.pipPreset === undefined && !isFiniteNumber(raw.scale)) {
        pushIssue(errors, 'error', 'scene.composition.presenter.pip.missing', layerPath, 'PiP presenter requires an explicit rect, scale, or a named pipPreset.');
      }
      if (raw.scale !== undefined && raw.scale !== null && (!isFiniteNumber(raw.scale) || raw.scale <= 0 || raw.scale > 1)) {
        pushIssue(errors, 'error', 'scene.composition.presenter.scale.invalid', `${layerPath}.scale`, 'Presenter scale must be a finite number greater than 0 and at most 1.');
      }
      if (raw.offsetX !== undefined && raw.offsetX !== null && (!isFiniteNumber(raw.offsetX) || raw.offsetX < 0)) {
        pushIssue(errors, 'error', 'scene.composition.presenter.offset.invalid', `${layerPath}.offsetX`, 'Presenter offsetX must be a finite number greater than or equal to 0.');
      }
      if (raw.offsetY !== undefined && raw.offsetY !== null && (!isFiniteNumber(raw.offsetY) || raw.offsetY < 0)) {
        pushIssue(errors, 'error', 'scene.composition.presenter.offset.invalid', `${layerPath}.offsetY`, 'Presenter offsetY must be a finite number greater than or equal to 0.');
      }
      if (raw.rect !== undefined && raw.rect !== null) {
        validateRect(raw.rect, canvas, `${layerPath}.rect`, errors);
      }
      if (raw.fit !== undefined && raw.fit !== null && !isSceneCompositionFit(raw.fit)) {
        pushIssue(errors, 'error', 'scene.composition.fit.invalid', `${layerPath}.fit`, 'Layer fit must be contain or cover.');
      }
      return;
    }

    if (raw.type === 'background' || raw.type === 'image' || raw.type === 'foreground' || raw.type === 'overlay') {
      if (raw.rect === undefined) {
        pushIssue(errors, 'error', 'scene.composition.rect.invalid', `${layerPath}.rect`, 'Media layers require an explicit rect.');
      } else {
        validateRect(raw.rect, canvas, `${layerPath}.rect`, errors);
      }
      if (raw.fit !== undefined && raw.fit !== null && !isSceneCompositionFit(raw.fit)) {
        pushIssue(errors, 'error', 'scene.composition.fit.invalid', `${layerPath}.fit`, 'Layer fit must be contain or cover.');
      }

      if (raw.type === 'overlay' || raw.type === 'image') {
        const startCode = raw.type === 'overlay' ? 'scene.composition.overlay.start.invalid' : 'scene.composition.image.start.invalid';
        const durationCode = raw.type === 'overlay' ? 'scene.composition.overlay.duration.invalid' : 'scene.composition.image.duration.invalid';
        if (raw.startSeconds !== undefined && raw.startSeconds !== null && (!isFiniteNumber(raw.startSeconds) || raw.startSeconds < 0)) {
          pushIssue(errors, 'error', startCode, `${layerPath}.startSeconds`, `${raw.type === 'overlay' ? 'Overlay' : 'Image'} startSeconds must be a finite number greater than or equal to 0.`);
        }
        if (raw.durationSeconds !== undefined && raw.durationSeconds !== null && (!isFiniteNumber(raw.durationSeconds) || raw.durationSeconds <= 0)) {
          pushIssue(errors, 'error', durationCode, `${layerPath}.durationSeconds`, `${raw.type === 'overlay' ? 'Overlay' : 'Image'} durationSeconds must be a finite number greater than 0.`);
        }
      }

      const localPath = typeof raw.localPath === 'string' ? raw.localPath.trim() : '';
      if (localPath) {
        if (!isSafeAssetPath(localPath)) {
          pushIssue(errors, 'error', 'scene.composition.asset.path.unsafe', `${layerPath}.localPath`, 'Composition asset path must be project-relative under assets/.');
        }
      }

      const assetId = typeof raw.assetId === 'string' ? raw.assetId.trim() : '';
      if (assetId) {
        const asset = project.assets.find((entry) => entry.id === assetId);
        if (!asset) {
          pushIssue(errors, 'error', 'scene.composition.asset.missing', `${layerPath}.assetId`, `Composition asset ${assetId} does not exist.`);
        } else if (asset.type !== 'image' && asset.type !== 'graphic' && asset.type !== 'video') {
          pushIssue(errors, 'error', 'scene.composition.asset.invalidType', `${layerPath}.assetId`, `Composition asset ${assetId} is not a visual asset.`);
        } else if (asset.localPath && !isSafeAssetPath(asset.localPath)) {
          pushIssue(errors, 'error', 'scene.composition.asset.path.unsafe', `${layerPath}.assetId`, 'Composition asset localPath must be project-relative under assets/.');
        }
      } else if (!localPath && raw.enabled !== false) {
        pushIssue(warnings, 'warning', 'scene.composition.asset.missing', layerPath, 'Enabled media layer has no assetId or localPath.');
      }
    }
  });
}
