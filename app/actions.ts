'use server';

import { redirect } from 'next/navigation';

import { getServerIdentity } from '@/lib/security/server-identity';
import { projectStore } from '@/lib/storage/project-store';

/**
 * Creates a project owned by the current identity. Server actions run on the
 * server, so the owner is taken from the request identity and never from the
 * client. Unauthenticated callers are redirected without creating anything.
 */
export async function createProjectAction(): Promise<void> {
  const identity = await getServerIdentity();
  if (!identity) {
    redirect('/');
  }

  const project = await projectStore.createProject({}, identity.kind === 'service' ? undefined : identity.subject);
  redirect(`/projects/${project.id}`);
}
