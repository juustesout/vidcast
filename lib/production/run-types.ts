import type { ProductionActionType, ProductionPlannedAction } from './production-planner';
import type { ProductionRunnerEvent, ProductionRunnerResultStatus } from './production-runner';

export type RunMode = 'mock' | 'real';

export type ImageRunProvider = 'fake' | 'openai';
export type VideoRunProvider = 'local' | 'openai';
export type NarrationRunProvider = 'fake' | 'elevenlabs';
export type MusicRunProvider = 'fake' | 'elevenlabs';

export interface RunProviderSelection {
  image: ImageRunProvider;
  video: VideoRunProvider;
  narration: NarrationRunProvider;
  music: MusicRunProvider;
}

export interface RunPolicySnapshot {
  mode: RunMode;
  allowRealProviders: boolean;
  providers: RunProviderSelection;
  // When set, the planner treats already-current outputs as stale so the run
  // regenerates them once (used to refresh assets that were produced in mock
  // mode even though a real run was requested). Optional for backward
  // compatibility with runs persisted before this field existed.
  force?: boolean;
}

export interface RunExecutionLimits {
  maxIterations: number;
  maxActionExecutions: number;
  maxVideoPolls: number;
  perActionConcurrency: Record<ProductionActionType, number>;
}

export interface HeadlessRunAcceptedConfig {
  policy: RunPolicySnapshot;
  limits: RunExecutionLimits;
}

export type HeadlessRunStatus = 'queued' | 'running' | ProductionRunnerResultStatus;

export interface HeadlessRunSummary {
  completed: number;
  failed: number;
  running: number;
  waiting: number;
}

export interface HeadlessRunSnapshot {
  runId: string;
  projectId: string;
  status: HeadlessRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  summary: HeadlessRunSummary;
  completedActionIds: string[];
  failedActionIds: string[];
  unresolvedActions: ProductionPlannedAction[];
  acceptedConfig: HeadlessRunAcceptedConfig;
}

export interface HeadlessRunLogItem {
  cursor: number;
  event: ProductionRunnerEvent;
}

export interface HeadlessRunLogPage {
  runId: string;
  cursor: number;
  nextCursor: number;
  hasMore: boolean;
  items: HeadlessRunLogItem[];
}
