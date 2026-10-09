import http from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const workspaceRoot = path.resolve(import.meta.dirname, '..');

interface MockRunRecord {
  runId: string;
  projectId: string;
}

let server: http.Server;
let baseUrl: string;
const mockRun: MockRunRecord = {
  runId: 'run-stdio-1',
  projectId: 'project-stdio-1'
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'GET' && url === '/api/projects') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          projects: [
            {
              id: mockRun.projectId,
              title: 'STDIO MCP Project',
              description: 'stub',
              sceneCount: 1,
              assetCount: 0,
              referenceCount: 0,
              durationTarget: 10,
              updatedAt: new Date().toISOString()
            }
          ]
        })
      );
      return;
    }

    if (method === 'GET' && url === `/api/projects/${mockRun.projectId}`) {
      const now = new Date().toISOString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          project: {
            id: mockRun.projectId,
            title: 'STDIO MCP Project',
            description: 'stub',
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
                type: 'blank',
                narration: { text: '' },
                visual: { kind: 'blank' },
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
          }
        })
      );
      return;
    }

    if (method === 'GET' && url === `/api/projects/${mockRun.projectId}/validation-report`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          report: {
            projectId: mockRun.projectId,
            generatedAt: new Date().toISOString(),
            validation: { valid: true, errorCount: 0, warningCount: 0, errors: [], warnings: [] },
            workflow: { recommendedStepId: 'final_render', blockedSteps: [], steps: [] },
            renderPlan: { ready: true, sceneCount: 1, renderableSceneCount: 1, plannedSceneCount: 0, invalidSceneCount: 0, issueCount: 0 },
            scenes: [],
            composition: {
              canCompose: true,
              needsSceneRenderIds: [],
              staleSceneIds: [],
              blockingSceneIds: [],
              invalidNarrationAudioSceneIds: [],
              artifactStatus: 'missing',
              artifactReasons: []
            },
            blockers: []
          }
        })
      );
      return;
    }

    if (method === 'GET' && url === `/api/projects/${mockRun.projectId}/production-plan`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          report: {
            projectId: mockRun.projectId,
            generatedAt: new Date().toISOString(),
            plan: {
              actions: [],
              summary: { ready: 0, running: 0, current: 0, failed: 0, waiting: 0, blocked: 0, skipped: 0 }
            },
            groupedByScene: [],
            derivedFlags: { hasBlockingActions: false, hasWaitingDependencies: false, readyActionCount: 0 }
          }
        })
      );
      return;
    }

    if (method === 'POST' && url === `/api/projects/${mockRun.projectId}/production-runs`) {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          reused: false,
          run: {
            runId: mockRun.runId,
            projectId: mockRun.projectId,
            status: 'running',
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            summary: { completed: 0, failed: 0, running: 1, waiting: 0 },
            completedActionIds: [],
            failedActionIds: [],
            unresolvedActions: [],
            acceptedConfig: {
              policy: {
                mode: 'mock',
                allowRealProviders: false,
                providers: { image: 'fake', video: 'local', narration: 'fake' }
              },
              limits: {
                maxIterations: 24,
                maxActionExecutions: 100,
                maxVideoPolls: 40,
                perActionConcurrency: {
                  image_generate: 2,
                  video_submit: 2,
                  video_poll: 4,
                  narration_generate: 2,
                  scene_render: 1,
                  final_compose: 1
                }
              }
            }
          }
        })
      );
      return;
    }

    if (method === 'GET' && url === `/api/production-runs/${mockRun.runId}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          run: {
            runId: mockRun.runId,
            projectId: mockRun.projectId,
            status: 'completed',
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            summary: { completed: 2, failed: 0, running: 0, waiting: 0 },
            completedActionIds: ['a1', 'a2'],
            failedActionIds: [],
            unresolvedActions: [],
            acceptedConfig: {
              policy: {
                mode: 'mock',
                allowRealProviders: false,
                providers: { image: 'fake', video: 'local', narration: 'fake' }
              },
              limits: {
                maxIterations: 24,
                maxActionExecutions: 100,
                maxVideoPolls: 40,
                perActionConcurrency: {
                  image_generate: 2,
                  video_submit: 2,
                  video_poll: 4,
                  narration_generate: 2,
                  scene_render: 1,
                  final_compose: 1
                }
              }
            }
          }
        })
      );
      return;
    }

    if (method === 'GET' && url.startsWith(`/api/production-runs/${mockRun.runId}/log`)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          log: {
            runId: mockRun.runId,
            cursor: 0,
            nextCursor: 1,
            hasMore: false,
            items: [
              {
                cursor: 0,
                event: {
                  timestamp: new Date().toISOString(),
                  iteration: 1,
                  code: 'run_started',
                  status: 'started',
                  message: 'Production run started.'
                }
              }
            ]
          }
        })
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not found.' }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('stdio MCP transport integration', () => {
  it('invokes read-only and production tools over stdio transport', async () => {
    const client = new Client(
      { name: 'p11.4-transport-test-client', version: '0.1.0' },
      { capabilities: {} }
    );

    const transport = new StdioClientTransport({
      command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['run', 'mcp:local'],
      cwd: workspaceRoot,
      env: {
        ...process.env,
        EXPLAINER_API_BASE_URL: baseUrl
      },
      stderr: 'pipe'
    });

    await client.connect(transport);

    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name);

    expect(toolNames).toContain('list_projects');
    expect(toolNames).toContain('run_production');
    expect(toolNames).toContain('get_run_status');
    expect(toolNames).toContain('get_run_log');

    const start = await client.callTool({
      name: 'run_production',
      arguments: {
        projectId: mockRun.projectId,
        mode: 'mock'
      }
    });

    expect(start.isError).toBeFalsy();
    const startContent = start.structuredContent as { ok: boolean; data?: { run?: { runId?: string } } };
    expect(startContent.ok).toBe(true);
    expect(startContent.data?.run?.runId).toBe(mockRun.runId);

    const status = await client.callTool({
      name: 'get_run_status',
      arguments: {
        runId: mockRun.runId
      }
    });

    expect(status.isError).toBeFalsy();

    const log = await client.callTool({
      name: 'get_run_log',
      arguments: {
        runId: mockRun.runId,
        cursor: 0,
        limit: 5
      }
    });

    expect(log.isError).toBeFalsy();

    await client.close();
  }, 20000);
});
