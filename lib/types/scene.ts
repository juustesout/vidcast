import type { GenerationAttempt, GenerationRecord } from './generation';
import type { SceneCompositionSpec } from './scene-composition';
import type { StockOrientation, StockProviderId, StockSelection } from './stock';

export type SceneType = 'image' | 'video' | 'graphic' | 'text' | 'blank';

export type MotionPreset =
  | 'none'
  | 'zoom_in'
  | 'zoom_out'
  | 'pan_left'
  | 'pan_right'
  | 'pan_up'
  | 'pan_down'
  | 'zoom_left'
  | 'zoom_right';

export type TransitionPreset = 'none' | 'fade' | 'crossfade';

export type OverlayType = 'none' | 'text' | 'title' | 'subtitle' | 'callout' | 'statistic' | 'quote';

export type OverlayPosition = 'top' | 'center' | 'bottom';

export type LogoOverlayPosition = 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';

// Optional per-scene image layer rendered above the scene source (including
// stock photos and graphic cards). The asset is referenced by project asset id;
// no file bytes are embedded in the project document. `null` on a Scene means
// "explicitly no logo" and takes precedence over a project-level default.
export interface LogoOverlaySpec {
  assetId: string;
  // Defaults to bottom_right.
  position?: LogoOverlayPosition;
  // Target width as a fraction of the canvas width. Defaults to 0.15.
  scale?: number;
  // Optional pixel cap applied after `scale`, useful for very wide logos.
  maxWidth?: number;
  // Inset from the selected corner, in canvas pixels.
  margin?: number;
  // 0..1; defaults to 1. Fully transparent logos are skipped.
  opacity?: number;
}

export interface GraphicStyleSpec {
  // Optional per-template palette. Omitted fields keep the historical colors.
  background?: string;
  textColor?: string;
  accentColor?: string;
  statisticLabelColor?: string;
}

// Normalized (0..1) screen rectangle inside the studio set. The scene source is
// visible only through this cutout; the studio frame covers the rest.
export interface StudioScreenSpec {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  // Corner radius in pixels at the rendered canvas size.
  radius?: number;
}

// Optional reusable studio set. Presence enables the layer for every scene in
// the project; absent keeps the historical full-frame scene rendering.
export interface StudioOverlaySpec {
  brand?: string;
  program?: string;
  screen?: StudioScreenSpec;
  // Hex accent color for the lower-third stripe and on-air dot.
  accentColor?: string;
}

export type GraphicTemplateType =
  | 'title_card'
  | 'bullet_list'
  | 'statistic'
  | 'quote'
  | 'comparison'
  | 'simple_diagram'
  | 'callout'
  | 'end_card';

export interface NarrationSegment {
  id: string;
  order: number;
  sceneId?: string;
  text: string;
  estimatedDurationSeconds: number;
}

export interface NarrationCharacterAlignment {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
}

export interface NarrationWordTiming {
  word: string;
  startSeconds: number;
  endSeconds: number;
}

export interface NarrationAlignment {
  characters: NarrationCharacterAlignment;
  words: NarrationWordTiming[];
}

export interface NarrationSpec {
  // Production copy for this scene only.
  // Story/beats script source lives in Project.explainer.story.
  text: string;
  voiceId?: string;
  model?: string;
  format?: 'mp3' | 'wav' | 'm4a';
  audioAssetId?: string;
  status?: 'planned' | 'generating' | 'generated' | 'failed';
  lastAttemptId?: string;
  error?: string;
  duration?: number;
  alignment?: NarrationAlignment;
  attempts?: NarrationGenerationAttempt[];
}

export interface NarrationGenerationAttempt {
  id: string;
  status: 'planned' | 'generating' | 'generated' | 'failed';
  provider: string;
  model?: string;
  voiceId?: string;
  format: 'mp3' | 'wav' | 'm4a';
  providerRequestId?: string;
  mimeType?: string;
  duration?: number;
  audioAssetId?: string;
  alignment?: NarrationAlignment;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export interface MotionFocalPoint {
  x: number;
  y: number;
}

export interface MotionSpec {
  preset: MotionPreset;
  intensity?: number;
  startScale?: number;
  endScale?: number;
  focalPoint?: MotionFocalPoint;
}

export interface TransitionSpec {
  type: TransitionPreset;
  duration?: number;
}

export interface OverlayStyle {
  // Optional render style overrides for a text overlay.
  // All fields are additive; when omitted the renderer derives sensible
  // defaults from the scene dimensions and overlay type.
  fontSize?: number;
  color?: string;
  box?: boolean;
  margin?: number;
}

export interface OverlayTiming {
  // Scene-local timing for the overlay, in seconds.
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
}

export interface OverlaySpec {
  type: OverlayType;
  text?: string;
  position?: OverlayPosition;
  data?: Record<string, unknown>;
  style?: OverlayStyle;
  timing?: OverlayTiming;
}

export interface RenderSpec {
  motion: MotionSpec;
  transition: TransitionSpec;
}

export interface AssetVisual {
  kind: 'asset';
  assetId?: string;
}

export interface GeneratedImageVisual {
  kind: 'generated_image';
  assetId?: string;
  generation: GenerationRecord;
  attempts?: GenerationAttempt[];
}

export interface GeneratedVideoVisual {
  kind: 'generated_video';
  assetId?: string;
  generation: GenerationRecord;
  attempts?: GenerationAttempt[];
}

// A royalty-free stock photo chosen at runtime by the stock router. The author
// supplies a search query; the resolved `selection` (provider, photo, usage
// policy, attribution) is persisted once so re-runs are idempotent. `assetId`
// is set only for `download`-policy selections that were persisted as a durable
// project asset.
export interface StockImageVisual {
  kind: 'stock_image';
  query: string;
  orientation?: StockOrientation;
  // Optional per-scene provider preference order; falls back to server config.
  preferredProviders?: StockProviderId[];
  assetId?: string;
  selection?: StockSelection;
}

export interface GraphicVisual {
  kind: 'graphic';
  template?: GraphicTemplateType;
  prompt?: string;
  templateData?: Record<string, unknown>;
  style?: GraphicStyleSpec;
}

export interface TextVisual {
  kind: 'text';
  text: string;
}

export interface BlankVisual {
  kind: 'blank';
}

export type VisualSpec = AssetVisual | GeneratedImageVisual | GeneratedVideoVisual | StockImageVisual | GraphicVisual | TextVisual | BlankVisual;

export interface SceneSourceTrace {
  sceneIntentId?: string;
  beatIds?: string[];
}

export interface SceneRenderArtifact {
  renderId: string;
  outputPath: string;
  createdAt: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  filesize: number;
  mimeType: 'video/mp4';
  renderer: 'ffmpeg';
  status: 'completed' | 'failed';
  message?: string;
  renderFingerprint?: string;
}

export interface Scene {
  id: string;
  order: number;
  duration: number;
  source?: SceneSourceTrace;
  type: SceneType;
  narration?: NarrationSpec;
  visual?: VisualSpec;
  render: RenderSpec;
  overlay?: OverlaySpec;
  // Per-scene logo/sponsor layer. `null` explicitly disables a project default.
  logo?: LogoOverlaySpec | null;
  // Optional versioned compositor intent. Absent keeps the historical scene
  // render path unchanged for existing projects.
  composition?: SceneCompositionSpec;
  referenceIds: string[];
  notes: string;
  renders?: SceneRenderArtifact[];
}
