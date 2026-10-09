import { spawn } from 'node:child_process';

export interface ProcessExecutionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ProcessExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class ProcessExecutionError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, command: string, args: string[], stdout: string, stderr: string, exitCode?: number) {
    super(message);
    this.name = 'ProcessExecutionError';
    this.command = command;
    this.args = args;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export async function runProcess(command: string, args: string[], options: ProcessExecutionOptions = {}): Promise<ProcessExecutionResult> {
  return new Promise<ProcessExecutionResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (error: ProcessExecutionError | null, result?: ProcessExecutionResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(result!);
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
    }

    child.on('error', (error) => {
      finish(new ProcessExecutionError(error.message, command, args, stdout, stderr));
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(null, { exitCode: 0, stdout, stderr });
        return;
      }

      const message = signal ? `${command} terminated by signal ${signal}.` : `${command} exited with code ${code ?? -1}.`;
      finish(new ProcessExecutionError(message, command, args, stdout, stderr, code ?? undefined));
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new ProcessExecutionError(`${command} timed out after ${options.timeoutMs}ms.`, command, args, stdout, stderr));
      }, options.timeoutMs);
    }
  });
}
