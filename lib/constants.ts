import type { AspectRatio } from './types/render';
import type { MotionPreset, OverlayPosition, OverlayType, SceneType, TransitionPreset } from './types/scene';
import type { AssetProvenance, AssetStatus, AssetType } from './types/asset';
import type { GenerationProvider, GenerationStatus } from './types/generation';

export const SCENE_TYPES: SceneType[] = ['image', 'video', 'graphic', 'text', 'blank'];

export const MOTION_PRESETS: MotionPreset[] = [
  'none',
  'zoom_in',
  'zoom_out',
  'pan_left',
  'pan_right',
  'pan_up',
  'pan_down',
  'zoom_left',
  'zoom_right'
];

export const TRANSITION_PRESETS: TransitionPreset[] = ['none', 'fade', 'crossfade'];

export const OVERLAY_TYPES: OverlayType[] = ['none', 'text', 'title', 'subtitle', 'callout', 'statistic', 'quote'];

export const OVERLAY_POSITIONS: OverlayPosition[] = ['top', 'center', 'bottom'];

// Shared overlay style/timing bounds. Both the renderer (lazy defaults/clamps in
// lib/render/overlay-resolve.ts) and the authoring validation read from here so
// the two never drift apart.
export const OVERLAY_STYLE_LIMITS = {
  MIN_FONT_SIZE: 24,
  MAX_FONT_SIZE: 220,
  MIN_MARGIN: 16,
  MAX_MARGIN: 240
} as const;

// Fades are additionally bounded by the scene duration at render time; this is
// only the absolute upper bound accepted at authoring time.
export const OVERLAY_MAX_FADE_SECONDS = 600;

export const GENERATION_PROVIDERS: GenerationProvider[] = ['openai', 'gemini', 'local', 'other'];

export const GENERATION_STATUSES: GenerationStatus[] = ['planned', 'queued', 'generating', 'generated', 'failed', 'rejected'];

export const ASPECT_RATIOS: AspectRatio[] = ['16:9', '1:1', '9:16'];

export const ASSET_TYPES: AssetType[] = ['image', 'video', 'audio', 'music', 'voice', 'graphic'];

export const ASSET_PROVENANCE_VALUES: AssetProvenance[] = ['imported', 'generated', 'stock', 'derived'];

export const ASSET_STATUS_VALUES: AssetStatus[] = ['available', 'missing', 'processing', 'failed', 'planned', 'imported', 'generated'];

export const DEFAULT_RENDER_SETTINGS = {
  aspectRatio: '16:9' as const,
  fps: 30,
  width: 1920,
  height: 1080,
  background: {
    type: 'color' as const,
    value: '#070b10'
  },
  audio: {
    narrationVolume: 1,
    musicVolume: 0.35,
    effectsVolume: 0.2
  },
  subtitlesEnabled: true
};

export const DEFAULT_PROJECT_TITLE = 'Untitled Explainer';
export const DEFAULT_PROJECT_DESCRIPTION = 'A locally authored explainer video project.';
export const DEFAULT_PROJECT_DURATION = 60;
