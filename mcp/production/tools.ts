import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { ProductionApiClient } from './api-client';
import { HttpProductionApiClient } from './api-client';
import { ProductionMcpToolError, toFailure, toSuccess } from './errors';
import type { GetRunLogResponse, GetRunStatusResponse, ProductionMcpResult, StartRunResponse } from './types';

const projectIdSchema = z.string().trim().min(1).max(200);
const runIdSchema = z.string().trim().min(1).max(200);

export const runProductionInputSchema = z.object({
  projectId: projectIdSchema,
  mode: z.enum(['mock', 'real']).optional(),
  providers: z
    .object({
      image: z.enum(['fake', 'openai']).optional(),
      video: z.enum(['local', 'openai']).optional(),
      narration: z.enum(['fake', 'elevenlabs']).optional()
    })
    .optional(),
  maxIterations: z.number().int().positive().max(10_000).optional(),
  limits: z
    .object({
      image_generate: z.number().int().positive().max(128).optional(),
      video_submit: z.number().int().positive().max(128).optional(),
      video_poll: z.number().int().positive().max(128).optional(),
      narration_generate: z.number().int().positive().max(128).optional(),
      scene_render: z.number().int().positive().max(128).optional(),
      final_compose: z.number().int().positive().max(128).optional()
    })
    .optional()
});

export const getRunStatusInputSchema = z.object({
  runId: runIdSchema
});

export const getRunLogInputSchema = z.object({
  runId: runIdSchema,
  cursor: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(2000).optional()
});

export const PRODUCTION_TOOL_DEFINITIONS = [
  {
    name: 'run_production',
    description: 'Start a server-side production run for a project or return the existing active run.',
    inputSchema: runProductionInputSchema,
    annotations: {
      title: 'Run Production',
      readOnlyHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'get_run_status',
    description: 'Get status and progress metadata for a headless production run.',
    inputSchema: getRunStatusInputSchema,
    annotations: {
      title: 'Get Run Status',
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'get_run_log',
    description: 'Get a paginated event log for a headless production run.',
    inputSchema: getRunLogInputSchema,
    annotations: {
      title: 'Get Run Log',
      readOnlyHint: true,
      openWorldHint: false
    }
  }
] as const;

export interface ProductionToolService {
  runProduction(args: unknown): Promise<ProductionMcpResult<StartRunResponse>>;
  getRunStatus(args: unknown): Promise<ProductionMcpResult<GetRunStatusResponse>>;
  getRunLog(args: unknown): Promise<ProductionMcpResult<GetRunLogResponse>>;
}

export function createProductionToolService(apiClient: ProductionApiClient = new HttpProductionApiClient()): ProductionToolService {
  return {
    async runProduction(args: unknown) {
      try {
        const parsed = runProductionInputSchema.parse(args ?? {});
        const result = await apiClient.runProduction(parsed.projectId, {
          mode: parsed.mode,
          providers: parsed.providers,
          maxIterations: parsed.maxIterations,
          limits: parsed.limits
        });

        return toSuccess({
          run: result.run,
          reused: result.reused
        });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async getRunStatus(args: unknown) {
      try {
        const parsed = getRunStatusInputSchema.parse(args ?? {});
        const run = await apiClient.getRunStatus(parsed.runId);
        return toSuccess({ run });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async getRunLog(args: unknown) {
      try {
        const parsed = getRunLogInputSchema.parse(args ?? {});
        const log = await apiClient.getRunLog(parsed.runId, {
          cursor: parsed.cursor,
          limit: parsed.limit
        });
        return toSuccess({ log });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    }
  };
}

function fromValidationError(error: unknown): unknown {
  if (error instanceof z.ZodError) {
    return new ProductionMcpToolError('INVALID_ARGUMENT', 'Invalid tool arguments.', {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message
      }))
    });
  }

  return error;
}

function asToolResponse(result: ProductionMcpResult<unknown>) {
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

export function registerProductionTools(server: McpServer, service: ProductionToolService): void {
  server.registerTool(
    'run_production',
    {
      description: PRODUCTION_TOOL_DEFINITIONS[0].description,
      inputSchema: PRODUCTION_TOOL_DEFINITIONS[0].inputSchema,
      annotations: PRODUCTION_TOOL_DEFINITIONS[0].annotations
    },
    async (args) => asToolResponse(await service.runProduction(args))
  );

  server.registerTool(
    'get_run_status',
    {
      description: PRODUCTION_TOOL_DEFINITIONS[1].description,
      inputSchema: PRODUCTION_TOOL_DEFINITIONS[1].inputSchema,
      annotations: PRODUCTION_TOOL_DEFINITIONS[1].annotations
    },
    async (args) => asToolResponse(await service.getRunStatus(args))
  );

  server.registerTool(
    'get_run_log',
    {
      description: PRODUCTION_TOOL_DEFINITIONS[2].description,
      inputSchema: PRODUCTION_TOOL_DEFINITIONS[2].inputSchema,
      annotations: PRODUCTION_TOOL_DEFINITIONS[2].annotations
    },
    async (args) => asToolResponse(await service.getRunLog(args))
  );
}
