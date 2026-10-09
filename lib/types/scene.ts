import type { GenerationAttempt, GenerationRecord } from './generation';

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

export interface OverlaySpec {
  type: OverlayType;
  text?: string;
  position?: OverlayPosition;
  data?: Record<string, unknown>;
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

export interface GraphicVisual {
  kind: 'graphic';
  template?: GraphicTemplateType;
  prompt?: string;
  templateData?: Record<string, unknown>;
}

export interface TextVisual {
  kind: 'text';
  text: string;
}

export interface BlankVisual {
  kind: 'blank';
}

export type VisualSpec = AssetVisual | GeneratedImageVisual | GeneratedVideoVisual | GraphicVisual | TextVisual | BlankVisual;

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
  referenceIds: string[];
  notes: string;
  renders?: SceneRenderArtifact[];
}
