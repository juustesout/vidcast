import type { HeadlessRunLogPage, HeadlessRunSnapshot, RunMode } from '@/lib/production/run-types';
import type { ProductionActionType } from '@/lib/production/production-planner';
import { ProductionMcpToolError } from './errors';

interface ApiErrorPayload {
  message?: string;
  code?: string;
  details?: Record<string, unknown>;
}

interface StartRunPayload {
  run?: HeadlessRunSnapshot;
  reused?: boolean;
}

interface RunPayload {
  run?: HeadlessRunSnapshot;
}

interface LogPayload {
  log?: HeadlessRunLogPage;
}

export interface StartRunRequestPayload {
  mode?: RunMode;
  providers?: {
    image?: 'fake' | 'openai';
    video?: 'local' | 'openai';
    narration?: 'fake' | 'elevenlabs';
  };
  maxIterations?: number;
  limits?: Partial<Record<ProductionActionType, number>>;
}

export interface ProductionApiClient {
  runProduction(projectId: string, payload?: StartRunRequestPayload): Promise<{ run: HeadlessRunSnapshot; reused: boolean }>;
  getRunStatus(runId: string): Promise<HeadlessRunSnapshot>;
  getRunLog(runId: string, options?: { cursor?: number; limit?: number }): Promise<HeadlessRunLogPage>;
}

export interface HttpProductionApiClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

function parseMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const candidate = payload as ApiErrorPayload;
  return typeof candidate.message === 'string' ? candidate.message : undefined;
}

function parseCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const candidate = payload as ApiErrorPayload;
  return typeof candidate.code === 'string' ? candidate.code : undefined;
}

function parseDetails(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const candidate = payload as ApiErrorPayload;
  return candidate.details;
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

function mapStatusToCode(status: number, payload: unknown): 'NOT_FOUND' | 'POLICY_DENIED' | 'PROVIDER_NOT_CONFIGURED' | 'CONFLICT' | 'INVALID_ARGUMENT' | 'API_ERROR' {
  const explicit = parseCode(payload);
  if (explicit === 'NOT_FOUND') {
    return 'NOT_FOUND';
  }
  if (explicit === 'POLICY_DENIED') {
    return 'POLICY_DENIED';
  }
  if (explicit === 'PROVIDER_NOT_CONFIGURED') {
    return 'PROVIDER_NOT_CONFIGURED';
  }
  if (explicit === 'CONFLICT') {
    return 'CONFLICT';
  }
  if (explicit === 'INVALID_ARGUMENT') {
    return 'INVALID_ARGUMENT';
  }

  if (status === 404) {
    return 'NOT_FOUND';
  }
  if (status === 400) {
    return 'INVALID_ARGUMENT';
  }
  if (status === 403) {
    return 'POLICY_DENIED';
  }
  if (status === 409) {
    return 'CONFLICT';
  }

  return 'API_ERROR';
}

export class HttpProductionApiClient implements ProductionApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiToken: string | null;

  constructor(options: HttpProductionApiClientOptions = {}) {
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

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        ...init,
        headers: this.withAuthHeaders(init.headers)
      });
    } catch {
      throw new ProductionMcpToolError('API_UNAVAILABLE', 'Explainer app API is not reachable.', { endpoint: path });
    }

    const payload = await parseJson(response);
    if (!response.ok) {
      const code = mapStatusToCode(response.status, payload);
      throw new ProductionMcpToolError(code, parseMessage(payload) ?? 'App API request failed.', {
        endpoint: path,
        httpStatus: response.status,
        apiCode: parseCode(payload),
        ...parseDetails(payload)
      });
    }

    return payload;
  }

  async runProduction(projectId: string, payload: StartRunRequestPayload = {}): Promise<{ run: HeadlessRunSnapshot; reused: boolean }> {
    const response = (await this.request(`/api/projects/${encodeURIComponent(projectId)}/production-runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(payload)
    })) as StartRunPayload;

    if (!response.run || typeof response.reused !== 'boolean') {
      throw new ProductionMcpToolError('API_ERROR', 'Invalid run start response payload.', {
        endpoint: '/api/projects/:id/production-runs',
        projectId
      });
    }

    return {
      run: response.run,
      reused: response.reused
    };
  }

  async getRunStatus(runId: string): Promise<HeadlessRunSnapshot> {
    const response = (await this.request(`/api/production-runs/${encodeURIComponent(runId)}`, {
      method: 'GET',
      headers: {
        accept: 'application/json'
      }
    })) as RunPayload;

    if (!response.run) {
      throw new ProductionMcpToolError('API_ERROR', 'Invalid run status response payload.', {
        endpoint: '/api/production-runs/:runId',
        runId
      });
    }

    return response.run;
  }

  async getRunLog(runId: string, options: { cursor?: number; limit?: number } = {}): Promise<HeadlessRunLogPage> {
    const query = new URLSearchParams();
    if (typeof options.cursor === 'number') {
      query.set('cursor', String(options.cursor));
    }
    if (typeof options.limit === 'number') {
      query.set('limit', String(options.limit));
    }

    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const response = (await this.request(`/api/production-runs/${encodeURIComponent(runId)}/log${suffix}`, {
      method: 'GET',
      headers: {
        accept: 'application/json'
      }
    })) as LogPayload;

    if (!response.log) {
      throw new ProductionMcpToolError('API_ERROR', 'Invalid run log response payload.', {
        endpoint: '/api/production-runs/:runId/log',
        runId
      });
    }

    return response.log;
  }
}
