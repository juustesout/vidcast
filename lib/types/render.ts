import type { Asset, AssetType } from './asset';
import type { ExplainerSpec } from './explainer';
import type { GraphicTemplateType, MotionSpec, NarrationSpec, OverlaySpec, SceneType, TransitionSpec } from './scene';
import type { ReferenceImage } from './reference';

export type AspectRatio = '16:9' | '1:1' | '9:16';

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
  background: {
    type: 'color';
    value: string;
  };
  audio: AudioMixSettings;
  seed?: number;
  subtitlesEnabled: boolean;
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
  compositions?: CompositionArtifact[];
}

export interface RenderPlanSceneSource {
  kind: SceneType;
  assetId?: string;
  assetPath?: string;
  assetType?: AssetType;
  width?: number;
  height?: number;
  duration?: number;
  mimeType?: string;
  template?: GraphicTemplateType;
  templateData?: Record<string, unknown>;
  text?: string;
}

export type RenderPlanSceneStatus = 'renderable' | 'planned' | 'invalid';

export interface RenderPlanSceneStateIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface RenderPlanScene {
  sceneId: string;
  order: number;
  duration: number;
  status: RenderPlanSceneStatus;
  source: RenderPlanSceneSource;
  motion: MotionSpec;
  transition: TransitionSpec;
  overlay?: OverlaySpec;
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

export interface CompositionPlan {
  projectId: string;
  items: CompositionItem[];
  width: number;
  height: number;
  fps: number;
  totalDuration: number;
  transition: CompositionTransition;
  audio?: AudioMixSettings;
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
    scenes: Array<{
      sceneId: string;
      renderId: string;
      narrationSignature: string;
    }>;
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
  background?: {
    type: 'color';
    value: string;
  };
  ready: boolean;
  scenes: RenderPlanScene[];
  narration: ProjectNarration;
  issues: RenderIssue[];
  seed?: number;
  audio?: AudioMixSettings;
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
