import Link from 'next/link';
import { redirect } from 'next/navigation';

import { projectStore } from '@/lib/storage/project-store';
import { formatSeconds } from '@/lib/utils/duration';

export default async function HomePage() {
  const projects = await projectStore.listProjects();

  return (
    <main className="min-h-screen px-6 py-8 text-slate-100 lg:px-10">
      <section className="mx-auto flex max-w-7xl flex-col gap-8">
        <div className="studio-panel rounded-[28px] p-8 shadow-panel">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl space-y-4">
              <p className="font-mono text-xs uppercase tracking-[0.4em] text-slate-400">Local-first explainer video compiler</p>
              <h1 className="font-[var(--font-display)] text-4xl leading-tight text-white sm:text-5xl">
                Local Explainer Video Studio
              </h1>
              <p className="max-w-2xl text-base leading-7 text-slate-300">
                Structure projects as scenes, reference images, assets, and render plans. The UI stays deterministic and local while the FFmpeg renderer remains a future boundary.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatCard label="Projects" value={String(projects.length)} />
              <StatCard label="Target workflow" value="Scene-first" />
              <StatCard label="Render" value="FFmpeg later" />
            </div>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
          <section className="studio-panel rounded-[28px] p-6 shadow-panel">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.3em] text-slate-400">Projects</p>
                <h2 className="mt-2 text-2xl font-semibold text-white">Open a project</h2>
              </div>
              <form
                action={async () => {
                  'use server';
                  const project = await projectStore.createProject();
                  redirect(`/projects/${project.id}`);
                }}
              >
                <button type="submit" className="rounded-full border border-slate-500/40 bg-slate-900/60 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-300/60 hover:bg-slate-800">
                  New project
                </button>
              </form>
            </div>

            <div className="grid gap-4">
              {projects.length === 0 ? (
                <EmptyState />
              ) : (
                projects.map((project) => (
                  <Link
                    key={project.id}
                    href={`/projects/${project.id}`}
                    className="group rounded-3xl border border-slate-700/70 bg-slate-950/40 p-5 transition hover:-translate-y-0.5 hover:border-slate-400/70 hover:bg-slate-900/80"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="space-y-2">
                        <div className="flex items-center gap-3">
                          <h3 className="text-xl font-semibold text-white group-hover:text-slate-50">{project.title}</h3>
                          <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs uppercase tracking-[0.25em] text-slate-400">
                            {project.sceneCount} scenes
                          </span>
                        </div>
                        <p className="max-w-2xl text-sm leading-6 text-slate-400">{project.description}</p>
                      </div>
                      <div className="grid gap-2 text-sm text-slate-300 sm:grid-cols-3">
                        <MiniField label="Duration" value={formatSeconds(project.durationTarget)} />
                        <MiniField label="Assets" value={String(project.assetCount)} />
                        <MiniField label="Refs" value={String(project.referenceCount)} />
                      </div>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </section>

          <aside className="studio-panel rounded-[28px] p-6 shadow-panel">
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-slate-400">Foundation</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">Built for deterministic rendering later</h2>
            <div className="mt-6 space-y-4 text-sm leading-6 text-slate-300">
              <p>Projects persist as local JSON. Assets and references live under a project directory. Scenes drive the UI and later the render plan.</p>
              <p>The current renderer is an explicit placeholder. Nothing pretends to have rendered when it has not.</p>
              <p>Scene validation, preview simulation, and future AI provider boundaries are already separated into their own modules.</p>
            </div>
            <div className="mt-8 rounded-3xl border border-slate-700/70 bg-slate-950/50 p-5 font-mono text-xs text-slate-400">
              <p>Project → Scene[] → RenderPlan → Renderer → FFmpeg → MP4</p>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-3xl border border-slate-700/70 bg-slate-950/40 px-5 py-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-slate-500">{label}</p>
      <p className="mt-2 text-lg font-semibold text-white">{value}</p>
    </div>
  );
}

function MiniField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm text-slate-100">{value}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-3xl border border-dashed border-slate-700 bg-slate-950/30 p-8 text-center text-slate-400">
      No projects yet. A sample project will be seeded automatically on first storage access.
    </div>
  );
}
