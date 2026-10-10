import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { AuthoringApiClient } from './api-client';
import { HttpAuthoringApiClient } from './api-client';
import { AuthoringMcpToolError, toFailure, toSuccess } from './errors';
import type {
  AuthoringMcpResult,
  CreateProjectResponse,
  ManageProjectMusicResponse,
  MaterializeSceneIntentsResponse,
  PlanSceneIntentsResponse,
  UpdateProjectResponse
} from './types';

const projectIdSchema = z.string().trim().min(1).max(200);
const projectPatchSchema = z.record(z.string(), z.unknown());

export const createProjectInputSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(4000).optional(),
  durationTarget: z.number().positive().max(600).optional(),
  aspectRatio: z.enum(['16:9', '1:1', '9:16']).optional(),
  fps: z.number().int().positive().max(120).optional()
});

export const updateProjectInputSchema = z.object({
  projectId: projectIdSchema,
  project: projectPatchSchema
});

export const planSceneIntentsInputSchema = z.object({
  projectId: projectIdSchema,
  project: projectPatchSchema.optional()
});

export const materializeSceneIntentsInputSchema = z.object({
  projectId: projectIdSchema,
  project: projectPatchSchema.optional(),
  intentIds: z.array(z.string().trim().min(1).max(200)).max(500).optional()
});

export const manageProjectMusicInputSchema = z.object({
  projectId: projectIdSchema,
  action: z.enum(['generate', 'regenerate', 'select', 'clear']),
  prompt: z.string().trim().min(1).max(2000).optional(),
  musicLengthMs: z.number().int().min(3000).max(600000).optional(),
  instrumental: z.boolean().optional(),
  model: z.string().trim().max(100).optional(),
  provider: z.string().trim().max(100).optional(),
  seed: z.number().int().optional(),
  outputFormat: z.string().trim().max(50).optional(),
  assetId: z.string().trim().min(1).max(200).optional(),
  mode: z.enum(['mock', 'real']).optional()
});

