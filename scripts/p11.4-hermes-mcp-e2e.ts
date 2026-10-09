import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface ToolResultEnvelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

interface McpCallResult {
  envelope: ToolResultEnvelope;
  isError?: boolean;
}

interface ScenarioResult {
  successRunId: string;
  duplicateReused: boolean;
  finalSuccessStatus: string;
  failedRunStatus: string;
  failedActionCount: number;
  realModeRejectedCode: string;
  missingCredentialsRejectedCode: string;
  missingCredentialsMessage: string;
  missingCredentialsRunBatchExecutions: number;
  toolPresence: string[];
  logPageSample: {
    firstPageCount: number;
    secondPageCount: number;
    hasMoreAfterSecond: boolean;
  };
}

const workspaceRoot = path.resolve(import.meta.dirname, '..');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<McpCallResult> {
  const response = await client.callTool({ name, arguments: args });
  const structured = (response.structuredContent ?? {}) as Record<string, unknown>;

  const envelope = structured as unknown as ToolResultEnvelope;
  if (!envelope || typeof envelope.ok !== 'boolean') {
    throw new Error(`Tool ${name} did not return the expected envelope.`);
  }

  return {
    envelope,
    isError: Boolean(response.isError)
  };
}

async function connectMcp(baseUrl: string): Promise<Client> {
  const client = new Client(
    { name: 'p11.4-e2e-client', version: '0.1.0' },
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
  return client;
}

async function startCredentialHarness(): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npx tsx scripts/p11.4.1-credential-harness-server.ts']
    : ['tsx', 'scripts/p11.4.1-credential-harness-server.ts'];
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.ELEVENLABS_API_KEY;
  env.P11_4_HARNESS_PORT = '0';

  const child = spawn(command, args, {
    cwd: workspaceRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let readyUrl: string | undefined;
  let stderrTail = '';
  const rl = readline.createInterface({ input: child.stdout });

  child.stderr.on('data', (chunk) => {
    stderrTail += chunk.toString();
    if (stderrTail.length > 8000) {
      stderrTail = stderrTail.slice(-8000);
    }
  });

  const waitReady = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Credential harness did not become ready in time. stderr=${stderrTail.trim()}`));
    }, 20_000);

    rl.on('line', (line) => {
      if (line.startsWith('HARNESS_READY ')) {
        readyUrl = line.slice('HARNESS_READY '.length).trim();
        clearTimeout(timeout);
        resolve();
      }
    });

    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Credential harness exited before readiness (code=${code}). stderr=${stderrTail.trim()}`));
    });
  });

  await waitReady;
  assert(readyUrl, 'Credential harness did not return a base URL.');

  return {
    baseUrl: readyUrl,
    stop: async () => {
      rl.close();
      if (!child.killed) {
        child.kill();
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 2000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  };
}

async function createDisposableProject(baseUrl: string, title: string): Promise<{ id: string }> {
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, durationTarget: 6, fps: 30 })
  });

  const payload = (await response.json()) as { project?: { id: string } };
  assert(response.ok && payload.project?.id, 'Failed to create disposable project.');
  return { id: payload.project.id };
}

async function configureCompletableProject(baseUrl: string, projectId: string): Promise<void> {
  const fetchProject = await fetch(`${baseUrl}/api/projects/${projectId}`);
  const payload = (await fetchProject.json()) as { project?: any };
  assert(fetchProject.ok && payload.project, 'Failed to load project for success scenario setup.');

  const project = payload.project;
  const scene = project.scenes?.[0];
  assert(scene, 'Project has no scene for success setup.');

  scene.narration = {
    ...(scene.narration ?? {}),
    text: 'Deterministic mock narration for completion path validation.'
  };

  const update = await fetch(`${baseUrl}/api/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(project)
  });

  const updateBody = await update.text();
  assert(update.ok, `Failed to persist success scenario project update (status=${update.status}, body=${updateBody}).`);
}

async function configureFailingProject(baseUrl: string, projectId: string): Promise<void> {
  const fetchProject = await fetch(`${baseUrl}/api/projects/${projectId}`);
  const payload = (await fetchProject.json()) as { project?: any };
  assert(fetchProject.ok && payload.project, 'Failed to load project for failure scenario setup.');

  const project = payload.project;
  const scene = project.scenes?.[0];
  assert(scene, 'Project has no scene for failure setup.');

  const now = new Date().toISOString();
  const failingAssetId = `asset-missing-${Date.now()}`;

  project.assets = [
    ...(Array.isArray(project.assets) ? project.assets : []),
    {
      id: failingAssetId,
      type: 'image',
      status: 'available',
      provenance: 'imported',
      filename: 'missing-input.png',
      localPath: `assets/${failingAssetId}/missing-input.png`,
      mimeType: 'image/png',
      metadata: {},
      createdAt: now,
      updatedAt: now
    }
  ];

  scene.type = 'image';
  scene.visual = {
    kind: 'asset',
    assetId: failingAssetId
  };
  scene.referenceIds = [];

  const update = await fetch(`${baseUrl}/api/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(project)
  });

  const updateBody = await update.text();
  assert(update.ok, `Failed to persist failure scenario project update (status=${update.status}, body=${updateBody}).`);
}

async function pollUntilTerminal(client: Client, runId: string, timeoutMs = 180_000): Promise<Record<string, unknown>> {
  const terminal = new Set(['completed', 'partial', 'failed', 'unresolved']);
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const status = await callTool(client, 'get_run_status', { runId });
    assert(status.envelope.ok, `get_run_status failed while polling run ${runId}.`);

    const run = (status.envelope.data?.run ?? {}) as Record<string, unknown>;
    const runStatus = String(run.status ?? '');
    if (terminal.has(runStatus)) {
      return run;
    }

    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  throw new Error(`Run ${runId} did not reach terminal status within timeout.`);
}

