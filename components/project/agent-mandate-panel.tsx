'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { getMandateStatus, issueProjectMandate, revokeProjectMandate } from '@/lib/client/mandate-client';
import { subscribeToVisibility } from '@/lib/client/visibility-poll';
import { DEFAULT_MANDATE_TTL_MS } from '@/lib/types/mandate';
import type { MandateStatus, ProductionMandate } from '@/lib/types/mandate';

interface AgentMandatePanelProps {
  projectId: string;
  projectTitle: string;
}

function defaultBrief(projectTitle: string): string {
  const title = projectTitle.trim() || 'this project';
  return `Finish video production for "${title}" independently. Author remaining scenes, run production, and deliver the checked MP4.`;
}

function formatWhen(iso: string | undefined): string {
  if (!iso) {
    return 'unknown';
  }
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return iso;
  }
  return new Date(parsed).toLocaleString();
}

function formatDuration(ms: number | undefined): string | null {
  if (!ms || !Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? '1 day' : `${days} days`;
  }
  if (hours >= 1) {
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  const minutes = Math.max(1, Math.round(ms / (60 * 1000)));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function statusLabel(status: MandateStatus | 'none', live: boolean): string {
  if (status === 'none') {
    return 'No mandate';
  }
  if (status === 'revoked') {
    return 'Revoked';
  }
  if (status === 'expired') {
    return 'Expired';
  }
  if (status === 'failed') {
    return 'Failed';
  }
  if (status === 'consumed' && live) {
    return 'Active - production in progress';
  }
  if (status === 'consumed') {
    return 'Consumed';
  }
  return live ? 'Active' : status;
}

function statusTone(status: MandateStatus | 'none', live: boolean): string {
  if (live) {
    return 'text-emerald-200';
  }
  if (status === 'revoked' || status === 'expired' || status === 'failed') {
    return 'text-rose-200';
  }
  return 'text-slate-200';
}

function authorizationClosedMessage(status: MandateStatus): string {
  if (status === 'revoked') {
    return 'Mandate revoked. New production actions are not authorized.';
  }
  if (status === 'expired') {
    return 'Mandate expired. New production actions are not authorized.';
  }
  if (status === 'failed') {
    return 'Mandate failed. New production actions are not authorized.';
  }
  return 'This mandate no longer authorizes new production actions.';
}

export function AgentMandatePanel({ projectId, projectTitle }: AgentMandatePanelProps) {
  const busyRef = useRef(false);
  const titleRef = useRef(projectTitle);
  titleRef.current = projectTitle;
  const [mandate, setMandate] = useState<ProductionMandate | null>(null);
  const [live, setLive] = useState(false);
  const [brief, setBrief] = useState(() => defaultBrief(projectTitle));
  const [busy, setBusy] = useState<'idle' | 'loading' | 'issuing' | 'revoking'>('loading');
  const [message, setMessage] = useState('');

  const ttlLabel = formatDuration(DEFAULT_MANDATE_TTL_MS) ?? '24 hours';

  useEffect(() => {
    let cancelled = false;
    setBusy('loading');
    void getMandateStatus(projectId).then((result) => {
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setMessage(result.error.message);
        setBusy('idle');
        return;
      }
      setMandate(result.data.mandate);
      setLive(result.data.live);
      if (result.data.mandate?.brief) {
        setBrief(result.data.mandate.brief);
      } else {
        setBrief(defaultBrief(titleRef.current));
      }
      setMessage('');
      setBusy('idle');
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    return subscribeToVisibility((hidden) => {
      if (hidden || busyRef.current) {
        return;
      }
      void getMandateStatus(projectId).then((result) => {
        if (!result.ok) {
          return;
        }
        setMandate(result.data.mandate);
        setLive(result.data.live);
      });
    });
  }, [projectId]);

  const status = mandate?.status ?? 'none';
  const canIssue = !live && busy === 'idle';
  const canRevoke = live && busy === 'idle';

  const limits = useMemo(() => {
    const items = [`Valid for ${ttlLabel} unless revoked earlier.`];
    const duration = formatDuration(mandate?.maxDurationMs);
    if (duration) {
      items.push(`Maximum duration ${duration}.`);
    }
    items.push('Host real-provider flag and spend cap still apply.');
    items.push('No per-scene, per-asset, or per-step approval after this.');
    return items;
  }, [mandate?.maxDurationMs, ttlLabel]);

  async function handleIssue(): Promise<void> {
    if (busyRef.current || live) {
      return;
    }
    busyRef.current = true;
    setBusy('issuing');
    setMessage('Issuing production mandate...');
    const result = await issueProjectMandate(projectId, { brief: brief.trim() });
    if (!result.ok) {
      setMessage(result.error.message);
      setBusy('idle');
      busyRef.current = false;
      return;
    }
    setMandate(result.data.mandate);
    setLive(result.data.live);
    if (result.data.mandate?.brief) {
      setBrief(result.data.mandate.brief);
    }
    setMessage('Mandate issued. You can leave this workspace; Hermes can finish and resume on its own.');
    setBusy('idle');
    busyRef.current = false;
  }

  async function handleRevoke(): Promise<void> {
    if (busyRef.current || !live) {
      return;
    }
    busyRef.current = true;
    setBusy('revoking');
    setMessage('Revoking production mandate...');
    const result = await revokeProjectMandate(projectId);
    if (!result.ok) {
      setMessage(result.error.message);
      setBusy('idle');
      busyRef.current = false;
      return;
    }
    setMandate(result.data.mandate);
    setLive(false);
    setMessage(authorizationClosedMessage(result.data.mandate?.status ?? 'revoked'));
    setBusy('idle');
    busyRef.current = false;
  }

  return (
    <section className="rounded-2xl border border-slate-700/70 bg-slate-950/25 p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Agent authorization</p>
          <p className={`mt-1 text-sm ${statusTone(status, live)}`}>{statusLabel(status, live)}</p>
          <p className="mt-1 text-xs text-slate-400">
            One user-issued mandate lets Hermes finish this project without further approval prompts.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canRevoke ? (
            <button
              type="button"
              onClick={() => void handleRevoke()}
              className="rounded-2xl border border-rose-400/40 bg-rose-500/10 px-4 py-2 text-sm font-semibold text-rose-50"
            >
              Revoke mandate
            </button>
          ) : null}
          {!live ? (
            <button
              type="button"
              disabled={!canIssue}
              onClick={() => void handleIssue()}
              className="rounded-2xl border border-violet-300/40 bg-violet-300/10 px-4 py-2 text-sm font-semibold text-violet-50 disabled:opacity-60"
            >
              {busy === 'issuing' ? 'Authorizing...' : 'Let the agent finish this video'}
            </button>
          ) : null}
        </div>
      </div>

      {!live ? (
        <label className="mt-3 grid gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">Production brief</span>
          <textarea
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            disabled={busy !== 'idle'}
            className="min-h-20 rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-300/50 disabled:opacity-60"
          />
        </label>
      ) : mandate?.brief ? (
        <div className="mt-3 rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">Production brief</p>
          <p className="mt-1 text-sm text-slate-100">{mandate.brief}</p>
        </div>
      ) : null}

      <ul className="mt-3 grid gap-1 text-xs text-slate-300">
        {limits.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      {mandate ? (
        <div className="mt-3 grid gap-2 text-xs text-slate-300 md:grid-cols-2">
          <p>Issued: {formatWhen(mandate.issuedAt)}</p>
          <p>Expires: {formatWhen(mandate.expiresAt)}</p>
          {mandate.boundRunId ? <p className="break-all">Bound run: {mandate.boundRunId}</p> : null}
        </div>
      ) : null}

      {live ? (
        <p className="mt-3 text-xs text-emerald-100">
          You can leave this workspace. Hermes can execute and resume until the mandate expires or is revoked. Final MP4 readiness still comes from the runner and output checks, not from this mandate.
        </p>
      ) : null}

      {mandate && !live ? <p className="mt-3 text-xs text-rose-100">{authorizationClosedMessage(mandate.status)}</p> : null}

      {message ? <p className="mt-2 text-xs text-slate-300">{message}</p> : null}
    </section>
  );
}
