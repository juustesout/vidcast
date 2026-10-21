export type AuthoringMcpErrorCode =
  | 'INVALID_ARGUMENT'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_ERROR'
  | 'API_UNAVAILABLE'
  | 'API_ERROR'
  | 'INTERNAL_ERROR';

export interface AuthoringMcpError {
  code: AuthoringMcpErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface AuthoringMcpSuccess<T> {
  ok: true;
  data: T;
}

export interface AuthoringMcpFailure {
  ok: false;
  error: AuthoringMcpError;
}

export type AuthoringMcpResult<T> = AuthoringMcpSuccess<T> | AuthoringMcpFailure;

export interface CreateProjectInput {
  title?: string;
  description?: string;
  durationTarget?: number;
  aspectRatio?: '16:9' | '1:1' | '9:16';
  fps?: number;
}

export interface CreateProjectResponse {
  projectId: string;
  title: string;
  valid: true;
  // Present only when the creating caller is a service: a single-use token the
  // agent must hand to the intended browser user out-of-band so they can claim
  // the project. Never surfaced to other clients or through project reads.
  claimToken?: string;
}

export interface UpdateProjectResponse {
  projectId: string;
  valid: true;
}

export interface PlanSceneIntentsResponse {
  projectId: string;
  valid: true;
  createdIntentIds: string[];
}

export interface MaterializeSceneIntentsResponse {
  projectId: string;
  valid: true;
  materialized: Array<{ intentId: string; sceneId: string }>;
  skipped: Array<{ intentId: string; sceneId: string }>;
}

export interface ApproveSceneIntentsResponse {
  projectId: string;
  valid: true;
  approved: string[];
  skipped: string[];
}

export type ProjectMusicAction = 'generate' | 'regenerate' | 'select' | 'clear';

export interface ManageProjectMusicInput {
  action: ProjectMusicAction;
  prompt?: string;
  musicLengthMs?: number;
  instrumental?: boolean;
  model?: string;
  provider?: string;
  seed?: number;
  outputFormat?: string;
  assetId?: string;
  mode?: 'mock' | 'real';
}

export interface ManageProjectMusicResponse {
  projectId: string;
  action: ProjectMusicAction;
  status: string;
  assetId?: string;
  musicLengthMs?: number;
  musicProvider?: string;
  musicModel?: string;
}

export interface CreateReferenceInput {
  name: string;
  // Raw base64 (or a full data URL) of a png/jpg/jpeg/webp image. Reference
  // images are what text-to-video and image-to-video consume (including the
  // start/end keyframes), so this is how an agent attaches visual inputs.
  contentBase64: string;
  mimeType?: string;
  fileName?: string;
  description?: string;
  tags?: string[];
}

export interface CreateReferenceResponse {
  projectId: string;
  referenceId: string;
  name: string;
  filePath?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  filesize?: number;
}

export interface ImportStudioAssetsInput {
  fileNames: string[];
}

export interface ImportedStudioAsset {
  assetId: string;
  filename: string;
  localPath: string;
  mimeType?: string;
  width?: number;
  height?: number;
  filesize?: number;
}

export interface ImportStudioAssetsResponse {
  projectId: string;
  assets: ImportedStudioAsset[];
}

export interface GenerateVideoInput {
  regenerate?: boolean;
  // Explicit provider/model selection forwarded to the video service. When
  // omitted, the server uses the scene's stored values and its mode-aware
  // default. The mock sentinel `local` is validated server-side like any other.
  provider?: string;
  model?: string;
  mode?: 'mock' | 'real';
}

export interface GenerateVideoResponse {
  projectId: string;
  sceneId: string;
  generationAttemptId: string;
  status: string;
  provider: string;
  model?: string;
  providerJobId: string;
  providerStatus?: string;
}

export interface CancelVideoResponse {
  projectId: string;
  sceneId: string;
  generationAttemptId: string;
  status: string;
  provider: string;
  model?: string;
  providerJobId?: string;
  providerStatus: string;
}

export interface RenderAnimationTemplateInput {
  templateId: 'northwind_arr_chart' | 'nix_overlay';
  params?: Record<string, unknown>;
}

export interface RenderAnimationTemplateResponse {
  projectId: string;
  templateId: 'northwind_arr_chart' | 'nix_overlay';
  assetId: string;
  localPath: string;
  mimeType: string;
  destination: 'bigscreen' | 'overlay';
  width?: number;
  height?: number;
  duration?: number;
  filesize?: number;
}

export interface AttachAnimationInput {
  assetId: string;
  destination: 'bigscreen' | 'overlay';
  startSeconds?: number;
  durationSeconds?: number;
  scale?: number;
  position?: { x: number; y: number };
  rect?: { x: number; y: number; width: number; height: number };
}

export interface AttachAnimationResponse {
  projectId: string;
  sceneId: string;
  assetId: string;
  localPath: string;
  destination: 'bigscreen' | 'overlay';
  layerId: string;
  rect: { x: number; y: number; width: number; height: number };
  startSeconds?: number;
  durationSeconds?: number;
}


