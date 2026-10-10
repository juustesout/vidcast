import type { AuthoringMcpErrorCode, AuthoringMcpFailure, AuthoringMcpResult } from './types';

export class AuthoringMcpToolError extends Error {
  readonly code: AuthoringMcpErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: AuthoringMcpErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AuthoringMcpToolError';
    this.code = code;
    this.details = details;
  }
}

export function toFailure(error: unknown): AuthoringMcpFailure {
  if (error instanceof AuthoringMcpToolError) {
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

export function toSuccess<T>(data: T): AuthoringMcpResult<T> {
  return {
    ok: true,
    data
  };
}
