import { notFound } from 'next/navigation';

import { ProjectWorkspace } from '@/components/project/project-workspace';
import { getProjectForIdentity } from '@/lib/security/page-access';
import { getServerIdentity } from '@/lib/security/server-identity';

interface ProjectPageProps {
  params: Promise<{ id: string }>;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { id } = await params;
  const identity = await getServerIdentity();

  if (!identity) {
    notFound();
  }

  const project = await getProjectForIdentity(identity, id);

  if (!project) {
    notFound();
  }

  return (
    <main className="min-h-screen px-4 py-4 text-slate-100 lg:px-6 lg:py-6">
      <ProjectWorkspace project={project} />
    </main>
  );
}
