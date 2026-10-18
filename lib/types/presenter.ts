export type PresenterLayout = 'fullscreen' | 'pip';

export type PresenterPipPosition = 'bottom_right' | 'bottom_left' | 'top_right' | 'top_left';

export type PresenterOutputFormat = 'mp4' | 'webm';

export type PresenterProviderKey = 'mock' | 'heygen';

export interface PresenterPipSettings {
  position?: PresenterPipPosition;
  // Fraction of the canvas width occupied by the PiP presenter.
  widthRatio?: number;
  // Fraction of the canvas width used as an inset margin.
  marginRatio?: number;
}

// Authoring intent for one scene. A scene without an entry has no presenter.
export interface PresenterSceneSetting {
  sceneId: string;
  layout: PresenterLayout;
  pip?: PresenterPipSettings;
  // Trim from the start of the generated presenter clip, in seconds.
  startOffsetSeconds?: number;
}

export interface ProjectPresenterSettings {
  enabled: boolean;
  avatarId?: string;
  provider?: PresenterProviderKey;
  outputFormat?: PresenterOutputFormat;
  sceneSettings: PresenterSceneSetting[];
  // Hard spend guards. They apply only to real (paid) providers.
  maxGeneratedSeconds?: number;
  maxPaidRequests?: number;
}

export type PresenterClipStatus = 'planned' | 'submitting' | 'generating' | 'generated' | 'failed';

export interface PresenterClipAttempt {
  id: string;
  status: PresenterClipStatus;
  provider: string;
  avatarId?: string;
  providerJobId?: string;
  providerStatus?: string;
  outputFormat: PresenterOutputFormat;
  audioAssetId: string;
  narrationSignature: string;
  duration: number;
  videoAssetId?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

// Durable per-scene presenter artifact reference. The video itself stays a
// normal project asset; this record only tracks freshness and provider state.
export interface PresenterClipSpec {
  sceneId: string;
  status: PresenterClipStatus;
  provider: string;
  avatarId?: string;
  outputFormat: PresenterOutputFormat;
  audioAssetId: string;
  narrationSignature: string;
  duration: number;
  assetId?: string;
  lastAttemptId?: string;
  error?: string;
  attempts?: PresenterClipAttempt[];
}

// Resolved, render-ready placement produced by the composition planner.
export interface PresenterOverlayPlacement {
  sceneId: string;
  clipPath: string;
  clipDuration: number;
  startTime: number;
  duration: number;
  layout: PresenterLayout;
  startOffsetSeconds: number;
  pip?: Required<PresenterPipSettings>;
}

export interface CompositionPresenterPlan {
  placements: PresenterOverlayPlacement[];
  warnings?: string[];
}
