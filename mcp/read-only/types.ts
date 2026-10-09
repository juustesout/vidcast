import type { Project } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';
import type { ProjectSummary } from '@/lib/storage/project-store';
import type { ProjectValidationReport } from '@/lib/validation/project-validation-report';
import type { ProductionPlanReport } from '@/lib/production/production-plan-report';

export type ReadOnlyMcpErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'API_UNAVAILABLE'
  | 'API_ERROR'
  | 'INTERNAL_ERROR';

export interface ReadOnlyMcpError {
  code: ReadOnlyMcpErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReadOnlyMcpSuccess<T> {
  ok: true;
  data: T;
}

export interface ReadOnlyMcpFailure {
  ok: false;
  error: ReadOnlyMcpError;
}

export type ReadOnlyMcpResult<T> = ReadOnlyMcpSuccess<T> | ReadOnlyMcpFailure;

export interface ReadOnlyMcpProjectSummary {
  id: string;
  title: string;
  description: string;
  sceneCount: number;
  assetCount: number;
  referenceCount: number;
  durationTarget: number;
  updatedAt: string;
}

export interface ListProjectsResponse {
  projects: ReadOnlyMcpProjectSummary[];
}

export interface GetProjectResponse {
  project: Project;
}

export interface GetSceneResponse {
  projectId: string;
  scene: Scene;
}

export interface GetValidationReportResponse {
  projectId: string;
  report: ProjectValidationReport;
}

export interface GetProductionPlanResponse {
  projectId: string;
  report: ProductionPlanReport;
}

export function toProjectSummary(project: ProjectSummary): ReadOnlyMcpProjectSummary {
  return {
    id: project.id,
    title: project.title,
    description: project.description,
    sceneCount: project.sceneCount,
    assetCount: project.assetCount,
    referenceCount: project.referenceCount,
    durationTarget: project.durationTarget,
    updatedAt: project.updatedAt
  };
}
