import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stampHumanApproval } from '@/lib/explainer/human-approval';
import { HeadlessProductionRunService } from '@/lib/production/run-service';
import { bindProjectMandateRun, createProjectMandate, readProjectMandate, revokeProjectMandate, writeProjectMandate } from '@/lib/storage/mandate-store';
import type { Project } from '@/lib/types/render';

let originalCwd: string;
let tempRoot: string;

function withHumanApproval(project: Project): Project {
  const next: Project = {
    ...project,
    explainer: {
      brief: {
        topic: '',
        goal: '',
        audience: '',
        tone: '',
        targetDurationSeconds: project.durationTarget,
        notes: ''
      },
      story: {
        title: project.title,
        hook: '',
        script: '',
        beats: [],
        cta: '',
        notes: '',
        versions: []
      },
      sceneIntents: []
    }
  };
  next.explainer = {
    ...next.explainer!,
    humanApproval: stampHumanApproval(next, { subject: 'user_test' })
  };
  return next;
}

function createNarrationProject(id: string): Project {
  const now = new Date().toISOString();
  return withHumanApproval({
    id,
    title: 'Mandate run',
    description: '',
    durationTarget: 15,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    assets: [],
    references: [],
    compositions: [],
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 5,
        type: 'blank',
        narration: { text: 'Single spoken line' },
        visual: { kind: 'blank' },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ]
  });
}

function createService(project: Project, hold?: { resolve?: () => void }): HeadlessProductionRunService {
  return new HeadlessProductionRunService(
    {
      maxConcurrentRuns: 1,
      runner: {
        maxIterations: 5,
        maxActionExecutions: 5,
        maxVideoPolls: 5,
        limits: {
          image_generate: 1,
          stock_select: 1,
          video_submit: 1,
          video_poll: 1,
          narration_generate: 1,
          scene_render: 1,
          final_compose: 1
        }
      },
      registry: {
        maxEventsPerRun: 100,
        retentionMs: 60_000,
        maxLogPageLimit: 100
      },
      policy: {
        allowRealProviders: true,
        defaultMode: 'real'
      }
    },
    {
      store: {
        async getProject(projectId: string) {
          return projectId === project.id ? project : null;
        }
      },
      runBatch: async (input) => {
        if (hold) {
          await new Promise<void>((resolve) => {
            hold.resolve = resolve;
          });
        }
        return {
          status: 'completed',
          project: input.initialProject,
          iterations: 1,
          completedActionIds: [],
          failedActionIds: [],
          unresolvedActions: [],
          events: []
        };
      }
    }
  );
}

beforeEach(async () => {
  originalCwd = process.cwd();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'production-run-mandate-'));
  process.chdir(tempRoot);
  vi.stubEnv('ELEVENLABS_API_KEY', 'xi-test');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.chdir(originalCwd);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('production run mandate bind', () => {
  it('binds the first accepted real run to a live mandate', async () => {
    const project = createNarrationProject('project-bind');
    await createProjectMandate({ projectId: project.id, issuedBy: 'user_test' });
    const hold: { resolve?: () => void } = {};
    const service = createService(project, hold);

    const started = await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'real', providers: { narration: 'elevenlabs' } },
      identity: { kind: 'service', subject: 'service:api_token', authType: 'service_token' }
    });

    const mandate = await readProjectMandate(project.id);
    expect(started.reused).toBe(false);
    expect(mandate?.status).toBe('consumed');
    expect(mandate?.boundRunId).toBe(started.run.runId);

    hold.resolve?.();
  });

  it('reuses the bound run while the mandate is live', async () => {
    const project = createNarrationProject('project-reuse');
    await createProjectMandate({ projectId: project.id, issuedBy: 'user_test' });
    const hold: { resolve?: () => void } = {};
    const service = createService(project, hold);

    const first = await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'real', providers: { narration: 'elevenlabs' } },
      identity: { kind: 'service', subject: 'service:api_token', authType: 'service_token' }
    });
    const second = await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'real', providers: { narration: 'elevenlabs' } },
      identity: { kind: 'service', subject: 'service:api_token', authType: 'service_token' }
    });

    expect(second.reused).toBe(true);
    expect(second.run.runId).toBe(first.run.runId);
    hold.resolve?.();
  });

  it('refuses reuse after the mandate is revoked', async () => {
    const project = createNarrationProject('project-revoke');
    await createProjectMandate({ projectId: project.id, issuedBy: 'user_test' });
    const hold: { resolve?: () => void } = {};
    const service = createService(project, hold);

    await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'real', providers: { narration: 'elevenlabs' } },
      identity: { kind: 'service', subject: 'service:api_token', authType: 'service_token' }
    });
    await revokeProjectMandate(project.id);

    await expect(
      service.startOrReuseRun({
        projectId: project.id,
        policy: { mode: 'real', providers: { narration: 'elevenlabs' } },
        identity: { kind: 'service', subject: 'service:api_token', authType: 'service_token' }
      })
    ).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      status: 403
    });
    hold.resolve?.();
  });

  it('refuses reuse after the bound mandate expires mid-run', async () => {
    const project = createNarrationProject('project-expire');
    await createProjectMandate({ projectId: project.id, issuedBy: 'user_test', ttlMs: 60_000 });
    const hold: { resolve?: () => void } = {};
    const service = createService(project, hold);

    const started = await service.startOrReuseRun({
      projectId: project.id,
      policy: { mode: 'real', providers: { narration: 'elevenlabs' } },
      identity: { kind: 'service', subject: 'service:api_token', authType: 'service_token' }
    });
    expect(started.reused).toBe(false);

    const bound = await readProjectMandate(project.id);
    expect(bound?.boundRunId).toBe(started.run.runId);
    await writeProjectMandate({
      ...bound!,
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    });

    await expect(
      service.startOrReuseRun({
        projectId: project.id,
        policy: { mode: 'real', providers: { narration: 'elevenlabs' } },
        identity: { kind: 'service', subject: 'service:api_token', authType: 'service_token' }
      })
    ).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      status: 403
    });
    hold.resolve?.();
  });

  it('refuses a second real run id against an already bound mandate', async () => {
    const project = createNarrationProject('project-second');
    await createProjectMandate({ projectId: project.id, issuedBy: 'user_test' });
    await bindProjectMandateRun(project.id, 'run-existing');

    const service = createService(project);
    await expect(
      service.startOrReuseRun({
        projectId: project.id,
        policy: { mode: 'real', providers: { narration: 'elevenlabs' } },
        identity: { kind: 'service', subject: 'service:api_token', authType: 'service_token' }
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409
    });
  });
});
