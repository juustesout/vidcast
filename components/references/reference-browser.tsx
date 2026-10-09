'use client';

import type { Project } from '@/lib/types/render';

interface ReferenceBrowserProps {
  project: Project;
}

export function ReferenceBrowser({ project }: ReferenceBrowserProps) {
  return (
    <section className="studio-panel rounded-[24px] p-4 shadow-panel">
      <div className="flex items-center justify-between gap-4 border-b border-slate-700/70 pb-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">References</p>
          <h2 className="mt-2 text-xl font-semibold text-white">Reference library</h2>
        </div>
        <button type="button" className="rounded-2xl border border-slate-700 bg-slate-950/50 px-4 py-2 text-sm text-slate-200">
          Add reference
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {project.references.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-700 p-4 text-sm text-slate-400">No references yet.</div>
        ) : (
          project.references.map((reference) => (
            <div key={reference.id} className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3">
              <p className="text-sm font-semibold text-white">{reference.name}</p>
              <p className="mt-1 text-xs text-slate-400">{reference.description}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {reference.tags.map((tag) => (
                  <span key={tag} className="rounded-full border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
