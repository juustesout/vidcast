import type { ProductionMandate } from '@/lib/types/mandate';

export interface MandateStatusPayload {
  mandate: ProductionMandate | null;
  live: boolean;
}

export interface MandateClientError {
  message: string;
  code?: string;
  httpStatus: number;
}

export type MandateClientResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: MandateClientError };

function parseBody(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function toError(body: Record<string, unknown>, httpStatus: number, fallback: string): MandateClientError {
  return {
    message: typeof body.message === 'string' && body.message.trim() ? body.message : fallback,
    code: typeof body.code === 'string' ? body.code : undefined,
    httpStatus
  };
}

function isMandate(value: unknown): value is ProductionMandate {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<ProductionMandate>;
  return typeof candidate.mandateId === 'string' && typeof candidate.projectId === 'string' && typeof candidate.status === 'string';
}

async function requestJson(input: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(input, init);
  const body = parseBody(await response.json().catch(() => ({})));
  return { status: response.status, body };
}

export function mandatePath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/mandates`;
}

export async function getMandateStatus(projectId: string): Promise<MandateClientResult<MandateStatusPayload>> {
  const { status, body } = await requestJson(mandatePath(projectId), { method: 'GET' });
  if (status === 404) {
    return { ok: true, status, data: { mandate: null, live: false } };
  }
  if (status < 200 || status >= 300 || !isMandate(body.mandate)) {
    return { ok: false, status, error: toError(body, status, 'Could not read the production mandate.') };
  }
  return {
    ok: true,
    status,
    data: {
      mandate: body.mandate,
      live: body.live === true
    }
  };
}

export async function issueProjectMandate(
  projectId: string,
  input: { brief?: string; ttlMs?: number } = {}
): Promise<MandateClientResult<MandateStatusPayload>> {
  const { status, body } = await requestJson(mandatePath(projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brief: input.brief,
      ttlMs: input.ttlMs
    })
  });
  if (status === 409) {
    const existing = await getMandateStatus(projectId);
    if (existing.ok && existing.data.live) {
      return existing;
    }
    return { ok: false, status, error: toError(body, status, 'An active production mandate already exists for this project.') };
  }
  if (status < 200 || status >= 300 || !isMandate(body.mandate)) {
    return { ok: false, status, error: toError(body, status, 'Could not issue a production mandate.') };
  }
  return {
    ok: true,
    status,
    data: {
      mandate: body.mandate,
      live: body.live === true || body.mandate.status === 'active'
    }
  };
}

export async function revokeProjectMandate(projectId: string): Promise<MandateClientResult<MandateStatusPayload>> {
  const { status, body } = await requestJson(mandatePath(projectId), { method: 'DELETE' });
  if (status < 200 || status >= 300 || !isMandate(body.mandate)) {
    return { ok: false, status, error: toError(body, status, 'Could not revoke the production mandate.') };
  }
  return {
    ok: true,
    status,
    data: {
      mandate: body.mandate,
      live: false
    }
  };
}
