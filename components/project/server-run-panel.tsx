'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import type { HeadlessRunLogItem, HeadlessRunSnapshot, HeadlessRunStatus } from '@/lib/production/run-types';
import { ProductionRunTracker, startServerRunFlow } from '@/lib/client/production-run-tracker';
import type { ProductionRunApiError } from '@/lib/client/production-run-client';

interface ServerRunPanelProps {
  projectId: string;
  onEnsureSaved: () => Promise<boolean>;
}

function formatRunEventTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

function formatProviderPolicy(run: HeadlessRunSnapshot): string {
  const { policy } = run.acceptedConfig;
  return `${policy.mode} | image:${policy.providers.image} | video:${policy.providers.video} | narration:${policy.providers.narration}`;
}

function formatServerRunStatus(status: HeadlessRunStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'partial':
      return 'Completed (partial)';
    case 'failed':
      return 'Failed';
    case 'unresolved':
      return 'Unresolved';
    default:
      return status;
  }
}

function formatErrorDetails(details: unknown): string | null {
  if (typeof details === 'string' && details.trim()) {
    return details;
  }

  if (details == null) {
    return null;
  }

  try {
    return JSON.stringify(details);
  } catch {
    return 'Unserializable details';
  }
}

function statusTone(status: HeadlessRunStatus | 'idle'): string {
  switch (status) {
    case 'queued':
    case 'running':
      return 'text-amber-200';
    case 'completed':
      return 'text-emerald-200';
    case 'partial':
    case 'unresolved':
      return 'text-amber-100';
    case 'failed':
      return 'text-rose-200';
    case 'idle':
    default:
      return 'text-slate-200';
  }
}

function ServerRunErrorCard({ error }: { error: ProductionRunApiError | null }) {
  const details = formatErrorDetails(error?.details);

  if (!error) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-3 text-xs text-rose-100">
      <p>{error.message}</p>
      {error.code ? <p className="mt-1">Code: {error.code}</p> : null}
      <p className="mt-1">HTTP: {error.httpStatus}</p>
      {details ? <p className="mt-1 break-words">Details: {details}</p> : null}
    </div>
  );
}

