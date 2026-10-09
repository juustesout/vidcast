import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { HeadlessProductionRunService, RunServiceError } from '../lib/production/run-service';
import type { Project } from '../lib/types/render';

function nowIso(): string {
  return new Date().toISOString();
}

function createProject(projectId: string): Project {
  const now = nowIso();
  return {
    id: projectId,
    title: `P11.4.1 Preflight ${projectId}`,
    description: '',
    durationTarget: 10,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 3,
        type: 'image',
        narration: { text: '' },
        visual: {
          kind: 'generated_image',
          generation: {
            id: 'gen-1',
            kind: 'image',
            status: 'planned',
            provider: 'openai',
            prompt: 'Controlled preflight probe',
            referenceIds: [],
            aspectRatio: '16:9',
            createdAt: now
          }
        },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ],
    assets: [],
    references: [],
    compositions: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    }
  };
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function parseProviders(input: unknown): { image?: 'fake' | 'openai'; video?: 'local' | 'openai'; narration?: 'fake' | 'elevenlabs' } | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const image = record.image === 'fake' || record.image === 'openai' ? record.image : undefined;
  const video = record.video === 'local' || record.video === 'openai' ? record.video : undefined;
  const narration = record.narration === 'fake' || record.narration === 'elevenlabs' ? record.narration : undefined;

  return {
    image,
    video,
    narration
  };
}

async function main(): Promise<void> {
  // Ensure ambient credentials never affect this harness.
  delete process.env.OPENAI_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;

  const projects = new Map<string, Project>();
  let runBatchExecutions = 0;

  const runService = new HeadlessProductionRunService(
    {
      maxConcurrentRuns: 1,
      runner: {
        maxIterations: 8,
        maxActionExecutions: 20,
        maxVideoPolls: 10,
        limits: {
          image_generate: 1,
          video_submit: 1,
          video_poll: 1,
          narration_generate: 1,
          scene_render: 1,
          final_compose: 1
        }
      },
      registry: {
        maxEventsPerRun: 200,
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
          return projects.get(projectId) ?? null;
        }
      },
      runBatch: async (input) => {
        runBatchExecutions += 1;
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

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'GET' && url === '/api/health') {
      json(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && url === '/api/debug/state') {
      json(res, 200, {
        runBatchExecutions,
        openAiKeyPresent: Boolean(process.env.OPENAI_API_KEY),
        elevenLabsKeyPresent: Boolean(process.env.ELEVENLABS_API_KEY)
      });
      return;
    }

    if (method === 'POST' && url === '/api/projects') {
      const projectId = `project_${randomUUID()}`;
      const project = createProject(projectId);
      projects.set(projectId, project);
      json(res, 201, { project });
      return;
    }

    const startMatch = /^\/api\/projects\/([^/]+)\/production-runs$/.exec(url);
    if (method === 'POST' && startMatch) {
      const projectId = startMatch[1];
      const body = await readJsonBody(req);

      try {
        const started = await runService.startOrReuseRun({
          projectId,
          policy: {
            mode: body.mode as 'mock' | 'real' | undefined,
            providers: parseProviders(body.providers)
          }
        });

        json(res, 202, {
          run: started.run,
          reused: started.reused,
          debug: { runBatchExecutions }
        });
        return;
      } catch (error) {
        if (error instanceof RunServiceError) {
          json(res, error.status, {
            message: error.message,
            code: error.code,
            details: error.details,
            debug: { runBatchExecutions }
          });
          return;
        }

        json(res, 500, {
          message: 'Unexpected harness failure.',
          code: 'INTERNAL_ERROR',
          debug: { runBatchExecutions }
        });
        return;
      }
    }

    json(res, 404, { message: 'Not found.' });
  });

  const requestedPort = Number.parseInt(process.env.P11_4_HARNESS_PORT ?? '0', 10);
  const port = Number.isFinite(requestedPort) ? requestedPort : 0;

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  process.stdout.write(`HARNESS_READY http://127.0.0.1:${actualPort}\n`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
