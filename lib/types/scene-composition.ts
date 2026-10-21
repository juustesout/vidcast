export const SCENE_COMPOSITION_SCHEMA_VERSION = 1;

export type SceneCompositionSchemaVersion = typeof SCENE_COMPOSITION_SCHEMA_VERSION;

export type SceneCompositionLayerType = 'background' | 'image' | 'presenter' | 'overlay' | 'foreground';

export type SceneCompositionFit = 'contain' | 'cover';

export type SceneCompositionPresenterMode = 'full_canvas' | 'pip';

export type SceneCompositionPipPresetName = 'intro' | 'news';

export type SceneCompositionPresetName = 'studio';

export interface SceneCompositionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneCompositionCanvas {
  width: number;
  height: number;
}

export interface SceneCompositionLayerBase {
  id: string;
  type: SceneCompositionLayerType;
  enabled: boolean;
  zIndex: number;
}

export interface SceneCompositionMediaLayer extends SceneCompositionLayerBase {
  type: 'background' | 'image' | 'foreground';
  assetId?: string;
  localPath?: string;
  rect: SceneCompositionRect;
  fit: SceneCompositionFit;
  startSeconds?: number;
  durationSeconds?: number;
}

export interface SceneCompositionPresenterLayer extends SceneCompositionLayerBase {
  type: 'presenter';
  mode: SceneCompositionPresenterMode;
  pipPreset?: SceneCompositionPipPresetName;
  scale?: number;
  offsetX?: number;
  offsetY?: number;
  rect?: SceneCompositionRect;
  fit?: SceneCompositionFit;
}

export interface SceneCompositionOverlayLayer extends SceneCompositionLayerBase {
  type: 'overlay';
  assetId?: string;
  localPath?: string;
  rect: SceneCompositionRect;
  fit: SceneCompositionFit;
  startSeconds?: number;
  durationSeconds?: number;
}

export type SceneCompositionLayer =
  | SceneCompositionMediaLayer
  | SceneCompositionPresenterLayer
  | SceneCompositionOverlayLayer;

export interface SceneCompositionSpec {
  version: SceneCompositionSchemaVersion;
  preset?: SceneCompositionPresetName;
  canvas?: SceneCompositionCanvas;
  layers: SceneCompositionLayer[];
}
