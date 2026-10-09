import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const workspaceRoot = path.resolve(import.meta.dirname, '..');

let harnessProcess: ReturnType<typeof spawn> | null = null;
let harnessBaseUrl = '';
let harnessStderr = '';

async function startHarness(): Promise<void> {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npx tsx scripts/p11.4.1-credential-harness-server.ts']
    : ['tsx', 'scripts/p11.4.1-credential-harness-server.ts'];
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.ELEVENLABS_API_KEY;
  env.P11_4_HARNESS_PORT = '0';

  harnessProcess = spawn(command, args, {
    cwd: workspaceRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const stdout = harnessProcess.stdout;
  const stderr = harnessProcess.stderr;
  if (!stdout || !stderr) {
    throw new Error('Harness process stdio streams are unavailable.');
  }

  stderr.on('data', (chunk) => {
    harnessStderr += chunk.toString();
    if (harnessStderr.length > 8000) {
      harnessStderr = harnessStderr.slice(-8000);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Harness startup timeout. stderr=${harnessStderr.trim()}`)), 20000);
    const rl = readline.createInterface({ input: stdout });

    rl.on('line', (line) => {
      if (line.startsWith('HARNESS_READY ')) {
        harnessBaseUrl = line.slice('HARNESS_READY '.length).trim();
        clearTimeout(timeout);
        rl.close();
        resolve();
      }
    });

    harnessProcess!.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Harness exited before ready (code=${code}). stderr=${harnessStderr.trim()}`));
    });
  });
}

async function stopHarness(): Promise<void> {
  if (!harnessProcess) {
    return;
  }

  const processToStop = harnessProcess;
  harnessProcess = null;

  if (!processToStop.killed) {
    processToStop.kill();
  }

  await new Promise<void>((resolve) => {
    processToStop.once('exit', () => resolve());
  });
}

beforeAll(async () => {
  await startHarness();
});

afterAll(async () => {
  await stopHarness();
});

describe('MCP fail-closed credential preflight over stdio', () => {
  it('rejects real-provider run with PROVIDER_NOT_CONFIGURED before execution', async () => {
    const projectResponse = await fetch(`${harnessBaseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'credential-test' })
    });
    const projectPayload = (await projectResponse.json()) as { project?: { id: string } };
    expect(projectResponse.ok).toBe(true);
    expect(projectPayload.project?.id).toBeTruthy();

    const client = new Client(
      { name: 'p11.4.1-credential-test-client', version: '0.1.0' },
      { capabilities: {} }
    );

    const transport = new StdioClientTransport({
      command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['run', 'mcp:local'],
      cwd: workspaceRoot,
      env: {
        ...process.env,
        EXPLAINER_API_BASE_URL: harnessBaseUrl
      },
      stderr: 'pipe'
    });

    await client.connect(transport);

    try {
      const runResponse = await client.callTool({
        name: 'run_production',
        arguments: {
          projectId: projectPayload.project!.id,
          mode: 'real',
          providers: {
            image: 'openai',
            video: 'openai',
            narration: 'elevenlabs'
          }
        }
      });

      const envelope = runResponse.structuredContent as {
        ok: boolean;
        error?: { code?: string; message?: string };
      };

      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
      expect(envelope.error?.message).toMatch(/OPENAI_API_KEY|ELEVENLABS_API_KEY/i);

      const debugResponse = await fetch(`${harnessBaseUrl}/api/debug/state`);
      const debugPayload = (await debugResponse.json()) as {
        runBatchExecutions: number;
        openAiKeyPresent: boolean;
        elevenLabsKeyPresent: boolean;
      };

      expect(debugPayload.openAiKeyPresent).toBe(false);
      expect(debugPayload.elevenLabsKeyPresent).toBe(false);
      expect(debugPayload.runBatchExecutions).toBe(0);
    } finally {
      await client.close();
    }
  }, 30000);
});
