import type { Asset, AssetType } from './asset';
import type { ExplainerSpec } from './explainer';
import type { GraphicStyleSpec, GraphicTemplateType, HtmlStillBackground, HtmlStillTemplateType, LogoOverlaySpec, MotionSpec, NarrationSpec, OverlaySpec, SceneType, StudioOverlaySpec, TransitionSpec } from './scene';
import type { SceneCompositionFit, SceneCompositionLayerType, SceneCompositionPresenterMode, SceneCompositionPresetName, SceneCompositionRect, SceneCompositionSchemaVersion } from './scene-composition';
import type { ReferenceImage } from './reference';
import type { PresenterClipSpec, ProjectPresenterSettings, CompositionPresenterPlan } from './presenter';

export type AspectRatio = '16:9' | '1:1' | '9:16';

// Scale policy for mapping a non-canvas-aspect source onto the canvas. See
// lib/render/fit-policy.ts. `cover` is the historical center-crop default.
export type RenderFit = 'cover' | 'contain';

export interface AudioMixSettings {
  narrationVolume: number;
  musicVolume: number;
  effectsVolume: number;
}

export interface RenderSettings {
  aspectRatio: AspectRatio;
  fps: number;
  width: number;
  height: number;
  // Optional project-level scale policy for non-canvas-aspect sources. Absent
  // means the historical `cover` (center-crop) default.
  fit?: RenderFit;
  background: {
    type: 'color';
    value: string;
  };
  audio: AudioMixSettings;
  seed?: number;
  subtitlesEnabled: boolean;
  // Optional project-level logo used when a scene does not specify one.
  logo?: LogoOverlaySpec;
  // Optional project-level palette for graphic templates. A scene's visual
  // style overrides individual fields.
  graphicStyle?: GraphicStyleSpec;
  // Optional reusable studio set. Absent means scenes render full-frame exactly
  // as they did before this layer existed.
  studio?: StudioOverlaySpec;
}

