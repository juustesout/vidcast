import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { AppApiClient } from './api-client';
import { HttpAppApiClient } from './api-client';
import { ReadOnlyMcpToolError, toFailure, toSuccess } from './errors';
import type {
  GetGenerationJobResponse,
  GetMandateStatusResponse,
  GetProjectCompositionsResponse,
  GetProjectResponse,
  GetProductionPlanResponse,
  GetSceneResponse,
  GetValidationReportResponse,
  ListAnimationTemplatesResponse,
  ListProjectsResponse,
  ReadOnlyMcpResult,
  SearchStockPhotosResponse
} from './types';
import { toCompositionInfo, toMcpProject, toProjectSummary } from './types';

const projectIdSchema = z.string().trim().min(1).max(200);
const sceneIdSchema = z.string().trim().min(1).max(200);

export const listProjectsInputSchema = z.object({});
export const getProjectInputSchema = z.object({
  projectId: projectIdSchema
});
export const getSceneInputSchema = z.object({
  projectId: projectIdSchema,
  sceneId: sceneIdSchema
});
export const getValidationReportInputSchema = z.object({
  projectId: projectIdSchema
});
export const getProductionPlanInputSchema = z.object({
  projectId: projectIdSchema
});
export const getProjectCompositionsInputSchema = z.object({
  projectId: projectIdSchema,
  compositionId: z.string().trim().min(1).max(200).optional()
});
export const getGenerationJobInputSchema = z.object({
  projectId: projectIdSchema,
  attemptId: z.string().trim().min(1).max(200)
});
export const getMandateStatusInputSchema = z.object({
  projectId: projectIdSchema
});
export const listAnimationTemplatesInputSchema = z.object({}).strict();
export const searchStockPhotosInputSchema = z.object({
  projectId: projectIdSchema,
  query: z.string().trim().min(1).max(500),
  orientation: z.enum(['landscape', 'portrait', 'squarish']).optional(),
  providers: z.array(z.enum(['unsplash', 'pexels', 'pixabay', 'fake'])).min(1).max(4).optional(),
  limit: z.number().int().min(1).max(24).optional(),
  mode: z.enum(['mock', 'real']).optional()
});

