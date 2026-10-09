'use client';

import type { RenderValidationResult } from '@/lib/types/render';

interface ValidationPanelProps {
  validation: RenderValidationResult;
}

export function ValidationPanel({ validation }: ValidationPanelProps) {
  return (
    <section className="rounded-[24px] border border-slate-700/70 bg-slate-950/40 p-4 text-sm text-slate-300">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Validation</p>
      <div className="mt-3 flex items-center justify-between rounded-2xl border border-slate-700/70 bg-slate-900/60 px-4 py-3">
        <span>{validation.valid ? 'Project valid' : 'Project has issues'}</span>
        <span className={validation.valid ? 'text-emerald-300' : 'text-amber-300'}>{validation.errors.length} errors</span>
      </div>

      {validation.errors.length > 0 ? (
        <div className="mt-3 space-y-2">
          {validation.errors.map((issue) => (
            <div key={`${issue.code}-${issue.path}`} className="rounded-2xl border border-red-500/20 bg-red-500/10 p-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-red-300">{issue.code}</p>
              <p className="mt-1 text-red-100">{issue.message}</p>
              <p className="mt-1 text-xs text-red-200/70">{issue.path}</p>
            </div>
          ))}
        </div>
      ) : null}

      {validation.warnings.length > 0 ? (
        <div className="mt-3 space-y-2">
          {validation.warnings.map((issue) => (
            <div key={`${issue.code}-${issue.path}`} className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-amber-300">{issue.code}</p>
              <p className="mt-1 text-amber-50">{issue.message}</p>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