export interface RenderIssue {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

export interface RenderValidationResult {
  valid: boolean;
  errors: RenderIssue[];
  warnings: RenderIssue[];
}

export interface ProjectNarration {
  // Legacy project-level narration container.
  // Source-of-truth for production narration is Scene.narration.text per scene.
  text: string;
  segments: import('./scene').NarrationSegment[];
}

export type ProjectMusicStatus = 'planned' | 'generating' | 'generated' | 'failed';

export interface ProjectMusicGenerationAttempt {
  id: string;
  status: ProjectMusicStatus;
  provider: string;
  model?: string;
  prompt?: string;
  instrumental?: boolean;
  musicLengthMs?: number;
  providerRequestId?: string;
  mimeType?: string;
  duration?: number;
  audioAssetId?: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export interface ProjectMusicSpec {
  // Optional project-wide background music track.
  // Selecting a track only stores a reference; the underlying asset stays a
  // normal project asset and is never implicitly deleted when replaced/cleared.
  assetId?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  status?: ProjectMusicStatus;
  instrumental?: boolean;
  musicLengthMs?: number;
  format?: string;
  seed?: number;
  duration?: number;
  lastAttemptId?: string;
  error?: string;
  attempts?: ProjectMusicGenerationAttempt[];
  updatedAt?: string;
}

export interface Project {
  id: string;
  ownerId?: string;
  title: string;
  description: string;
  durationTarget: number;
  aspectRatio: AspectRatio;
  fps: number;
  createdAt: string;
  updatedAt: string;
  explainer?: ExplainerSpec;
  narration: ProjectNarration;
  scenes: import('./scene').Scene[];
  assets: Asset[];
  references: ReferenceImage[];
  renderSettings: RenderSettings;
  music?: ProjectMusicSpec;
  // Optional AI presenter layer. Absent means the project has no presenter and
  // is rendered exactly as before.
  presenter?: ProjectPresenterSettings;
  presenterClips?: PresenterClipSpec[];
  compositions?: CompositionArtifact[];
}

export interface RenderPlanSceneSource {
  kind: SceneType;
  assetId?: string;
  assetPath?: string;
  // Remote CDN URL for hotlink-only sources (for example Unsplash stock photos)
  // that must not be persisted locally. Fetched into the transient render
  // workspace at render time.
  remoteUrl?: string;
  assetType?: AssetType;
  width?: number;
  height?: number;
  duration?: number;
  mimeType?: string;
  template?: GraphicTemplateType;
  templateData?: Record<string, unknown>;
  style?: GraphicStyleSpec;
  text?: string;
  html?: string;
  css?: string;
  htmlTemplate?: HtmlStillTemplateType;
  htmlBackground?: HtmlStillBackground;
  htmlFingerprint?: string;
}

// A logo resolved against the project asset list. `assetPath` is project-relative
// (or absolute for callers that build plans directly).
export type RenderPlanLogoOverlay = LogoOverlaySpec & { assetPath: string };

// Studio geometry resolved to concrete canvas pixels. The renderer rasterizes
// this into a transparent-cutout PNG and composites it above the scene source.
export interface RenderPlanStudioOverlay {
  brand: string;
  program: string;
  accentColor: string;
  screen: {
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
  };
}

export type RenderPlanSceneStatus = 'renderable' | 'planned' | 'invalid';

// Derived, non-persistent timing for a scene. `duration` on RenderPlanScene is
// the effective duration; this record explains how it was derived so planning,
// rendering and composition can share the same decision.
export interface RenderSceneTiming {
  authoredDuration: number;
  narrationDuration?: number;
  endPaddingSeconds: number;
  effectiveDuration: number;
  adjusted: boolean;
  exceedsMax: boolean;
}

export interface RenderPlanSceneStateIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export type RenderPlanCompositionMediaKind = 'image' | 'video';

export interface RenderPlanCompositionLayer {
  id: string;
  type: SceneCompositionLayerType;
  enabled: boolean;
  zIndex: number;
  rect: SceneCompositionRect;
  fit: SceneCompositionFit;
  assetId?: string;
  assetPath?: string;
  mediaKind?: RenderPlanCompositionMediaKind;
  mode?: SceneCompositionPresenterMode;
  startSeconds?: number;
  durationSeconds?: number;
}

export interface RenderPlanSceneComposition {
  version: SceneCompositionSchemaVersion;
  preset?: SceneCompositionPresetName;
  canvas: { width: number; height: number };
  layers: RenderPlanCompositionLayer[];
  presenterAssetId?: string;
  presenterClipDuration?: number;
  presenterStartOffsetSeconds?: number;
}

export interface RenderPlanScene {
  sceneId: string;
  order: number;
  duration: number;
  timing?: RenderSceneTiming;
  status: RenderPlanSceneStatus;
  source: RenderPlanSceneSource;
  motion: MotionSpec;
  transition: TransitionSpec;
  overlay?: OverlaySpec;
  logo?: RenderPlanLogoOverlay;
  // Optional resolved layer stack. Absent keeps the historical still/video/studio path.
  composition?: RenderPlanSceneComposition;
  narration?: NarrationSpec;
  referenceIds: string[];
  issues: RenderPlanSceneStateIssue[];
}

export interface SceneRenderResult {
  renderId: string;
  sceneId: string;
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
  sourceAssetIds?: string[];
  renderFingerprint?: string;
}

export type CompositionTransitionType = 'none' | 'fade';

export interface CompositionTransition {
  type: CompositionTransitionType;
  duration?: number;
}

export interface CompositionItem {
  sceneId: string;
  sceneOrder: number;
  renderId: string;
  renderPath: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  narrationAudioPath?: string;
  narrationAudioDuration?: number;
}

export interface CompositionMusic {
  // Absolute path to the selected background music asset on disk.
  path: string;
  duration?: number;
}

export interface CompositionPlan {
  projectId: string;
  items: CompositionItem[];
  width: number;
  height: number;
  fps: number;
  totalDuration: number;
  transition: CompositionTransition;
  audio?: AudioMixSettings;
  music?: CompositionMusic;
  // Resolved presenter placements. Missing/unusable presenter clips are
  // reported in `warnings` and simply omitted; the underlying video remains
  // composable.
  presenter?: CompositionPresenterPlan;
  // Scale policy applied when a normalized scene segment is not already the
  // canvas aspect ratio. Defaults to `cover` (historical center-crop).
  fit?: RenderFit;
}

export interface CompositionArtifact {
  compositionId: string;
  projectId: string;
  outputPath: string;
  createdAt: string;
  sceneIds: string[];
  inputFingerprint?: {
    version: 'p10.1';
    audioMix?: AudioMixSettings;
    music?: {
      assetId: string;
      musicVolume: number;
      fadeInSeconds: number;
      fadeOutSeconds: number;
      musicSignature: string;
    };
    scenes: Array<{
      sceneId: string;
      renderId: string;
      narrationSignature: string;
    }>;
    // Stable hash of presenter settings plus generated clip references. Absent
    // on compositions created before the presenter layer existed.
    presenterSignature?: string;
  };
  duration: number;
  width: number;
  height: number;
  fps: number;
  renderer: 'ffmpeg';
  version: string;
  filesize: number;
  mimeType: 'video/mp4';
  transition: CompositionTransition;
}

export interface CompositionResult {
  plan: CompositionPlan;
  artifact: CompositionArtifact;
}

export interface RenderPlan {
  projectId: string;
  title: string;
  aspectRatio: AspectRatio;
  fps: number;
  width: number;
  height: number;
  // Scale policy resolved from project render settings; `cover` when unset.
  fit?: RenderFit;
  background?: {
    type: 'color';
    value: string;
  };
  // Optional studio set resolved to canvas pixels. Absent keeps the historical
  // full-frame scene rendering.
  studio?: RenderPlanStudioOverlay;
  ready: boolean;
  scenes: RenderPlanScene[];
  narration: ProjectNarration;
  issues: RenderIssue[];
  seed?: number;
  audio?: AudioMixSettings;
  subtitlesEnabled?: boolean;
}

export interface VideoPlan extends RenderPlan {
  targetDuration: number;
  assets: Asset[];
  references: ReferenceImage[];
}

export interface RendererResult {
  ok: boolean;
  message: string;
  renderPlan: RenderPlan;
  render?: SceneRenderResult;
}
