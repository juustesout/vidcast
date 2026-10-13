import type { Project } from '@/lib/types/render';
import type { ReferenceImage } from '@/lib/types/reference';
import { AuthoringMcpToolError } from './errors';
import type { AuthoringMcpErrorCode, CreateProjectInput, CreateReferenceInput, GenerateVideoInput, ManageProjectMusicInput } from './types';

interface ApiErrorPayload {
  message?: string;
  code?: string;
  errors?: unknown;
  warnings?: unknown;
  details?: Record<string, unknown>;
}

type ProjectPatch = Record<string, unknown>;

interface ProjectEnvelope {
  project?: Project;
}

interface PlanSceneIntentsPayload {
  project?: Project;
  createdIntentIds?: string[];
}

interface MaterializeSceneIntentsPayload {
  project?: Project;
  materialized?: Array<{ intentId: string; sceneId: string }>;
  skipped?: Array<{ intentId: string; sceneId: string }>;
}

interface ApproveSceneIntentsPayload {
  project?: Project;
  approved?: string[];
  skipped?: string[];
}

interface MusicPayload {
  action?: string;
  status?: string;
  assetId?: string;
  musicLengthMs?: number;
  provider?: string;
  model?: string;
}

export interface CreateProjectResult {
  project: Project;
}

export interface UpdateProjectResult {
  project: Project;
}

export interface PlanSceneIntentsResult {
  project: Project;
  createdIntentIds: string[];
}

export interface MaterializeSceneIntentsResult {
  project: Project;
  materialized: Array<{ intentId: string; sceneId: string }>;
  skipped: Array<{ intentId: string; sceneId: string }>;
}

export interface ApproveSceneIntentsResult {
  project: Project;
  approved: string[];
  skipped: string[];
}

export interface ManageMusicResult {
  action: string;
  status: string;
  assetId?: string;
  musicLengthMs?: number;
  provider?: string;
  model?: string;
}

export interface CreateReferenceResult {
  reference: ReferenceImage;
}

export interface GenerateVideoResult {
  sceneId: string;
  generationAttemptId: string;
  status: string;
  provider: string;
  model?: string;
  providerJobId: string;
  providerStatus?: string;
}

export interface CancelVideoResult {
  sceneId: string;
  generationAttemptId: string;
  status: string;
  provider: string;
  model?: string;
  providerJobId?: string;
  providerStatus: string;
}

export interface AuthoringApiClient {
  createProject(input: CreateProjectInput): Promise<CreateProjectResult>;
  updateProject(projectId: string, patch: ProjectPatch): Promise<UpdateProjectResult>;
  planSceneIntents(projectId: string, patch?: ProjectPatch): Promise<PlanSceneIntentsResult>;
  materializeSceneIntents(projectId: string, patch?: ProjectPatch, intentIds?: string[]): Promise<MaterializeSceneIntentsResult>;
  approveSceneIntents(projectId: string, intentIds?: string[]): Promise<ApproveSceneIntentsResult>;
  manageMusic(projectId: string, input: ManageProjectMusicInput): Promise<ManageMusicResult>;
  createReference(projectId: string, input: CreateReferenceInput): Promise<CreateReferenceResult>;
  generateVideo(projectId: string, sceneId: string, input: GenerateVideoInput): Promise<GenerateVideoResult>;
  cancelVideo(projectId: string, sceneId: string): Promise<CancelVideoResult>;
}

export interface HttpAuthoringApiClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function asPayload(value: unknown): ApiErrorPayload {
  return value && typeof value === 'object' ? (value as ApiErrorPayload) : {};
}

function parseCode(payload: unknown): string | undefined {
  const candidate = asPayload(payload);
  return typeof candidate.code === 'string' ? candidate.code : undefined;
}

function parseMessage(payload: unknown): string | undefined {
  const candidate = asPayload(payload);
  return typeof candidate.message === 'string' ? candidate.message : undefined;
}

function mapMusicApiCode(apiCode: string | undefined): AuthoringMcpErrorCode | undefined {
  if (!apiCode) {
    return undefined;
  }

  switch (apiCode) {
    case 'music.provider.notConfigured':
      return 'PROVIDER_NOT_CONFIGURED';
    case 'music.provider.auth':
    case 'music.provider.rejected':
    case 'music.provider.unsupported':
    case 'music.provider.failed':
      return 'PROVIDER_ERROR';
    case 'music.provider.rateLimited':
      return 'RATE_LIMITED';
    case 'music.alreadyRunning':
    case 'music.alreadyGenerated':
      return 'CONFLICT';
    case 'music.project.notFound':
    case 'music.asset.notFound':
      return 'NOT_FOUND';
    case 'music.invalid':
    case 'music.asset.invalidType':
      return 'INVALID_ARGUMENT';
    default:
      return undefined;
  }
}

