import type { Project } from '@/lib/types/render';
import type { ProjectSummary } from '@/lib/storage/project-store';
import type { ProjectValidationReport } from '@/lib/validation/project-validation-report';
import type { ProductionPlanReport } from '@/lib/production/production-plan-report';
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
}

export interface AppApiClient {
  listProjects(): Promise<ProjectSummary[]>;
  getProject(projectId: string): Promise<Project>;
  getValidationReport(projectId: string): Promise<ProjectValidationReport>;
  getProductionPlan(projectId: string): Promise<ProductionPlanReport>;
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

  constructor(options: HttpAppApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.EXPLAINER_API_BASE_URL ?? 'http://127.0.0.1:5555').replace(/\/$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private async request(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          accept: 'application/json'
        }
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

      throw new ReadOnlyMcpToolError('API_ERROR', message, {
        endpoint: path,
        httpStatus: response.status
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
}
