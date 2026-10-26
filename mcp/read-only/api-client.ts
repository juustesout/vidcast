import type { AnimationTemplateSummary } from '@/lib/animation/types';
import type { StockSearchResponse } from '@/lib/ai/stock/stock-search-service';
import type { ProductionMandate } from '@/lib/types/mandate';
import type { Project } from '@/lib/types/render';
import type { ProjectSummary } from '@/lib/storage/project-store';
import type { ProjectValidationReport } from '@/lib/validation/project-validation-report';
import type { ProductionPlanReport } from '@/lib/production/production-plan-report';
import type { GetGenerationJobResponse, GetMandateStatusResponse, ReadOnlyMcpErrorCode, SearchStockPhotosInput } from './types';
import { ReadOnlyMcpToolError } from './errors';

interface ProjectsListPayload {
  projects?: ProjectSummary[];
}

interface ProjectPayload {
  project?: Project;
}

interface ValidationReportPayload {
  report?: ProjectValidationReport;
}

interface ProductionPlanPayload {
  report?: ProductionPlanReport;
}

interface ApiErrorPayload {
  message?: string;
  code?: string;
}

interface AnimationTemplatesPayload {
  templates?: AnimationTemplateSummary[];
}

interface GenerationJobPayload {
  sceneId?: string;
  generationAttemptId?: string;
  status?: string;
  assetId?: string;
  provider?: string;
  model?: string;
  providerJobId?: string;
  providerStatus?: string;
  errorCode?: string;
  errorMessage?: string;
  lastPolledAt?: string;
}

interface MandatePayload {
  mandate?: ProductionMandate;
  live?: boolean;
}

export interface AppApiClient {
  listProjects(): Promise<ProjectSummary[]>;
  getProject(projectId: string): Promise<Project>;
  getValidationReport(projectId: string): Promise<ProjectValidationReport>;
  getProductionPlan(projectId: string): Promise<ProductionPlanReport>;
  getGenerationJob(projectId: string, attemptId: string): Promise<GetGenerationJobResponse>;
  getMandateStatus(projectId: string): Promise<GetMandateStatusResponse>;
  listAnimationTemplates(): Promise<AnimationTemplateSummary[]>;
  searchStockPhotos(projectId: string, input: SearchStockPhotosInput): Promise<StockSearchResponse>;
}

export interface HttpAppApiClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

function getMessageFromUnknown(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const candidate = payload as ApiErrorPayload;
  return typeof candidate.message === 'string' ? candidate.message : undefined;
}

function getCodeFromUnknown(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const candidate = payload as ApiErrorPayload;
  return typeof candidate.code === 'string' ? candidate.code : undefined;
}

function getDiagnosticsFromUnknown(payload: unknown): unknown[] | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const diagnostics = (payload as { diagnostics?: unknown }).diagnostics;
  return Array.isArray(diagnostics) ? diagnostics : undefined;
}

function mapStockSearchStatus(status: number, payload: unknown): ReadOnlyMcpErrorCode {
  const apiCode = getCodeFromUnknown(payload);
  if (apiCode === 'RATE_LIMITED') {
    return 'RATE_LIMITED';
  }
  if (apiCode === 'stock.policy.denied') {
    return 'FORBIDDEN';
  }
  if (status === 400) {
    return 'INVALID_ARGUMENT';
  }
  if (status === 403) {
    return 'FORBIDDEN';
  }
  if (status === 404) {
    return 'NOT_FOUND';
  }
  if (status === 429) {
    return 'RATE_LIMITED';
  }
  return 'API_ERROR';
}

