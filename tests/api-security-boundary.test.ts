import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as startRunRoute } from '@/app/api/projects/[id]/production-runs/route';
import { GET as runStatusRoute } from '@/app/api/production-runs/[runId]/route';
import { AccessControlError, clearThrottleStateForTests, enforceThrottle, requireProjectAccess } from '@/lib/security/access-control';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { headlessProductionRunService } from '@/lib/production/run-service';
import { projectStore } from '@/lib/storage/project-store';

function withSession(subject: string): string {
  return `${SESSION_COOKIE_NAME}=${createUserSessionCookie(subject)}`;
}

describe('security boundary helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearThrottleStateForTests();
    delete process.env.API_THROTTLE_RUN_START_LIMIT;
    delete process.env.API_THROTTLE_RUN_START_WINDOW_MS;
  });

  it('rejects unauthenticated access to project authorization', async () => {
    await expect(requireProjectAccess(new Request('http://localhost/api/projects/project-1'), 'project-1')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401
    });
  });

  it('denies authenticated users when project owner differs', async () => {
    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-1', ownerId: 'user-b' } as never);

    const request = new Request('http://localhost/api/projects/project-1', {
      headers: {
        cookie: withSession('user-a')
      }
    });

    await expect(requireProjectAccess(request, 'project-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404
    });
  });

  it('throttles by identity regardless of project identifier', () => {
    process.env.API_THROTTLE_RUN_START_LIMIT = '1';
    process.env.API_THROTTLE_RUN_START_WINDOW_MS = '60000';

    const identity = {
      kind: 'user' as const,
      subject: 'user-a',
      authType: 'session' as const
    };

    enforceThrottle(identity, 'run_start');

    expect(() => enforceThrottle(identity, 'run_start')).toThrowError(AccessControlError);
  });
});

describe('protected route behavior', () => {
  beforeEach(() => {
    clearThrottleStateForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearThrottleStateForTests();
    delete process.env.API_THROTTLE_RUN_START_LIMIT;
    delete process.env.API_THROTTLE_RUN_START_WINDOW_MS;
    delete process.env.API_THROTTLE_RUN_STATUS_LIMIT;
    delete process.env.API_THROTTLE_RUN_STATUS_WINDOW_MS;
  });

  it('blocks unauthenticated production-run start', async () => {
    const response = await startRunRoute(
      new Request('http://localhost/api/projects/project-1/production-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'mock' })
      }),
      { params: Promise.resolve({ id: 'project-1' }) }
    );

    expect(response.status).toBe(401);
  });

  it('starts production run for authorized project owner', async () => {
    vi.spyOn(projectStore, 'getProject').mockImplementation(async (projectId: string) => ({ id: projectId, ownerId: 'user-a' } as never));
    vi.spyOn(headlessProductionRunService, 'startOrReuseRun').mockResolvedValue({
      reused: false,
      run: {
        runId: 'run-1',
        projectId: 'project-1',
        status: 'running'
      }
    } as never);

    const response = await startRunRoute(
      new Request('http://localhost/api/projects/project-1/production-runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: withSession('user-a')
        },
        body: JSON.stringify({ mode: 'mock' })
      }),
      { params: Promise.resolve({ id: 'project-1' }) }
    );

    expect(response.status).toBe(202);
  });

  it('hides unauthorized project ownership on run start', async () => {
    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-1', ownerId: 'user-b' } as never);

    const response = await startRunRoute(
      new Request('http://localhost/api/projects/project-1/production-runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: withSession('user-a')
        },
        body: JSON.stringify({ mode: 'mock' })
      }),
      { params: Promise.resolve({ id: 'project-1' }) }
    );

    expect(response.status).toBe(404);
  });

  it('enforces run-status ownership via run project resolution', async () => {
    vi.spyOn(headlessProductionRunService, 'getRun').mockReturnValue({
      runId: 'run-1',
      projectId: 'project-2',
      status: 'running'
    } as never);
    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-2', ownerId: 'user-b' } as never);

    const unauthorized = await runStatusRoute(
      new Request('http://localhost/api/production-runs/run-1', {
        headers: {
          cookie: withSession('user-a')
        }
      }),
      { params: Promise.resolve({ runId: 'run-1' }) }
    );

    expect(unauthorized.status).toBe(404);

    const authorized = await runStatusRoute(
      new Request('http://localhost/api/production-runs/run-1', {
        headers: {
          cookie: withSession('user-b')
        }
      }),
      { params: Promise.resolve({ runId: 'run-1' }) }
    );

    expect(authorized.status).toBe(200);
  });

  it('returns 429 when run-start throttle limit is exceeded', async () => {
    process.env.API_THROTTLE_RUN_START_LIMIT = '1';
    process.env.API_THROTTLE_RUN_START_WINDOW_MS = '60000';

    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-1', ownerId: 'user-a' } as never);
    vi.spyOn(headlessProductionRunService, 'startOrReuseRun').mockResolvedValue({
      reused: true,
      run: {
        runId: 'run-1',
        projectId: 'project-1',
        status: 'running'
      }
    } as never);

    const first = await startRunRoute(
      new Request('http://localhost/api/projects/project-1/production-runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: withSession('user-a')
        },
        body: JSON.stringify({ mode: 'mock' })
      }),
      { params: Promise.resolve({ id: 'project-1' }) }
    );

    const second = await startRunRoute(
      new Request('http://localhost/api/projects/project-2/production-runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: withSession('user-a')
        },
        body: JSON.stringify({ mode: 'mock' })
      }),
      { params: Promise.resolve({ id: 'project-2' }) }
    );

    expect(first.status).toBeLessThan(400);
    expect(second.status).toBe(429);
  });
});
