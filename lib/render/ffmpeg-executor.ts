import { spawn } from 'node:child_process';

import { withFfmpegSlot, type FfmpegOperation } from './ffmpeg-limiter';

export type ProcessFailureReason = 'spawn_error' | 'timeout' | 'exit' | 'signal';

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

export interface ProcessExecutionErrorOptions {
  reason: ProcessFailureReason;
  exitCode?: number;
  signal?: NodeJS.Signals | null;
}

export class ProcessExecutionError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly reason: ProcessFailureReason;
  readonly signal: NodeJS.Signals | null;

  constructor(
    message: string,
    command: string,
    args: string[],
    stdout: string,
    stderr: string,
    options: ProcessExecutionErrorOptions
  ) {
    super(message);
    this.name = 'ProcessExecutionError';
    this.command = command;
    this.args = args;
    this.exitCode = options.exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.reason = options.reason;
    this.signal = options.signal ?? null;
  }

  /**
   * True only when the executable itself could not be started (e.g. ENOENT).
   * A timeout, non-zero exit, or signal is reported through `reason` instead so
   * callers never mistake a slow-but-present binary for a missing one.
   */
  get unavailable(): boolean {
    return this.reason === 'spawn_error';
  }
}

const KILL_GRACE_MS = 5_000;

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
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let killGraceTimeout: NodeJS.Timeout | undefined;

    const finish = (error: ProcessExecutionError | null, result?: ProcessExecutionResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (killGraceTimeout) {
        clearTimeout(killGraceTimeout);
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
      finish(new ProcessExecutionError(error.message, command, args, stdout, stderr, { reason: 'spawn_error' }));
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(
          new ProcessExecutionError(`${command} timed out after ${options.timeoutMs}ms.`, command, args, stdout, stderr, {
            reason: 'timeout',
            signal
          })
        );
        return;
      }

      if (code === 0) {
        finish(null, { exitCode: 0, stdout, stderr });
        return;
      }

      const reason: ProcessFailureReason = signal ? 'signal' : 'exit';
      const message = signal ? `${command} terminated by signal ${signal}.` : `${command} exited with code ${code ?? -1}.`;
      finish(new ProcessExecutionError(message, command, args, stdout, stderr, { reason, exitCode: code ?? undefined, signal }));
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        // Ask the child to terminate, then wait for its `close` event so the
        // failure is only surfaced after the process has actually exited.
        child.kill('SIGKILL');

        killGraceTimeout = setTimeout(() => {
          finish(
            new ProcessExecutionError(`${command} timed out after ${options.timeoutMs}ms (termination not confirmed).`, command, args, stdout, stderr, {
              reason: 'timeout'
            })
          );
        }, KILL_GRACE_MS);
      }, options.timeoutMs);
    }
  });
}


// Every local FFmpeg invocation must go through this wrapper. It acquires the
// process-global FFmpeg slot before spawning, so scene renders and composition
// subprocesses share one memory ceiling even when they belong to different runs
// or route instances. The queue wait is outside the process timeout: a render
// that waits for backpressure does not lose part of its FFmpeg timeout budget.
export async function runFfmpeg(
  command: string,
  args: string[],
  options: ProcessExecutionOptions = {},
  operation: FfmpegOperation = 'scene_render'
): Promise<ProcessExecutionResult> {
  return withFfmpegSlot(operation, () => runProcess(command, args, options));
}