async function parseJsonResponse(response: Response): Promise<unknown> {
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

export class HttpAppApiClient implements AppApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiToken: string | null;

  constructor(options: HttpAppApiClientOptions = {}) {
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

  private async request(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'GET',
        headers: this.withAuthHeaders({
          accept: 'application/json'
        })
      });
    } catch {
      throw new ReadOnlyMcpToolError('API_UNAVAILABLE', 'Explainer app API is not reachable.', { endpoint: path });
    }

    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      const message = getMessageFromUnknown(payload) ?? 'App API request failed.';
      if (response.status === 404) {
        throw new ReadOnlyMcpToolError('NOT_FOUND', message, { endpoint: path, httpStatus: response.status });
      }

      const code = path.includes('/stock/search')
        ? mapStockSearchStatus(response.status, payload)
        : 'API_ERROR';
      const diagnostics = getDiagnosticsFromUnknown(payload);
      throw new ReadOnlyMcpToolError(code, message, {
        endpoint: path,
        httpStatus: response.status,
        apiCode: getCodeFromUnknown(payload),
        ...(diagnostics ? { diagnostics } : {})
      });
    }

    return payload;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const payload = (await this.request('/api/projects')) as ProjectsListPayload;
    if (!Array.isArray(payload.projects)) {
      throw new ReadOnlyMcpToolError('API_ERROR', 'Invalid projects response payload.', { endpoint: '/api/projects' });
    }
    return payload.projects;
  }

  async getProject(projectId: string): Promise<Project> {
    const payload = (await this.request(`/api/projects/${encodeURIComponent(projectId)}`)) as ProjectPayload;
    if (!payload.project) {
      throw new ReadOnlyMcpToolError('API_ERROR', 'Invalid project response payload.', {
        endpoint: '/api/projects/:id',
        projectId
      });
    }
    return payload.project;
  }

  async getValidationReport(projectId: string): Promise<ProjectValidationReport> {
    const payload = (await this.request(`/api/projects/${encodeURIComponent(projectId)}/validation-report`)) as ValidationReportPayload;
    if (!payload.report) {
      throw new ReadOnlyMcpToolError('API_ERROR', 'Invalid validation report payload.', {
        endpoint: '/api/projects/:id/validation-report',
        projectId
      });
    }
    return payload.report;
  }

  async getProductionPlan(projectId: string): Promise<ProductionPlanReport> {
    const payload = (await this.request(`/api/projects/${encodeURIComponent(projectId)}/production-plan`)) as ProductionPlanPayload;
    if (!payload.report) {
      throw new ReadOnlyMcpToolError('API_ERROR', 'Invalid production plan payload.', {
        endpoint: '/api/projects/:id/production-plan',
        projectId
      });
    }
    return payload.report;
  }

  async getGenerationJob(projectId: string, attemptId: string): Promise<GetGenerationJobResponse> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/generation-jobs/${encodeURIComponent(attemptId)}`;
    const payload = (await this.request(path)) as GenerationJobPayload;

    if (!payload.sceneId || !payload.generationAttemptId || typeof payload.status !== 'string' || typeof payload.provider !== 'string') {
      throw new ReadOnlyMcpToolError('API_ERROR', 'Invalid generation job response payload.', {
        endpoint: path,
        projectId,
        attemptId
      });
    }

    return {
      projectId,
      sceneId: payload.sceneId,
      generationAttemptId: payload.generationAttemptId,
      status: payload.status,
      assetId: payload.assetId,
      provider: payload.provider,
      model: payload.model,
      providerJobId: payload.providerJobId,
      providerStatus: payload.providerStatus,
      errorCode: payload.errorCode,
      errorMessage: payload.errorMessage,
      lastPolledAt: payload.lastPolledAt
    };
  }

  async getMandateStatus(projectId: string): Promise<GetMandateStatusResponse> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/mandates`;
    const payload = (await this.request(path)) as MandatePayload;
    if (!payload.mandate || typeof payload.live !== 'boolean') {
      throw new ReadOnlyMcpToolError('API_ERROR', 'Invalid mandate status response payload.', {
        endpoint: path,
        projectId
      });
    }
    return {
      projectId,
      live: payload.live,
      mandate: payload.mandate
    };
  }

  async listAnimationTemplates(): Promise<AnimationTemplateSummary[]> {
    const payload = (await this.request('/api/animation-templates')) as AnimationTemplatesPayload;
    if (!Array.isArray(payload.templates)) {
      throw new ReadOnlyMcpToolError('API_ERROR', 'Invalid animation templates response payload.', {
        endpoint: '/api/animation-templates'
      });
    }
    return payload.templates;
  }

  async searchStockPhotos(projectId: string, input: SearchStockPhotosInput): Promise<StockSearchResponse> {
    const params = new URLSearchParams({ query: input.query });
    if (input.orientation) {
      params.set('orientation', input.orientation);
    }
    if (input.providers && input.providers.length > 0) {
      params.set('providers', input.providers.join(','));
    }
    if (input.limit !== undefined) {
      params.set('limit', String(input.limit));
    }
    if (input.mode) {
      params.set('mode', input.mode);
    }

    const path = `/api/projects/${encodeURIComponent(projectId)}/stock/search?${params.toString()}`;
    const payload = (await this.request(path)) as Partial<StockSearchResponse>;
    if (
      typeof payload.searchId !== 'string' ||
      typeof payload.query !== 'string' ||
      typeof payload.cached !== 'boolean' ||
      !Array.isArray(payload.results) ||
      !Array.isArray(payload.diagnostics) ||
      !Array.isArray(payload.quota)
    ) {
      throw new ReadOnlyMcpToolError('API_ERROR', 'Invalid stock search response payload.', {
        endpoint: '/api/projects/:id/stock/search',
        projectId
      });
    }

    return {
      searchId: payload.searchId,
      query: payload.query,
      orientation: payload.orientation,
      cached: payload.cached,
      results: payload.results,
      diagnostics: payload.diagnostics,
      quota: payload.quota
    };
  }
}
