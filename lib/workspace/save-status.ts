import type { Project } from '@/lib/types/render';

export type WorkspaceSaveStatus = 'saved' | 'unsaved';

export function projectSaveSignature(project: Project): string {
  return JSON.stringify({ ...project, updatedAt: undefined });
}

export function deriveSaveStatus(draft: Project, savedProject: Project): WorkspaceSaveStatus {
  return projectSaveSignature(draft) === projectSaveSignature(savedProject) ? 'saved' : 'unsaved';
}
