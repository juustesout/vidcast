'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Minimal claim UI. The token is only ever submitted in the request body, never
 * in the URL, so it cannot leak through history, referrers or access logs.
 */
export function ClaimProjectForm(): JSX.Element {
  const router = useRouter();
  const [projectId, setProjectId] = useState('');
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedId = projectId.trim();
    const trimmedToken = token.trim();
    if (!trimmedId || !trimmedToken) {
      setError('Enter both the project id and the claim token.');
      return;
    }

    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(trimmedId)}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: trimmedToken })
      });

      if (response.ok) {
        setToken('');
        router.push(`/projects/${encodeURIComponent(trimmedId)}`);
        router.refresh();
        return;
      }

      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      setError(payload?.message ?? 'Claim failed. Check the project id and token, then try again.');
    } catch {
      setError('Claim request failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="studio-panel grid gap-4 rounded-[24px] p-5">
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.35em] text-slate-400">Claim</p>
        <h2 className="mt-2 text-xl font-semibold text-white">Claim a project created for you</h2>
        <p className="mt-1 text-sm text-slate-400">
          Paste the project id and the single-use claim token you received. The token is sent in the request body and is
          consumed once.
        </p>
      </div>

      <label className="grid gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">Project id</span>
        <input
          type="text"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          placeholder="project_..."
          autoComplete="off"
          className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-300/50"
        />
      </label>

      <label className="grid gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">Claim token</span>
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
          className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-300/50"
        />
      </label>

      {error ? <p className="text-sm text-rose-300">{error}</p> : null}

      <button
        type="submit"
        disabled={pending}
        className="justify-self-start rounded-2xl border border-amber-300/50 bg-amber-200/10 px-4 py-2 text-sm text-amber-100 transition disabled:opacity-50"
      >
        {pending ? 'Claiming...' : 'Claim project'}
      </button>
    </form>
  );
}
