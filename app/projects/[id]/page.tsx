import { notFound } from 'next/navigation';

import { projectStore } from '@/lib/storage/project-store';
import { ProjectWorkspace } from '@/components/project/project-workspace';

interface ProjectPageProps {
  params: Promise<{ id: string }>;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { id } = await params;
  const project = await projectStore.getProject(id);

  if (!project) {
    notFound();
  }

  return (
    <main className="min-h-screen px-4 py-4 text-slate-100 lg:px-6 lg:py-6">
      <ProjectWorkspace project={project} />
    </main>
  );
}
