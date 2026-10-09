import type {
  HeadlessRunLogPage,
  HeadlessRunSnapshot,
  ImageRunProvider,
  NarrationRunProvider,
  VideoRunProvider,
  RunMode
} from '@/lib/production/run-types';

export interface StartProductionRunRequest {
  mode?: RunMode;
  providers?: {
    image?: ImageRunProvider;
    video?: VideoRunProvider;
    narration?: NarrationRunProvider;
  };
  maxIterations?: number;
  limits?: Partial<Record<'image_generate' | 'video_submit' | 'video_poll' | 'narration_generate' | 'scene_render' | 'final_compose', number>>;
}

export interface ProductionRunApiError {
  message: string;
  code?: string;
  details?: unknown;
  httpStatus: number;
}

export type ProductionRunApiResult<T> =
  | {
      ok: true;
      status: number;
      data: T;
    }
  | {
      ok: false;
      status: number;
      error: ProductionRunApiError;
    };

export interface StartProductionRunResponse {
  run: HeadlessRunSnapshot;
  reused: boolean;
}

export interface GetProductionRunResponse {
  run: HeadlessRunSnapshot;
}

export interface GetProductionRunLogResponse {
  log: HeadlessRunLogPage;
}

async function parseJsonBody(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as unknown;
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function toApiError(body: Record<string, unknown>, httpStatus: number, fallbackMessage: string): ProductionRunApiError {
  return {
    message: typeof body.message === 'string' && body.message.trim() ? body.message : fallbackMessage,
    code: typeof body.code === 'string' ? body.code : undefined,
    details: body.details,
    httpStatus
  };
}

async function requestJson<T>(input: string, init: RequestInit, fallbackMessage: string): Promise<ProductionRunApiResult<T>> {
  const response = await fetch(input, init);
  const body = await parseJsonBody(response);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: toApiError(body, response.status, fallbackMessage)
    };
  }

  return {
    ok: true,
    status: response.status,
    data: body as T
  };
}

export async function startProductionRun(projectId: string, payload: StartProductionRunRequest = {}): Promise<ProductionRunApiResult<StartProductionRunResponse>> {
  return requestJson<StartProductionRunResponse>(
    `/api/projects/${projectId}/production-runs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    },
    'Unexpected run start failure.'
  );
}

export async function getProductionRun(runId: string): Promise<ProductionRunApiResult<GetProductionRunResponse>> {
  return requestJson<GetProductionRunResponse>(
    `/api/production-runs/${runId}`,
    {
      method: 'GET'
    },
    'Unexpected run status failure.'
  );
}

export interface GetProductionRunLogRequest {
  cursor?: number;
  limit?: number;
}

export async function getProductionRunLog(runId: string, request: GetProductionRunLogRequest = {}): Promise<ProductionRunApiResult<GetProductionRunLogResponse>> {
  const searchParams = new URLSearchParams();

  if (typeof request.cursor === 'number') {
    searchParams.set('cursor', String(request.cursor));
  }

  if (typeof request.limit === 'number') {
    searchParams.set('limit', String(request.limit));
  }

  const query = searchParams.toString();

  return requestJson<GetProductionRunLogResponse>(
    `/api/production-runs/${runId}/log${query ? `?${query}` : ''}`,
    {
      method: 'GET'
    },
    'Unexpected run log failure.'
  );
}