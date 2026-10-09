import { normalizeProject } from '@/lib/projects/normalize-project';
import type { Project, RenderValidationResult } from '@/lib/types/render';
import { validateProject } from '@/lib/validation/project-validation';

export interface ApplyProjectUpdateResult {
  project: Project;
  validation: RenderValidationResult;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function applyProjectUpdate(existingProject: Project, incomingPayload: unknown): ApplyProjectUpdateResult {
  const incoming = asRecord(incomingPayload);
  if (!incoming) {
    throw new Error('Invalid project payload.');
  }

  const candidate = normalizeProject({
    ...existingProject,
    ...(incoming as unknown as Partial<Project>),
    id: existingProject.id,
    createdAt: existingProject.createdAt,
    updatedAt: existingProject.updatedAt
  });

  const validation = validateProject(candidate);
  if (!validation.valid) {
    return {
      project: candidate,
      validation
    };
  }

  return {
    project: candidate,
    validation
  };
}
