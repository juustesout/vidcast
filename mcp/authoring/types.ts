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

