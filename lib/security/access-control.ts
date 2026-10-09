import type { Project } from '@/lib/types/render';
import { projectStore } from '@/lib/storage/project-store';
import { getRequestIdentity, type RequestIdentity } from './auth';

interface ThrottleState {
  windowStartMs: number;
  count: number;
}

const throttleState = new Map<string, ThrottleState>();

export class AccessControlError extends Error {
  readonly code: 'UNAUTHENTICATED' | 'NOT_FOUND' | 'FORBIDDEN' | 'RATE_LIMITED';
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: 'UNAUTHENTICATED' | 'NOT_FOUND' | 'FORBIDDEN' | 'RATE_LIMITED',
    status: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AccessControlError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function nowMs(): number {
  return Date.now();
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function checkThrottle(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSec?: number } {
  const now = nowMs();
  const current = throttleState.get(key);
  if (!current || now - current.windowStartMs >= windowMs) {
    throttleState.set(key, { windowStartMs: now, count: 1 });
    return { allowed: true };
  }

  if (current.count >= limit) {
    const retryAfterMs = Math.max(0, windowMs - (now - current.windowStartMs));
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000))
    };
  }

  current.count += 1;
  return { allowed: true };
}

export function clearThrottleStateForTests(): void {
  throttleState.clear();
}

export function requireIdentity(request: Request): RequestIdentity {
  const identity = getRequestIdentity(request);
  if (!identity) {
    throw new AccessControlError('Authentication required.', 'UNAUTHENTICATED', 401);
  }
  return identity;
}

export async function requireProjectAccess(
  request: Request,
  projectId: string,
  options: { claimLegacyOwner?: boolean } = {}
): Promise<{ identity: RequestIdentity; project: Project }> {
  const identity = requireIdentity(request);
  const project = await projectStore.getProject(projectId);

  if (!project) {
    throw new AccessControlError('Project not found.', 'NOT_FOUND', 404);
  }

  if (identity.kind === 'service') {
    return { identity, project };
  }

  const ownerId = project.ownerId?.trim();
  if (!ownerId && options.claimLegacyOwner !== false) {
    const claimed = await projectStore.updateProject({
      ...project,
      ownerId: identity.subject
    });
    return { identity, project: claimed };
  }

  if (!ownerId || ownerId !== identity.subject) {
    // Return not-found semantics to avoid disclosing another user's project existence.
    throw new AccessControlError('Project not found.', 'NOT_FOUND', 404);
  }

  return { identity, project };
}

export function enforceThrottle(
  identity: RequestIdentity,
  bucket:
    | 'run_start'
    | 'run_status'
    | 'run_log'
    | 'generate_image'
    | 'generate_video'
    | 'generate_narration'
    | 'generate_music'
    | 'video_poll'
    | 'render_scene'
    | 'compose_project'
): void {
  const keyPrefix = `throttle:${bucket}:${identity.subject}`;

  const limits: Record<typeof bucket, { limit: number; windowMs: number }> = {
    run_start: {
      limit: envInt('API_THROTTLE_RUN_START_LIMIT', 6, 1, 10_000),
      windowMs: envInt('API_THROTTLE_RUN_START_WINDOW_MS', 60_000, 1_000, 24 * 60 * 60 * 1000)
    },
    run_status: {
      limit: envInt('API_THROTTLE_RUN_STATUS_LIMIT', 120, 1, 50_000),
      windowMs: envInt('API_THROTTLE_RUN_STATUS_WINDOW_MS', 60_000, 1_000, 24 * 60 * 60 * 1000)
    },
    run_log: {
      limit: envInt('API_THROTTLE_RUN_LOG_LIMIT', 120, 1, 50_000),
      windowMs: envInt('API_THROTTLE_RUN_LOG_WINDOW_MS', 60_000, 1_000, 24 * 60 * 60 * 1000)
    },
    generate_image: {
      limit: envInt('API_THROTTLE_GENERATE_IMAGE_LIMIT', 20, 1, 10_000),
      windowMs: envInt('API_THROTTLE_GENERATE_IMAGE_WINDOW_MS', 60_000, 1_000, 24 * 60 * 60 * 1000)
    },
    generate_video: {
      limit: envInt('API_THROTTLE_GENERATE_VIDEO_LIMIT', 12, 1, 10_000),
      windowMs: envInt('API_THROTTLE_GENERATE_VIDEO_WINDOW_MS', 60_000, 1_000, 24 * 60 * 60 * 1000)
    },
    generate_narration: {
      limit: envInt('API_THROTTLE_GENERATE_NARRATION_LIMIT', 20, 1, 10_000),
      windowMs: envInt('API_THROTTLE_GENERATE_NARRATION_WINDOW_MS', 60_000, 1_000, 24 * 60 * 60 * 1000)
    },
    generate_music: {
      limit: envInt('API_THROTTLE_GENERATE_MUSIC_LIMIT', 6, 1, 10_000),
      windowMs: envInt('API_THROTTLE_GENERATE_MUSIC_WINDOW_MS', 60_000, 1_000, 24 * 60 * 60 * 1000)
    },
    video_poll: {
      limit: envInt('API_THROTTLE_VIDEO_POLL_LIMIT', 180, 1, 50_000),
      windowMs: envInt('API_THROTTLE_VIDEO_POLL_WINDOW_MS', 60_000, 1_000, 24 * 60 * 60 * 1000)
    },
    render_scene: {
      limit: envInt('API_THROTTLE_RENDER_SCENE_LIMIT', 10, 1, 10_000),
      windowMs: envInt('API_THROTTLE_RENDER_SCENE_WINDOW_MS', 60_000, 1_000, 24 * 60 * 60 * 1000)
    },
    compose_project: {
      limit: envInt('API_THROTTLE_COMPOSE_PROJECT_LIMIT', 8, 1, 10_000),
      windowMs: envInt('API_THROTTLE_COMPOSE_PROJECT_WINDOW_MS', 60_000, 1_000, 24 * 60 * 60 * 1000)
    }
  };

  const policy = limits[bucket];
  const result = checkThrottle(keyPrefix, policy.limit, policy.windowMs);
  if (!result.allowed) {
    throw new AccessControlError(
      'Too many requests for this endpoint. Try again later.',
      'RATE_LIMITED',
      429,
      { retryAfterSec: result.retryAfterSec }
    );
  }
}