function mapGenerationApiCode(apiCode: string | undefined): AuthoringMcpErrorCode | undefined {
  if (!apiCode) {
    return undefined;
  }

  // Reference upload codes (POST /references JSON path). All are 4xx input
  // problems surfaced as INVALID_ARGUMENT.
  if (apiCode.startsWith('reference.')) {
    return 'INVALID_ARGUMENT';
  }

  switch (apiCode) {
    case 'generation.provider.notConfigured':
      return 'PROVIDER_NOT_CONFIGURED';
    case 'generation.provider.notAllowed':
    case 'generation.policy.denied':
      return 'FORBIDDEN';
    case 'generation.provider.auth':
    case 'generation.provider.rejected':
    case 'generation.provider.failed':
    case 'generation.provider.invalid':
      return 'PROVIDER_ERROR';
    case 'generation.provider.rateLimited':
      return 'RATE_LIMITED';
    case 'generation.provider.cancelUnsupported':
    case 'generation.provider.cancelFailed':
      return 'CONFLICT';
    case 'generation.project.notFound':
    case 'generation.scene.notFound':
    case 'generation.reference.notFound':
    case 'generation.reference.fileMissing':
      return 'NOT_FOUND';
    case 'generation.scene.busy':
    case 'generation.scene.alreadyGenerated':
    case 'generation.scene.alreadyRunning':
    case 'generation.scene.notActive':
    case 'generation.attempt.pollBusy':
    case 'generation.reference.frameConflict':
      return 'CONFLICT';
    case 'generation.scene.missingPrompt':
    case 'generation.reference.startFrameInvalid':
    case 'generation.reference.endFrameInvalid':
    case 'generation.attempt.missingJobId':
      return 'INVALID_ARGUMENT';
    default:
      return undefined;
  }
}

function mapApiCode(apiCode: string | undefined): AuthoringMcpErrorCode | undefined {
  if (!apiCode) {
    return undefined;
  }

  const musicCode = mapMusicApiCode(apiCode);
  if (musicCode) {
    return musicCode;
  }

  const generationCode = mapGenerationApiCode(apiCode);
  if (generationCode) {
    return generationCode;
  }

  switch (apiCode) {
    case 'UNAUTHENTICATED':
      return 'UNAUTHENTICATED';
    case 'FORBIDDEN':
      return 'FORBIDDEN';
    case 'RATE_LIMITED':
      return 'RATE_LIMITED';
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'CONFLICT':
      return 'CONFLICT';
    case 'VALIDATION_FAILED':
      return 'VALIDATION_FAILED';
    case 'PROVIDER_NOT_CONFIGURED':
      return 'PROVIDER_NOT_CONFIGURED';
    case 'POLICY_DENIED':
      return 'FORBIDDEN';
    case 'INVALID_ARGUMENT':
      return 'INVALID_ARGUMENT';
    default:
      return undefined;
  }
}

function mapStatusToCode(status: number, payload: unknown): AuthoringMcpErrorCode {
  const explicit = mapApiCode(parseCode(payload));
  if (explicit) {
    return explicit;
  }

  if (status === 401) {
    return 'UNAUTHENTICATED';
  }
  if (status === 403) {
    return 'FORBIDDEN';
  }
  if (status === 404) {
    return 'NOT_FOUND';
  }
  if (status === 409) {
    return 'CONFLICT';
  }
  if (status === 422) {
    return 'VALIDATION_FAILED';
  }
  if (status === 429) {
    return 'RATE_LIMITED';
  }
  if (status === 400) {
    return 'INVALID_ARGUMENT';
  }

  return 'API_ERROR';
}

