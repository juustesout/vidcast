import { normalizeProject } from '@/lib/projects/normalize-project';
import { collectProjectPatchShapeIssues } from '@/lib/projects/project-patch-shape';
import type { Project, RenderValidationResult } from '@/lib/types/render';
import { validateProject } from '@/lib/validation/project-validation';

export interface ApplyProjectUpdateResult {
  project: Project;
  validation: RenderValidationResult;
}

/**
 * Raised when a project mutation must be rejected because the resulting project
 * fails validation. Used inside `ProjectStore.mutateProject` callbacks so the
 * read-apply-write cycle runs under the per-project lock without writing an
 * invalid project.
 */
export class ProjectUpdateValidationError extends Error {
  readonly validation: RenderValidationResult;

  constructor(validation: RenderValidationResult, message = 'Project validation failed.') {
    super(message);
    this.name = 'ProjectUpdateValidationError';
    this.validation = validation;
  }
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

  // Reject structurally malformed patches before normalization so a bad shape
  // (non-array `scenes`, non-object `scene.render`, non-array `attempts`, ...)
  // becomes an ordinary validation failure instead of an uncaught TypeError/500.
  const shapeIssues = collectProjectPatchShapeIssues(incoming);
  if (shapeIssues.length > 0) {
    return {
      project: existingProject,
      validation: {
        valid: false,
        errors: shapeIssues,
        warnings: []
      }
    };
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
