import { afterEach, describe, expect, it, vi } from 'vitest';

import { getMandateStatus, issueProjectMandate, mandatePath, revokeProjectMandate } from '@/lib/client/mandate-client';
import type { ProductionMandate } from '@/lib/types/mandate';

function mandate(overrides: Partial<ProductionMandate> = {}): ProductionMandate {
  return {
    mandateId: 'mandate_1',
    projectId: 'project-1',
    issuedBy: 'user-a',
    issuedAt: '2026-10-25T00:00:00.000Z',
    expiresAt: '2026-10-26T00:00:00.000Z',
    status: 'active',
    brief: 'Finish this video',
    allowedActions: ['run_production'],
    ...overrides
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mandate client', () => {
  it('reads GET /api/projects/:id/mandates and treats 404 as no mandate', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(mandatePath('project-1'));
      return jsonResponse(404, { message: 'No production mandate exists for this project.', code: 'MANDATE_NOT_FOUND' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getMandateStatus('project-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.mandate).toBeNull();
      expect(result.data.live).toBe(false);
    }
  });

  it('issues a mandate through POST and treats an active 409 as the existing live mandate', async () => {
    const created = mandate();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        return jsonResponse(201, { mandate: created });
      }
      return jsonResponse(200, { mandate: created, live: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const issued = await issueProjectMandate('project-1', { brief: 'Finish this video' });
    expect(issued.ok).toBe(true);
    if (issued.ok) {
      expect(issued.data.live).toBe(true);
      expect(issued.data.mandate?.mandateId).toBe('mandate_1');
    }

    const conflictFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return jsonResponse(409, { message: 'An active production mandate already exists for this project.', code: 'MANDATE_CONFLICT' });
      }
      return jsonResponse(200, { mandate: created, live: true });
    });
    vi.stubGlobal('fetch', conflictFetch);

    const conflict = await issueProjectMandate('project-1', { brief: 'Finish this video' });
    expect(conflict.ok).toBe(true);
    if (conflict.ok) {
      expect(conflict.data.live).toBe(true);
      expect(conflict.data.mandate?.mandateId).toBe('mandate_1');
    }
    expect(conflictFetch).toHaveBeenCalledTimes(2);
  });

  it('revokes through DELETE and never reports the revoked mandate as live', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      jsonResponse(200, { mandate: mandate({ status: 'revoked', revokedAt: '2026-10-25T01:00:00.000Z' }) })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await revokeProjectMandate('project-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.live).toBe(false);
      expect(result.data.mandate?.status).toBe('revoked');
    }
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
  });
});