function validationDetails(payload: unknown): Record<string, unknown> | undefined {
  const candidate = asPayload(payload);
  const details: Record<string, unknown> = {};
  if (Array.isArray(candidate.errors)) {
    details.errors = candidate.errors;
  }
  if (Array.isArray(candidate.warnings)) {
    details.warnings = candidate.warnings;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

export class HttpAuthoringApiClient implements AuthoringApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiToken: string | null;

  constructor(options: HttpAuthoringApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.EXPLAINER_API_BASE_URL ?? 'http://127.0.0.1:5555').replace(/\/$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
    this.apiToken = process.env.EXPLAINER_API_TOKEN?.trim() || null;
  }

  private withAuthHeaders(headers: HeadersInit | undefined): Headers {
    const normalized = new Headers(headers);
    if (this.apiToken && !normalized.has('authorization')) {
      normalized.set('authorization', `Bearer ${this.apiToken}`);
    }
    return normalized;
  }

  private async request(path: string, method: 'POST' | 'PUT', body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers: this.withAuthHeaders({
          accept: 'application/json',
          'content-type': 'application/json'
        }),
        body: JSON.stringify(body ?? {})
      });
    } catch {
      throw new AuthoringMcpToolError('API_UNAVAILABLE', 'Explainer app API is not reachable.', { endpoint: path });
    }

    const payload = await parseJson(response);
    if (!response.ok) {
      const code = mapStatusToCode(response.status, payload);
      throw new AuthoringMcpToolError(code, parseMessage(payload) ?? 'App API request failed.', {
        endpoint: path,
        httpStatus: response.status,
        apiCode: parseCode(payload),
        ...(code === 'VALIDATION_FAILED' ? validationDetails(payload) ?? {} : parseDetails(payload))
      });
    }

    return payload;
  }

  async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    const payload = (await this.request('/api/projects', 'POST', input)) as ProjectEnvelope;
    if (!payload.project) {
      throw new AuthoringMcpToolError('API_ERROR', 'Invalid project creation response payload.', { endpoint: '/api/projects' });
    }
    return { project: payload.project };
  }

  async updateProject(projectId: string, patch: ProjectPatch): Promise<UpdateProjectResult> {
    const path = `/api/projects/${encodeURIComponent(projectId)}`;
    const payload = (await this.request(path, 'PUT', patch)) as ProjectEnvelope;
    if (!payload.project) {
      throw new AuthoringMcpToolError('API_ERROR', 'Invalid project update response payload.', { endpoint: path, projectId });
    }
    return { project: payload.project };
  }

  async planSceneIntents(projectId: string, patch?: ProjectPatch): Promise<PlanSceneIntentsResult> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/scene-intents/plan`;
    const payload = (await this.request(path, 'POST', patch ? { project: patch } : {})) as PlanSceneIntentsPayload;
    if (!payload.project || !Array.isArray(payload.createdIntentIds)) {
      throw new AuthoringMcpToolError('API_ERROR', 'Invalid scene intent plan response payload.', { endpoint: path, projectId });
    }
    return { project: payload.project, createdIntentIds: payload.createdIntentIds };
  }

  async materializeSceneIntents(projectId: string, patch?: ProjectPatch, intentIds?: string[]): Promise<MaterializeSceneIntentsResult> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/scene-intents/materialize`;
    const body: Record<string, unknown> = {};
    if (patch) {
      body.project = patch;
    }
    if (intentIds) {
      body.intentIds = intentIds;
    }

    const payload = (await this.request(path, 'POST', body)) as MaterializeSceneIntentsPayload;
    if (!payload.project || !Array.isArray(payload.materialized) || !Array.isArray(payload.skipped)) {
      throw new AuthoringMcpToolError('API_ERROR', 'Invalid scene intent materialization response payload.', { endpoint: path, projectId });
    }
    return { project: payload.project, materialized: payload.materialized, skipped: payload.skipped };
  }

  async approveSceneIntents(projectId: string, intentIds?: string[]): Promise<ApproveSceneIntentsResult> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/scene-intents/approve`;
    const body: Record<string, unknown> = {};
    if (intentIds && intentIds.length > 0) {
      body.intentIds = intentIds;
    }

    const payload = (await this.request(path, 'POST', body)) as ApproveSceneIntentsPayload;
    if (!payload.project || !Array.isArray(payload.approved) || !Array.isArray(payload.skipped)) {
      throw new AuthoringMcpToolError('API_ERROR', 'Invalid scene intent approval response payload.', { endpoint: path, projectId });
    }
    return { project: payload.project, approved: payload.approved, skipped: payload.skipped };
  }

  async manageMusic(projectId: string, input: ManageProjectMusicInput): Promise<ManageMusicResult> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/music`;
    const payload = (await this.request(path, 'POST', input)) as MusicPayload;
    if (!payload.action || typeof payload.status !== 'string') {
      throw new AuthoringMcpToolError('API_ERROR', 'Invalid music response payload.', { endpoint: path, projectId });
    }
    return {
      action: payload.action,
      status: payload.status,
      assetId: payload.assetId,
      musicLengthMs: payload.musicLengthMs,
      provider: payload.provider,
      model: payload.model
    };
  }

  async createReference(projectId: string, input: CreateReferenceInput): Promise<CreateReferenceResult> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/references`;
    const payload = (await this.request(path, 'POST', input)) as { reference?: ReferenceImage };
    if (!payload.reference) {
      throw new AuthoringMcpToolError('API_ERROR', 'Invalid reference creation response payload.', { endpoint: path, projectId });
    }
    return { reference: payload.reference };
  }

  async generateVideo(projectId: string, sceneId: string, input: GenerateVideoInput): Promise<GenerateVideoResult> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/generate-video`;
    const payload = (await this.request(path, 'POST', input)) as Partial<GenerateVideoResult>;
    if (!payload.sceneId || !payload.generationAttemptId || typeof payload.status !== 'string' || typeof payload.providerJobId !== 'string') {
      throw new AuthoringMcpToolError('API_ERROR', 'Invalid video submit response payload.', { endpoint: path, projectId, sceneId });
    }
    return payload as GenerateVideoResult;
  }

  async cancelVideo(projectId: string, sceneId: string): Promise<CancelVideoResult> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/cancel-video`;
    const payload = (await this.request(path, 'POST', {})) as Partial<CancelVideoResult>;
    if (!payload.sceneId || typeof payload.status !== 'string' || typeof payload.providerStatus !== 'string') {
      throw new AuthoringMcpToolError('API_ERROR', 'Invalid video cancel response payload.', { endpoint: path, projectId, sceneId });
    }
    return payload as CancelVideoResult;
  }
}

function parseDetails(payload: unknown): Record<string, unknown> {
  const candidate = asPayload(payload);
  return candidate.details && typeof candidate.details === 'object' ? candidate.details : {};
}