export function ServerRunPanel({ projectId, onEnsureSaved }: ServerRunPanelProps) {
  const trackerRef = useRef<ProductionRunTracker | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'tracking' | 'error'>('idle');
  const [trackerState, setTrackerState] = useState(() => new ProductionRunTracker().getState());
  const [runFeedback, setRunFeedback] = useState('');
  const [visibleEventCount, setVisibleEventCount] = useState(8);

  if (!trackerRef.current) {
    trackerRef.current = new ProductionRunTracker();
  }

  function clearScheduledPoll(): void {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  function syncTrackerState(): void {
    setTrackerState(trackerRef.current?.getState() ?? new ProductionRunTracker().getState());
  }

  function schedulePoll(delayMs: number): void {
    clearScheduledPoll();
    pollTimerRef.current = window.setTimeout(() => {
      void pollServerRun();
    }, delayMs);
  }

  async function catchUpLogs(): Promise<void> {
    const tracker = trackerRef.current;
    if (!tracker) {
      return;
    }

    const result = await tracker.loadAvailableLogPages();
    setTrackerState(result.state);

    if (result.kind === 'restart_lost') {
      setPhase('error');
      setRunFeedback('Tracked server run was lost after a restart or memory expiry.');
      clearScheduledPoll();
      return;
    }

    if (result.kind === 'transient_error') {
      setPhase('tracking');
      schedulePoll(result.nextDelayMs);
      return;
    }

    if (result.shouldContinue) {
      setPhase('tracking');
      schedulePoll(result.nextDelayMs);
      return;
    }

    if (result.state.run) {
      setPhase('tracking');
    }
  }

  async function pollServerRun(): Promise<void> {
    const tracker = trackerRef.current;
    if (!tracker) {
      return;
    }

    const result = await tracker.poll();
    setTrackerState(result.state);

    if (result.kind === 'restart_lost') {
      setPhase('error');
      setRunFeedback('Tracked server run was lost after a restart or memory expiry.');
      clearScheduledPoll();
      return;
    }

    if (result.kind === 'stale' || result.kind === 'skipped') {
      return;
    }

    if (result.shouldContinue) {
      setPhase('tracking');
      schedulePoll(result.nextDelayMs);
      return;
    }

    clearScheduledPoll();
    setPhase(result.state.run ? 'tracking' : 'idle');
  }

  async function handleStartServerRun(): Promise<void> {
    clearScheduledPoll();
    trackerRef.current?.invalidate();
    syncTrackerState();
    setPhase('starting');
    setRunFeedback('Saving project before starting server run...');

    const started = await startServerRunFlow({
      projectId,
      ensureSaved: onEnsureSaved
    });

    if (!started.ok) {
      if (started.blockedBySave) {
        setPhase('error');
        setRunFeedback('Could not save project before server run.');
        return;
      }

      setPhase('error');
      setRunFeedback(started.error?.message || 'Could not start server run.');
      setTrackerState((current) => ({
        ...current,
        lastError: started.error ?? null,
        transientError: null,
        restartLost: false
      }));
      return;
    }

    trackerRef.current?.trackRun(started.result.data.run);
    syncTrackerState();
    setVisibleEventCount(8);
    setRunFeedback(started.result.data.reused ? 'Reused active server run.' : 'Started new server run.');
    await catchUpLogs();
  }

  useEffect(() => {
    return () => {
      clearScheduledPoll();
      trackerRef.current?.invalidate();
    };
  }, []);

  useEffect(() => {
    clearScheduledPoll();
    trackerRef.current?.reset();
    syncTrackerState();
    setPhase('idle');
    setRunFeedback('');
    setVisibleEventCount(8);

    return () => {
      clearScheduledPoll();
      trackerRef.current?.invalidate();
    };
  }, [projectId]);

  const displayedEvents = useMemo(() => {
    return trackerState.logItems.slice(Math.max(0, trackerState.logItems.length - visibleEventCount)).reverse();
  }, [trackerState.logItems, visibleEventCount]);

  const canRevealOlderEvents = trackerState.logItems.length > visibleEventCount;
  const currentStatus = trackerState.run?.status ?? 'idle';

  return (
    <section className="rounded-2xl border border-slate-700/70 bg-slate-950/25 p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Server runner</p>
          <p className={`mt-1 text-sm ${statusTone(currentStatus)}`}>{currentStatus === 'idle' ? 'No tracked server run.' : formatServerRunStatus(currentStatus)}</p>
          <p className="mt-1 text-xs text-slate-400">Uses the local server-run API. These routes do not enforce per-user ownership.</p>
        </div>
        <button
          type="button"
          disabled={phase === 'starting'}
          onClick={() => void handleStartServerRun()}
          className="rounded-2xl border border-sky-300/40 bg-sky-300/10 px-4 py-2 text-sm font-semibold text-sky-50 disabled:opacity-60"
        >
          {phase === 'starting' ? 'Starting server run...' : 'Start Server Run'}
        </button>
      </div>

      {runFeedback ? <p className="mt-3 text-xs text-slate-300">{runFeedback}</p> : null}

      {trackerState.restartLost ? (
        <div className="mt-3 rounded-2xl border border-amber-300/40 bg-amber-200/10 p-3 text-xs text-amber-100">
          <p>This run is no longer available from the server registry.</p>
          <p className="mt-1">It may have expired from memory or been lost after a process restart. Start a new server run if you still need headless execution.</p>
        </div>
      ) : null}

      {trackerState.transientError ? (
        <div className="mt-3 rounded-2xl border border-amber-300/30 bg-amber-200/10 p-3 text-xs text-amber-100">
          <p>{trackerState.transientError}</p>
          <p className="mt-1">The panel will retry without marking the run as failed.</p>
        </div>
      ) : null}

      {trackerState.run ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3 text-xs text-slate-300">
            <p className="uppercase tracking-[0.2em] text-slate-500">Run details</p>
            <p className="mt-2 break-all">Run ID: {trackerState.run.runId}</p>
            <p className="mt-1 break-words">Policy: {formatProviderPolicy(trackerState.run)}</p>
            <p className="mt-1">Created: {formatRunEventTime(trackerState.run.createdAt)}</p>
            {trackerState.run.startedAt ? <p className="mt-1">Started: {formatRunEventTime(trackerState.run.startedAt)}</p> : null}
            {trackerState.run.finishedAt ? <p className="mt-1">Finished: {formatRunEventTime(trackerState.run.finishedAt)}</p> : null}
          </div>
          <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3 text-xs text-slate-300">
            <p className="uppercase tracking-[0.2em] text-slate-500">Run summary</p>
            <div className="mt-2 flex flex-wrap gap-3">
              <span>Completed: {trackerState.run.summary.completed}</span>
              <span>Running: {trackerState.run.summary.running}</span>
              <span>Failed: {trackerState.run.summary.failed}</span>
              <span>Waiting: {trackerState.run.summary.waiting}</span>
            </div>
            {trackerState.run.failedActionIds.length > 0 ? <p className="mt-2">Failed actions: {trackerState.run.failedActionIds.length}</p> : null}
            {trackerState.run.unresolvedActions.length > 0 ? <p className="mt-1">Unresolved actions: {trackerState.run.unresolvedActions.length}</p> : null}
          </div>
        </div>
      ) : null}

      <ServerRunErrorCard error={trackerState.lastError} />

      <div className="mt-3 rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Recent run events</p>
            <p className="mt-1 text-xs text-slate-400">Latest retained events from the in-memory server log.</p>
          </div>
          {canRevealOlderEvents ? (
            <button
              type="button"
              onClick={() => setVisibleEventCount((current) => current + 10)}
              className="rounded-xl border border-slate-700 px-3 py-1 text-xs text-slate-200"
            >
              Load older events
            </button>
          ) : null}
        </div>

        <div className="mt-3 grid gap-2 text-xs text-slate-300">
          {displayedEvents.length === 0 ? <p className="text-slate-400">No server-run events yet.</p> : null}
          {displayedEvents.map((item: HeadlessRunLogItem) => {
            const details = formatErrorDetails(item.event.error?.details);

            return (
              <div key={`${item.cursor}-${item.event.timestamp}`} className="rounded-xl border border-slate-700/70 bg-slate-950/40 p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-slate-400">#{item.cursor}</span>
                  <span className="font-mono text-slate-400">{formatRunEventTime(item.event.timestamp)}</span>
                  <span className="font-mono uppercase tracking-[0.18em] text-slate-400">{item.event.code}</span>
                  <span className="text-slate-300">{item.event.status}</span>
                </div>
                <p className="mt-1 text-sm text-slate-100">{item.event.message}</p>
                {item.event.error ? (
                  <div className="mt-2 rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-[11px] text-rose-100">
                    <p>Error: {item.event.error.message}</p>
                    {item.event.error.code ? <p>Code: {item.event.error.code}</p> : null}
                    {typeof item.event.error.httpStatus === 'number' ? <p>HTTP: {item.event.error.httpStatus}</p> : null}
                    {item.event.error.endpoint ? <p className="break-all">Endpoint: {item.event.error.endpoint}</p> : null}
                    {item.event.error.providerStatus ? <p>Provider status: {item.event.error.providerStatus}</p> : null}
                    {item.event.error.attemptId ? <p>Attempt: {item.event.error.attemptId}</p> : null}
                    {details ? <p className="break-words">Details: {details}</p> : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}