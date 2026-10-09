import type { HeadlessRunLogPage, HeadlessRunSnapshot } from '@/lib/production/run-types';

export type ProductionMcpErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'POLICY_DENIED'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'CONFLICT'
  | 'API_UNAVAILABLE'
  | 'API_ERROR'
  | 'INTERNAL_ERROR';

export interface ProductionMcpError {
  code: ProductionMcpErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ProductionMcpSuccess<T> {
  ok: true;
  data: T;
}

export interface ProductionMcpFailure {
  ok: false;
  error: ProductionMcpError;
}

export type ProductionMcpResult<T> = ProductionMcpSuccess<T> | ProductionMcpFailure;

export interface StartRunResponse {
  run: HeadlessRunSnapshot;
  reused: boolean;
}

export interface GetRunStatusResponse {
  run: HeadlessRunSnapshot;
}

export interface GetRunLogResponse {
  log: HeadlessRunLogPage;
}
