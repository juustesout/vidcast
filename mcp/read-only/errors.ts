import type { ReadOnlyMcpErrorCode, ReadOnlyMcpFailure, ReadOnlyMcpResult } from './types';

export class ReadOnlyMcpToolError extends Error {
  readonly code: ReadOnlyMcpErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ReadOnlyMcpErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ReadOnlyMcpToolError';
    this.code = code;
    this.details = details;
  }
}

export function toFailure(error: unknown): ReadOnlyMcpFailure {
  if (error instanceof ReadOnlyMcpToolError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    };
  }

  return {
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Unexpected internal error.'
    }
  };
}

export function toSuccess<T>(data: T): ReadOnlyMcpResult<T> {
  return {
    ok: true,
    data
  };
}
