import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { AppApiClient } from './api-client';
import { HttpAppApiClient } from './api-client';
import { ReadOnlyMcpToolError, toFailure, toSuccess } from './errors';
import type {
  GetProjectResponse,
  GetProductionPlanResponse,
  GetSceneResponse,
  GetValidationReportResponse,
  ListProjectsResponse,
  ReadOnlyMcpResult
} from './types';
import { toProjectSummary } from './types';

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
    description: 'Get one project by projectId.',
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
  }
] as const;

export interface ReadOnlyToolService {
  listProjects(args: unknown): Promise<ReadOnlyMcpResult<ListProjectsResponse>>;
  getProject(args: unknown): Promise<ReadOnlyMcpResult<GetProjectResponse>>;
  getScene(args: unknown): Promise<ReadOnlyMcpResult<GetSceneResponse>>;
  getValidationReport(args: unknown): Promise<ReadOnlyMcpResult<GetValidationReportResponse>>;
  getProductionPlan(args: unknown): Promise<ReadOnlyMcpResult<GetProductionPlanResponse>>;
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
        return toSuccess({ project });
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
}
