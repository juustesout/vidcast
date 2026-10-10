import type { Project } from '@/lib/types/render';
import type { CompositionArtifact } from '@/lib/types/render';
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

export interface CompositionInfo {
  compositionId: string;
  createdAt: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  sceneCount: number;
  filesize: number;
  // Relative API path the agent can fetch to download the rendered MP4. The
  // tool never returns MP4 bytes; the caller performs an authenticated GET.
  downloadPath: string;
}

export interface GetProjectCompositionsResponse {
  projectId: string;
  // True when at least one composition artifact exists and can be downloaded.
  available: boolean;
  latest: CompositionInfo | null;
  compositions: CompositionInfo[];
}

export function toCompositionInfo(projectId: string, artifact: CompositionArtifact): CompositionInfo {
  return {
    compositionId: artifact.compositionId,
    createdAt: artifact.createdAt,
    duration: artifact.duration,
    width: artifact.width,
    height: artifact.height,
    fps: artifact.fps,
    sceneCount: artifact.sceneIds.length,
    filesize: artifact.filesize,
    downloadPath: `/api/projects/${encodeURIComponent(projectId)}/compositions/${encodeURIComponent(artifact.compositionId)}/file`
  };
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