async function collectPagedLogs(client: Client, runId: string): Promise<{ firstPageCount: number; secondPageCount: number; hasMoreAfterSecond: boolean }> {
  const first = await callTool(client, 'get_run_log', { runId, cursor: 0, limit: 5 });
  assert(first.envelope.ok, 'First log page retrieval failed.');

  const firstLog = (first.envelope.data?.log ?? {}) as Record<string, unknown>;
  const firstItems = Array.isArray(firstLog.items) ? firstLog.items : [];
  const nextCursor = Number(firstLog.nextCursor ?? 0);

  const second = await callTool(client, 'get_run_log', { runId, cursor: nextCursor, limit: 5 });
  assert(second.envelope.ok, 'Second log page retrieval failed.');

  const secondLog = (second.envelope.data?.log ?? {}) as Record<string, unknown>;
  const secondItems = Array.isArray(secondLog.items) ? secondLog.items : [];

  return {
    firstPageCount: firstItems.length,
    secondPageCount: secondItems.length,
    hasMoreAfterSecond: Boolean(secondLog.hasMore)
  };
}

async function runScenario(baseUrl: string): Promise<ScenarioResult> {
  const client = await connectMcp(baseUrl);

  try {
    const listedTools = await client.listTools();
    const names = listedTools.tools.map((entry) => entry.name).sort();

    const successProject = await createDisposableProject(baseUrl, `P11.4 Success ${Date.now()}`);
    await configureCompletableProject(baseUrl, successProject.id);

    const start = await callTool(client, 'run_production', { projectId: successProject.id, mode: 'mock' });
    assert(start.envelope.ok, `run_production (mock success path) failed: ${JSON.stringify(start.envelope.error)}`);

    const successRun = (start.envelope.data?.run ?? {}) as Record<string, unknown>;
    const successRunId = String(successRun.runId ?? '');
    assert(successRunId, 'run_production did not return a runId.');

    const duplicate = await callTool(client, 'run_production', { projectId: successProject.id, mode: 'mock' });
    assert(duplicate.envelope.ok, 'duplicate run_production call failed unexpectedly.');
    const duplicateReused = Boolean((duplicate.envelope.data?.reused ?? false) as boolean);

    const successTerminal = await pollUntilTerminal(client, successRunId);
    const successStatus = String(successTerminal.status ?? '');

    const logPageSample = await collectPagedLogs(client, successRunId);

    const failingProject = await createDisposableProject(baseUrl, `P11.4 Failure ${Date.now()}`);
    await configureFailingProject(baseUrl, failingProject.id);

    const failedStart = await callTool(client, 'run_production', { projectId: failingProject.id, mode: 'mock' });
    assert(failedStart.envelope.ok, `run_production (failure path) failed to start: ${JSON.stringify(failedStart.envelope.error)}`);

    const failedRun = (failedStart.envelope.data?.run ?? {}) as Record<string, unknown>;
    const failedRunId = String(failedRun.runId ?? '');
    assert(failedRunId, 'failure scenario run did not return a runId.');

    const failedTerminal = await pollUntilTerminal(client, failedRunId);
    const failedStatus = String(failedTerminal.status ?? '');
    const failedActionIds = Array.isArray(failedTerminal.failedActionIds) ? failedTerminal.failedActionIds : [];

    const realDenied = await callTool(client, 'run_production', {
      projectId: successProject.id,
      mode: 'real'
    });
    assert(!realDenied.envelope.ok, 'real-mode run unexpectedly succeeded without server opt-in.');

    const harness = await startCredentialHarness();
    const preflightProject = await createDisposableProject(harness.baseUrl, `P11.4 Preflight ${Date.now()}`);
    const preflightClient = await connectMcp(harness.baseUrl);
    let preflightErrorCode = 'UNKNOWN';
    let preflightErrorMessage = '';
    let preflightRunBatchExecutions = -1;
    try {
      const preflightFailure = await callTool(preflightClient, 'run_production', {
        projectId: preflightProject.id,
        mode: 'real',
        providers: {
          image: 'openai',
          video: 'openai',
          narration: 'elevenlabs'
        }
      });

      assert(!preflightFailure.envelope.ok, 'real-mode run unexpectedly succeeded in missing-credentials scenario.');
      preflightErrorCode = String(preflightFailure.envelope.error?.code ?? 'UNKNOWN');
      preflightErrorMessage = String(preflightFailure.envelope.error?.message ?? '');

      const debugResponse = await fetch(`${harness.baseUrl}/api/debug/state`);
      const debugPayload = (await debugResponse.json()) as { runBatchExecutions?: number };
      preflightRunBatchExecutions = Number(debugPayload.runBatchExecutions ?? -1);
      assert(preflightRunBatchExecutions === 0, 'Production action execution occurred during credential preflight rejection.');
    } finally {
      await preflightClient.close();
      await harness.stop();
    }

    return {
      successRunId,
      duplicateReused,
      finalSuccessStatus: successStatus,
      failedRunStatus: failedStatus,
      failedActionCount: failedActionIds.length,
      realModeRejectedCode: String(realDenied.envelope.error?.code ?? 'UNKNOWN'),
      missingCredentialsRejectedCode: preflightErrorCode,
      missingCredentialsMessage: preflightErrorMessage,
      missingCredentialsRunBatchExecutions: preflightRunBatchExecutions,
      toolPresence: names,
      logPageSample
    };
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const baseUrl = process.env.P11_4_BASE_URL ?? 'http://127.0.0.1:5555';

  const result = await runScenario(baseUrl);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