export const READ_ONLY_TOOL_DEFINITIONS = [
  {
    name: 'list_projects',
    description: 'List all local explainer projects with stable IDs and summary metadata.',
    inputSchema: listProjectsInputSchema,
    annotations: {
      title: 'List Projects',
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
     name: 'get_project',
     description:
       'Get one project by projectId. Compositions are projected without outputPath; use downloadPath or get_project_compositions to fetch the MP4.',
    inputSchema: getProjectInputSchema,
    annotations: {
      title: 'Get Project',
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'get_scene',
    description: 'Get one scene by projectId and sceneId.',
    inputSchema: getSceneInputSchema,
    annotations: {
      title: 'Get Scene',
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'get_validation_report',
    description: 'Get a structured read-only validation report and blockers for one project.',
    inputSchema: getValidationReportInputSchema,
    annotations: {
      title: 'Get Validation Report',
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'get_production_plan',
    description: 'Get a structured read-only production plan with statuses and dependencies for one project.',
    inputSchema: getProductionPlanInputSchema,
    annotations: {
      title: 'Get Production Plan',
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'get_project_compositions',
    description:
      'Read available final-video composition metadata for a project (from GET /api/projects/{id}). Returns compositionId, dimensions, duration, sceneCount and an authenticated downloadPath per composition (latest first) plus an `available` flag. It never returns MP4 bytes; fetch the MP4 yourself via downloadPath with the same bearer token. Optional compositionId filters to one composition and raises NOT_FOUND when it is absent.',
    inputSchema: getProjectCompositionsInputSchema,
    annotations: {
      title: 'Get Project Compositions',
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'get_generation_job',
    description:
      'Poll one video generation attempt via GET /api/projects/{id}/generation-jobs/{attemptId}. Each call refreshes the attempt against the provider and persists the latest state, so repeating it advances an in-flight job the same way the run video_poll step does. Returns status, providerStatus, providerJobId, assetId and any errorCode/errorMessage. A transient failure sets providerStatus=status_unresolved and returns an error while KEEPING the job active and resumable — retry the same attempt, never resubmit it, because a live remote job may still be running. Use this after generate_video (or run_production) to follow a job to a terminal status.',
    inputSchema: getGenerationJobInputSchema,
    annotations: {
      // Not read-only: each call refreshes the attempt against the provider and
      // persists the latest state (and downloads the asset on completion), so it
      // mutates server state the same way a run video_poll step does.
      title: 'Get Generation Job',
      readOnlyHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'get_mandate_status',
    description:
      'Read the existing user-minted production mandate for a project via GET /api/projects/{id}/mandates. Returns live (whether the mandate currently authorizes service real/paid work) plus the public mandate view: mandateId, status (active|consumed|revoked|expired|failed), issuedBy, issuedAt, expiresAt, brief, allowedActions, allowedProviders, budgets, boundRunId. Status is resolved at read time, so an expired file is reported as expired even if the stored status is still active or consumed. This tool never mints, revokes, or forges a mandate; POST and DELETE remain browser-session only. Missing mandate returns NOT_FOUND. A live mandate is the service-token substitute for explainer.humanApproval on real/paid authoring and run_production; Hermes must not invent mint/revoke MCP tools.',
    inputSchema: getMandateStatusInputSchema,
    annotations: {
      title: 'Get Mandate Status',
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'list_animation_templates',
    description:
      'List the server-owned Motion Canvas animation templates Hermes may render. Returns id, destination (bigscreen|overlay), output codec/container, allowedParamKeys, paramsSchema, and defaults. Structured numbers/colors/text only; unknown fields are rejected. Does not execute code or render.',
    inputSchema: listAnimationTemplatesInputSchema,
    annotations: {
      title: 'List Animation Templates',
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'search_stock_photos',
    description:
      'Search stock photo candidates via GET /api/projects/{id}/stock/search. Returns searchId, sanitized results (provider, photoId, dimensions, preview/image/source URLs, photographer, license, usagePolicy), diagnostics, and quota. This is discovery only: it never selects a photo, never downloads bytes, never writes a scene, and never assigns HTML-slot imageAssetId. Stock CDN URLs are not slot-eligible; import local PNG/JPEG/WebP with import_asset, then assign the returned assetId. Production stock scenes still use the stock_select action. Mock mode is locked to the fake provider. Real mode requires a current human approval of the project snapshot for a browser session, or a live production mandate for the service token, and may consume provider quota. Searching refreshes the server-side candidate cache, so it is not a pure read.',
    inputSchema: searchStockPhotosInputSchema,
    annotations: {
      title: 'Search Stock Photos',
      readOnlyHint: false,
      openWorldHint: false
    }
  }
] as const;

export interface ReadOnlyToolService {
  listProjects(args: unknown): Promise<ReadOnlyMcpResult<ListProjectsResponse>>;
  getProject(args: unknown): Promise<ReadOnlyMcpResult<GetProjectResponse>>;
  getScene(args: unknown): Promise<ReadOnlyMcpResult<GetSceneResponse>>;
  getValidationReport(args: unknown): Promise<ReadOnlyMcpResult<GetValidationReportResponse>>;
  getProductionPlan(args: unknown): Promise<ReadOnlyMcpResult<GetProductionPlanResponse>>;
  getProjectCompositions(args: unknown): Promise<ReadOnlyMcpResult<GetProjectCompositionsResponse>>;
  getGenerationJob(args: unknown): Promise<ReadOnlyMcpResult<GetGenerationJobResponse>>;
  getMandateStatus(args: unknown): Promise<ReadOnlyMcpResult<GetMandateStatusResponse>>;
  listAnimationTemplates(args: unknown): Promise<ReadOnlyMcpResult<ListAnimationTemplatesResponse>>;
  searchStockPhotos(args: unknown): Promise<ReadOnlyMcpResult<SearchStockPhotosResponse>>;
}

export function createReadOnlyToolService(apiClient: AppApiClient = new HttpAppApiClient()): ReadOnlyToolService {
  return {
    async listProjects(args: unknown) {
      try {
        listProjectsInputSchema.parse(args ?? {});
        const projects = await apiClient.listProjects();
        return toSuccess({
          projects: projects.map(toProjectSummary)
        });
      } catch (error) {
        return toFailure(error);
      }
    },

    async getProject(args: unknown) {
      try {
        const parsed = getProjectInputSchema.parse(args ?? {});
        const project = await apiClient.getProject(parsed.projectId);
        return toSuccess({ project: toMcpProject(project) });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async getScene(args: unknown) {
      try {
        const parsed = getSceneInputSchema.parse(args ?? {});
        const project = await apiClient.getProject(parsed.projectId);
        const scene = project.scenes.find((entry) => entry.id === parsed.sceneId);

        if (!scene) {
          throw new ReadOnlyMcpToolError('NOT_FOUND', 'Scene not found.', {
            projectId: parsed.projectId,
            sceneId: parsed.sceneId
          });
        }

        return toSuccess({
          projectId: project.id,
          scene
        });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async getValidationReport(args: unknown) {
      try {
        const parsed = getValidationReportInputSchema.parse(args ?? {});
        const report = await apiClient.getValidationReport(parsed.projectId);
        return toSuccess({
          projectId: parsed.projectId,
          report
        });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async getProductionPlan(args: unknown) {
      try {
        const parsed = getProductionPlanInputSchema.parse(args ?? {});
        const report = await apiClient.getProductionPlan(parsed.projectId);
        return toSuccess({
          projectId: parsed.projectId,
          report
        });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async getProjectCompositions(args: unknown) {
      try {
        const parsed = getProjectCompositionsInputSchema.parse(args ?? {});
        const project = await apiClient.getProject(parsed.projectId);
        const all = (project.compositions ?? [])
          .map((artifact) => toCompositionInfo(project.id, artifact))
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        const selected = parsed.compositionId ? all.filter((entry) => entry.compositionId === parsed.compositionId) : all;

        if (parsed.compositionId && selected.length === 0) {
          throw new ReadOnlyMcpToolError('NOT_FOUND', 'Composition not found.', {
            projectId: parsed.projectId,
            compositionId: parsed.compositionId
          });
        }

        return toSuccess({
          projectId: project.id,
          available: all.length > 0,
          latest: all[0] ?? null,
          compositions: selected
        });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async getGenerationJob(args: unknown) {
      try {
        const parsed = getGenerationJobInputSchema.parse(args ?? {});
        const job = await apiClient.getGenerationJob(parsed.projectId, parsed.attemptId);
        return toSuccess(job);
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async getMandateStatus(args: unknown) {
      try {
        const parsed = getMandateStatusInputSchema.parse(args ?? {});
        const status = await apiClient.getMandateStatus(parsed.projectId);
        return toSuccess(status);
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async listAnimationTemplates(args: unknown) {
      try {
        listAnimationTemplatesInputSchema.parse(args ?? {});
        const templates = await apiClient.listAnimationTemplates();
        return toSuccess({ templates });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async searchStockPhotos(args: unknown) {
      try {
        const parsed = searchStockPhotosInputSchema.parse(args ?? {});
        const result = await apiClient.searchStockPhotos(parsed.projectId, {
          query: parsed.query,
          orientation: parsed.orientation,
          providers: parsed.providers,
          limit: parsed.limit,
          mode: parsed.mode
        });
        return toSuccess(result);
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    }
  };
}

function fromValidationError(error: unknown): unknown {
  if (error instanceof z.ZodError) {
    return new ReadOnlyMcpToolError('INVALID_ARGUMENT', 'Invalid tool arguments.', {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code
      }))
    });
  }

  return error;
}

function asToolResponse(result: ReadOnlyMcpResult<unknown>) {
  const structuredContent: Record<string, unknown> = result.ok
    ? { ok: true, data: result.data as Record<string, unknown> }
    : {
        ok: false,
        error: {
          code: result.error.code,
          message: result.error.message,
          details: result.error.details
        }
      };

  return {
    isError: !result.ok,
    structuredContent,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(structuredContent)
      }
    ]
  };
}

export function registerReadOnlyTools(server: McpServer, service: ReadOnlyToolService): void {
  server.registerTool(
    'list_projects',
    {
      description: READ_ONLY_TOOL_DEFINITIONS[0].description,
      inputSchema: READ_ONLY_TOOL_DEFINITIONS[0].inputSchema,
      annotations: READ_ONLY_TOOL_DEFINITIONS[0].annotations
    },
    async (args) => asToolResponse(await service.listProjects(args))
  );

  server.registerTool(
    'get_project',
    {
      description: READ_ONLY_TOOL_DEFINITIONS[1].description,
      inputSchema: READ_ONLY_TOOL_DEFINITIONS[1].inputSchema,
      annotations: READ_ONLY_TOOL_DEFINITIONS[1].annotations
    },
    async (args) => asToolResponse(await service.getProject(args))
  );

  server.registerTool(
    'get_scene',
    {
      description: READ_ONLY_TOOL_DEFINITIONS[2].description,
      inputSchema: READ_ONLY_TOOL_DEFINITIONS[2].inputSchema,
      annotations: READ_ONLY_TOOL_DEFINITIONS[2].annotations
    },
    async (args) => asToolResponse(await service.getScene(args))
  );

  server.registerTool(
    'get_validation_report',
    {
      description: READ_ONLY_TOOL_DEFINITIONS[3].description,
      inputSchema: READ_ONLY_TOOL_DEFINITIONS[3].inputSchema,
      annotations: READ_ONLY_TOOL_DEFINITIONS[3].annotations
    },
    async (args) => asToolResponse(await service.getValidationReport(args))
  );

  server.registerTool(
    'get_production_plan',
    {
      description: READ_ONLY_TOOL_DEFINITIONS[4].description,
      inputSchema: READ_ONLY_TOOL_DEFINITIONS[4].inputSchema,
      annotations: READ_ONLY_TOOL_DEFINITIONS[4].annotations
    },
    async (args) => asToolResponse(await service.getProductionPlan(args))
  );

  server.registerTool(
    'get_project_compositions',
    {
      description: READ_ONLY_TOOL_DEFINITIONS[5].description,
      inputSchema: READ_ONLY_TOOL_DEFINITIONS[5].inputSchema,
      annotations: READ_ONLY_TOOL_DEFINITIONS[5].annotations
    },
    async (args) => asToolResponse(await service.getProjectCompositions(args))
  );

  server.registerTool(
    'get_generation_job',
    {
      description: READ_ONLY_TOOL_DEFINITIONS[6].description,
      inputSchema: READ_ONLY_TOOL_DEFINITIONS[6].inputSchema,
      annotations: READ_ONLY_TOOL_DEFINITIONS[6].annotations
    },
    async (args) => asToolResponse(await service.getGenerationJob(args))
  );

  server.registerTool(
    'get_mandate_status',
    {
      description: READ_ONLY_TOOL_DEFINITIONS[7].description,
      inputSchema: READ_ONLY_TOOL_DEFINITIONS[7].inputSchema,
      annotations: READ_ONLY_TOOL_DEFINITIONS[7].annotations
    },
    async (args) => asToolResponse(await service.getMandateStatus(args))
  );

  server.registerTool(
    'list_animation_templates',
    {
      description: READ_ONLY_TOOL_DEFINITIONS[8].description,
      inputSchema: READ_ONLY_TOOL_DEFINITIONS[8].inputSchema,
      annotations: READ_ONLY_TOOL_DEFINITIONS[8].annotations
    },
    async (args) => asToolResponse(await service.listAnimationTemplates(args))
  );

  server.registerTool(
    'search_stock_photos',
    {
      description: READ_ONLY_TOOL_DEFINITIONS[9].description,
      inputSchema: READ_ONLY_TOOL_DEFINITIONS[9].inputSchema,
      annotations: READ_ONLY_TOOL_DEFINITIONS[9].annotations
    },
    async (args) => asToolResponse(await service.searchStockPhotos(args))
  );
}
