import type { ProductionRunnerEvent, ProductionRunnerResultStatus } from './production-runner';

export interface ProductionLogSummary {
  completed: number;
  failed: number;
  running: number;
  waiting: number;
}

export type ProductionLogRunStatus = 'idle' | 'running' | ProductionRunnerResultStatus;

export interface ProductionLogExportInput {
  runStatus: ProductionLogRunStatus;
  events: ProductionRunnerEvent[];
  summary: ProductionLogSummary;
}

const EVENT_LABELS: Record<ProductionRunnerEvent['code'], string> = {
  run_started: 'RUN',
  plan_created: 'PLAN',
  action_scheduled: 'STEP',
  action_started: 'STEP',
  action_completed: 'STEP',
  action_failed: 'STEP',
  action_skipped: 'SKIP',
  action_waiting: 'WAIT',
  action_blocked: 'BLOCK',
  action_current: 'CUR',
  action_running: 'RUN',
  video_poll_scheduled: 'POLL',
  video_poll_completed: 'POLL',
  refresh_started: 'REFRESH',
  refresh_completed: 'REFRESH',
  composition_started: 'COMPOSE',
  composition_completed: 'COMPOSE',
  composition_failed: 'COMPOSE',
  run_completed: 'RUN',
  run_stopped_unresolved: 'RUN',
  run_failed: 'RUN'
};

const ACTION_LABELS: Record<NonNullable<ProductionRunnerEvent['actionType']>, string> = {
  image_generate: 'IMAGE',
  video_submit: 'VIDEO',
  video_poll: 'POLL',
  narration_generate: 'TTS',
  scene_render: 'RENDER',
  final_compose: 'COMPOSE'
};

function formatTime(iso: string): string {
  const value = new Date(iso);
  return value.toLocaleTimeString([], { hour12: false });
}

function eventLabel(event: ProductionRunnerEvent): string {
  if (event.actionType) {
    return ACTION_LABELS[event.actionType] ?? EVENT_LABELS[event.code];
  }
  return EVENT_LABELS[event.code] ?? 'EVENT';
}

function sanitizeValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

function serializeDiagnostics(event: ProductionRunnerEvent): string[] {
  const error = event.error;
  if (!error) {
    return [];
  }

  const lines: string[] = [];
  const add = (key: string, rawValue: unknown): void => {
    if (typeof rawValue === 'string' && rawValue.trim()) {
      lines.push(`                 ${key}=${sanitizeValue(rawValue)}`);
      return;
    }
    if (typeof rawValue === 'number') {
      lines.push(`                 ${key}=${String(rawValue)}`);
    }
  };

  add('message', error.message);
  add('code', error.code);
  add('status', error.httpStatus);
  add('provider_status', error.providerStatus);
  add('provider_error', error.providerError);
  add('endpoint', error.endpoint);
  add('attempt', error.attemptId);
  add('details', error.details);

  return lines;
}

function mapStatus(status: ProductionLogRunStatus): string {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'partial':
      return 'partial';
    case 'failed':
      return 'failed';
    case 'unresolved':
      return 'unresolved';
    case 'running':
      return 'running';
    case 'idle':
    default:
      return 'idle';
  }
}

export function formatProductionLogAsText(input: ProductionLogExportInput): string {
  const startedAt = input.events[0]?.timestamp;
  const finishedAt = input.events[input.events.length - 1]?.timestamp;

  const lines: string[] = [
    `Production run: ${mapStatus(input.runStatus)}`,
    `Started: ${startedAt ? formatTime(startedAt) : 'N/A'}`,
    `Finished: ${finishedAt ? formatTime(finishedAt) : 'N/A'}`,
    ''
  ];

  for (const event of input.events) {
    const label = eventLabel(event).padEnd(8, ' ');
    lines.push(`${formatTime(event.timestamp)} ${label} ${sanitizeValue(event.message)}`);
    lines.push(...serializeDiagnostics(event));
  }

  if (input.events.length === 0) {
    lines.push('No events recorded.');
  }

  lines.push('');
  lines.push('Summary:');
  lines.push(`Completed: ${input.summary.completed}`);
  lines.push(`Failed: ${input.summary.failed}`);
  lines.push(`Running: ${input.summary.running}`);
  lines.push(`Waiting: ${input.summary.waiting}`);

  return lines.join('\n');
}
