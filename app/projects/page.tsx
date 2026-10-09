import Link from 'next/link';

import { projectStore } from '@/lib/storage/project-store';

export default async function ProjectsPage() {
  const projects = await projectStore.listProjects();

  return (
    <main className="min-h-screen px-6 py-8 text-slate-100 lg:px-10">
      <section className="mx-auto max-w-7xl space-y-6">
        <div className="studio-panel rounded-[28px] p-6 shadow-panel">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.35em] text-slate-400">Projects</p>
              <h1 className="mt-2 text-3xl font-semibold text-white">Your local projects</h1>
            </div>
            <Link href="/" className="text-sm text-slate-300 underline decoration-slate-500/60 underline-offset-4">
              Back to home
            </Link>
          </div>
        </div>

        <div className="grid gap-4">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="studio-panel rounded-[24px] p-5 transition hover:border-slate-400/60 hover:bg-slate-900/80"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-white">{project.title}</h2>
                  <p className="mt-1 max-w-3xl text-sm text-slate-400">{project.description}</p>
                </div>
                <div className="text-sm text-slate-300">
                  {project.sceneCount} scenes · {project.assetCount} assets · {project.referenceCount} references
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
