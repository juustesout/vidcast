import type { Project } from '@/lib/types/render';
import { projectStore, type ProjectSummary } from '@/lib/storage/project-store';
import type { RequestIdentity } from './auth';

/**
 * Owner-scoped project listing for server-rendered pages. Users only ever see
 * their own projects; service callers keep the full list.
 */
export async function listProjectsForIdentity(identity: RequestIdentity): Promise<ProjectSummary[]> {
  if (identity.kind === 'service') {
    return projectStore.listProjects();
  }

  return projectStore.listProjects(identity.subject);
}

/**
 * Resolves a project for a page request, enforcing the same ownership rules as
 * `requireProjectAccess`. Returns `null` when the identity may not access the
 * project so callers can render a not-found response without disclosing
 * existence.
 */
export async function getProjectForIdentity(identity: RequestIdentity, projectId: string): Promise<Project | null> {
  const project = await projectStore.getProject(projectId);
  if (!project) {
    return null;
  }

  if (identity.kind === 'service') {
    return project;
  }

  const ownerId = project.ownerId?.trim();
  if (!ownerId) {
    return projectStore.updateProject({ ...project, ownerId: identity.subject });
  }

  if (ownerId !== identity.subject) {
    return null;
  }

  return project;
}
