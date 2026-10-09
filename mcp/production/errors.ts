import type { ProductionMcpErrorCode, ProductionMcpFailure, ProductionMcpResult } from './types';

export class ProductionMcpToolError extends Error {
  readonly code: ProductionMcpErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ProductionMcpErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ProductionMcpToolError';
    this.code = code;
    this.details = details;
  }
}

export function toFailure(error: unknown): ProductionMcpFailure {
  if (error instanceof ProductionMcpToolError) {
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

export function toSuccess<T>(data: T): ProductionMcpResult<T> {
  return {
    ok: true,
    data
  };
}
