'use client';

import type { WorkspaceSaveStatus } from '@/lib/workspace/save-status';

interface WorkspaceTopbarProps {
  title: string;
  saveStatus: WorkspaceSaveStatus;
  saveError?: string;
  onSave: () => void;
}

export function WorkspaceTopbar({ title, saveStatus, saveError, onSave }: WorkspaceTopbarProps): JSX.Element {
  const saved = saveStatus === 'saved';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-slate-700/70 bg-slate-950/40 px-4 py-3">
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Workspace</p>
        <h2 className="truncate text-lg font-semibold text-white">{title || 'Untitled project'}</h2>
      </div>
      <div className="flex items-center gap-3">
        <span
          data-save-status={saveStatus}
          className={`rounded-full border px-3 py-1 text-xs ${saved ? 'border-emerald-400/40 bg-emerald-300/10 text-emerald-100' : 'border-amber-300/40 bg-amber-200/10 text-amber-100'}`}
        >
          {saved ? 'Saved' : 'Unsaved'}
        </span>
        <button
          type="button"
          onClick={onSave}
          className="rounded-2xl bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950"
        >
          Save project
        </button>
      </div>
      {saveError ? <p className="w-full text-sm text-rose-300">{saveError}</p> : null}
    </div>
  );
}