export const AUTHORING_TOOL_DEFINITIONS = [
  {
    name: 'create_project',
    description:
      'Create a new explainer project via POST /api/projects and return its projectId. Requires authentication (EXPLAINER_API_TOKEN as a bearer token). Not idempotent: calling it twice creates two projects. Use list_projects first if you only want to reuse an existing project. On 401 the error code is UNAUTHENTICATED.',
    inputSchema: createProjectInputSchema,
    annotations: {
      title: 'Create Project',
      readOnlyHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'update_project',
    description:
      'Update a project (title, description, narration, scenes, story beats, renderSettings, music reference) via PUT /api/projects/{id}. The server validates the merged project; invalid input returns code VALIDATION_FAILED with details.errors and details.warnings. A 403 means the caller does not own the project; 404 means the project does not exist.',
    inputSchema: updateProjectInputSchema,
    annotations: {
      title: 'Update Project',
      readOnlyHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'plan_scene_intents',
    description:
      'Derive scene intents from the story beats in explainer.story.beats via POST /api/projects/{id}/scene-intents/plan. Optionally pass a project patch to apply first. Idempotent: beats that already have an intent are skipped. Returns the created intent ids. Invalid input returns VALIDATION_FAILED.',
    inputSchema: planSceneIntentsInputSchema,
    annotations: {
      title: 'Plan Scene Intents',
      readOnlyHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'materialize_scene_intents',
    description:
      'Materialize scene intents into concrete scenes via POST /api/projects/{id}/scene-intents/materialize. Optionally pass a project patch and/or explicit intentIds. Idempotent: already-materialized intents are reported under skipped. Returns materialized and skipped intent/scene pairs. Invalid input returns VALIDATION_FAILED.',
    inputSchema: materializeSceneIntentsInputSchema,
    annotations: {
      title: 'Materialize Scene Intents',
      readOnlyHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'manage_project_music',
    description:
      'Manage project background music via POST /api/projects/{id}/music. action=select requires assetId; action=clear drops the reference; action=generate/regenerate produces a new track (regenerate overwrites the selection, generate refuses with CONFLICT if one already exists). MUSIC GENERATION IS AN EXPLICIT PAID ACTION when the server runs in real mode; it is executed only on this call and is never retried automatically. Missing credentials return PROVIDER_NOT_CONFIGURED; provider failures return PROVIDER_ERROR; quota returns RATE_LIMITED. In local mock mode no paid provider is called.',
    inputSchema: manageProjectMusicInputSchema,
    annotations: {
      title: 'Manage Project Music',
      readOnlyHint: false,
      openWorldHint: false
    }
  }
] as const;

export interface AuthoringToolService {
  createProject(args: unknown): Promise<AuthoringMcpResult<CreateProjectResponse>>;
  updateProject(args: unknown): Promise<AuthoringMcpResult<UpdateProjectResponse>>;
  planSceneIntents(args: unknown): Promise<AuthoringMcpResult<PlanSceneIntentsResponse>>;
  materializeSceneIntents(args: unknown): Promise<AuthoringMcpResult<MaterializeSceneIntentsResponse>>;
  manageProjectMusic(args: unknown): Promise<AuthoringMcpResult<ManageProjectMusicResponse>>;
}

export function createAuthoringToolService(apiClient: AuthoringApiClient = new HttpAuthoringApiClient()): AuthoringToolService {
  return {
    async createProject(args: unknown) {
      try {
        const parsed = createProjectInputSchema.parse(args ?? {});
        const result = await apiClient.createProject(parsed);
        return toSuccess({
          projectId: result.project.id,
          title: result.project.title,
          valid: true as const
        });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async updateProject(args: unknown) {
      try {
        const parsed = updateProjectInputSchema.parse(args ?? {});
        const result = await apiClient.updateProject(parsed.projectId, parsed.project);
        return toSuccess({ projectId: result.project.id, valid: true as const });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async planSceneIntents(args: unknown) {
      try {
        const parsed = planSceneIntentsInputSchema.parse(args ?? {});
        const result = await apiClient.planSceneIntents(parsed.projectId, parsed.project);
        return toSuccess({ projectId: result.project.id, valid: true as const, createdIntentIds: result.createdIntentIds });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async materializeSceneIntents(args: unknown) {
      try {
        const parsed = materializeSceneIntentsInputSchema.parse(args ?? {});
        const result = await apiClient.materializeSceneIntents(parsed.projectId, parsed.project, parsed.intentIds);
        return toSuccess({
          projectId: result.project.id,
          valid: true as const,
          materialized: result.materialized,
          skipped: result.skipped
        });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async manageProjectMusic(args: unknown) {
      try {
        const parsed = manageProjectMusicInputSchema.parse(args ?? {});
        if (parsed.action === 'select' && !parsed.assetId) {
          throw new AuthoringMcpToolError('INVALID_ARGUMENT', 'An assetId is required to select background music.');
        }

        const result = await apiClient.manageMusic(parsed.projectId, {
          action: parsed.action,
          prompt: parsed.prompt,
          musicLengthMs: parsed.musicLengthMs,
          instrumental: parsed.instrumental,
          model: parsed.model,
          provider: parsed.provider,
          seed: parsed.seed,
          outputFormat: parsed.outputFormat,
          assetId: parsed.assetId,
          mode: parsed.mode
        });

        return toSuccess({
          projectId: parsed.projectId,
          action: parsed.action,
          status: result.status,
          assetId: result.assetId,
          musicLengthMs: result.musicLengthMs,
          musicProvider: result.provider,
          musicModel: result.model
        });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    }
  };
}

function fromValidationError(error: unknown): unknown {
  if (error instanceof z.ZodError) {
    return new AuthoringMcpToolError('INVALID_ARGUMENT', 'Invalid tool arguments.', {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message
      }))
    });
  }

  return error;
}

function asToolResponse(result: AuthoringMcpResult<unknown>) {
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

export function registerAuthoringTools(server: McpServer, service: AuthoringToolService): void {
  server.registerTool(
    AUTHORING_TOOL_DEFINITIONS[0].name,
    {
      description: AUTHORING_TOOL_DEFINITIONS[0].description,
      inputSchema: AUTHORING_TOOL_DEFINITIONS[0].inputSchema,
      annotations: AUTHORING_TOOL_DEFINITIONS[0].annotations
    },
    async (args) => asToolResponse(await service.createProject(args))
  );

  server.registerTool(
    AUTHORING_TOOL_DEFINITIONS[1].name,
    {
      description: AUTHORING_TOOL_DEFINITIONS[1].description,
      inputSchema: AUTHORING_TOOL_DEFINITIONS[1].inputSchema,
      annotations: AUTHORING_TOOL_DEFINITIONS[1].annotations
    },
    async (args) => asToolResponse(await service.updateProject(args))
  );

  server.registerTool(
    AUTHORING_TOOL_DEFINITIONS[2].name,
    {
      description: AUTHORING_TOOL_DEFINITIONS[2].description,
      inputSchema: AUTHORING_TOOL_DEFINITIONS[2].inputSchema,
      annotations: AUTHORING_TOOL_DEFINITIONS[2].annotations
    },
    async (args) => asToolResponse(await service.planSceneIntents(args))
  );

  server.registerTool(
    AUTHORING_TOOL_DEFINITIONS[3].name,
    {
      description: AUTHORING_TOOL_DEFINITIONS[3].description,
      inputSchema: AUTHORING_TOOL_DEFINITIONS[3].inputSchema,
      annotations: AUTHORING_TOOL_DEFINITIONS[3].annotations
    },
    async (args) => asToolResponse(await service.materializeSceneIntents(args))
  );

  server.registerTool(
    AUTHORING_TOOL_DEFINITIONS[4].name,
    {
      description: AUTHORING_TOOL_DEFINITIONS[4].description,
      inputSchema: AUTHORING_TOOL_DEFINITIONS[4].inputSchema,
      annotations: AUTHORING_TOOL_DEFINITIONS[4].annotations
    },
    async (args) => asToolResponse(await service.manageProjectMusic(args))
  );
}
