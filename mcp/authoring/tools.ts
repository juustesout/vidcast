import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { AuthoringApiClient } from './api-client';
import { HttpAuthoringApiClient } from './api-client';
import { AuthoringMcpToolError, toFailure, toSuccess } from './errors';
import type {
  ApproveSceneIntentsResponse,
  AuthoringMcpResult,
  AttachAnimationResponse,
  CancelVideoResponse,
  CreateProjectResponse,
  CreateReferenceResponse,
  GenerateVideoResponse,
  ImportStudioAssetsResponse,
  ManageProjectMusicResponse,
  MaterializeSceneIntentsResponse,
  PlanSceneIntentsResponse,
  RenderAnimationTemplateResponse,
  UpdateProjectResponse
} from './types';

const projectIdSchema = z.string().trim().min(1).max(200);
const sceneIdSchema = z.string().trim().min(1).max(200);
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

export const approveSceneIntentsInputSchema = z.object({
  projectId: projectIdSchema,
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

// Reference images are the visual inputs the video providers consume. The
// content is passed inline as base64 (or a full data URL) so the agent does not
// need a second transport; the server caps and validates the payload.
export const createReferenceInputSchema = z.object({
  projectId: projectIdSchema,
  name: z.string().trim().min(1).max(200),
  contentBase64: z.string().min(1).max(40_000_000),
  mimeType: z.string().trim().max(100).optional(),
  fileName: z.string().trim().max(200).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional()
});

export const importStudioAssetsInputSchema = z.object({
  projectId: projectIdSchema,
  fileNames: z.array(z.string().trim().min(1).max(200)).min(1).max(20)
});

export const generateVideoInputSchema = z.object({
  projectId: projectIdSchema,
  sceneId: sceneIdSchema,
  regenerate: z.boolean().optional(),
  provider: z.string().trim().max(100).optional(),
  model: z.string().trim().max(300).optional(),
  mode: z.enum(['mock', 'real']).optional()
});

export const cancelVideoInputSchema = z.object({
  projectId: projectIdSchema,
  sceneId: sceneIdSchema
});

export const renderAnimationTemplateInputSchema = z.object({
  projectId: projectIdSchema,
  templateId: z.enum(['northwind_arr_chart', 'nix_overlay']),
  params: z.record(z.string(), z.unknown()).optional()
}).strict();

export const attachAnimationInputSchema = z.object({
  projectId: projectIdSchema,
  sceneId: sceneIdSchema,
  assetId: z.string().trim().min(1).max(200),
  destination: z.enum(['bigscreen', 'overlay']),
  startSeconds: z.number().min(0).max(600).optional(),
  durationSeconds: z.number().min(0.04).max(600).optional(),
  scale: z.number().min(0.05).max(2).optional(),
  position: z.object({
    x: z.number().min(-1920).max(3840),
    y: z.number().min(-1080).max(2160)
  }).strict().optional(),
  rect: z.object({
    x: z.number().min(-1920).max(3840),
    y: z.number().min(-1080).max(2160),
    width: z.number().min(1).max(1920),
    height: z.number().min(1).max(1080)
  }).strict().optional()
}).strict();

export const AUTHORING_TOOL_DEFINITIONS = [
  {
    name: 'create_project',
    description:
      'Create a new explainer project via POST /api/projects and return its projectId. Requires authentication (EXPLAINER_API_TOKEN as a bearer token). Not idempotent: calling it twice creates two projects. Use list_projects first if you only want to reuse an existing project. On 401 the error code is UNAUTHENTICATED. When the caller is a service (as with the MCP bearer token), the project is created ownerless and the response also contains a single-use claimToken: hand it to the intended user out-of-band (never place it in a URL, log or analytics event) so they can claim the project via POST /api/projects/{id}/claim with the token in the request body. The token is returned only once and expires.',
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
      'Update a project (title, description, narration, scenes, story beats, renderSettings, music reference) via PUT /api/projects/{id}. The server validates the merged project; invalid input returns code VALIDATION_FAILED with details.errors and details.warnings. Note that project.scenes replaces the entire scenes array (it is not merged field-by-field), and production narration is set per scene in scene.narration.text. A 403 means the caller does not own the project; 404 means the project does not exist. Video scenes are edited through this patch: set scene.visual.kind="generated_video" with scene.visual.generation.{prompt,provider,model,startFrameReferenceId,endFrameReferenceId} plus scene.referenceIds, and scene.overlay={type,...} for text overlays. startFrameReferenceId/endFrameReferenceId must each be one of the effective reference ids (scene.referenceIds, or generation.referenceIds when set) and are preserved across later updates. provider is optional (e.g. openai|fal|local); model selects the endpoint (e.g. a FAL image-to-video vs text-to-video endpoint). HTML still scenes use scene.type="html" and scene.visual.kind="html" with template headline_card or comparison_card (or custom html/css); production action html_render writes a local PNG and binds it to the studio bigscreen.',
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
    name: 'approve_scene_intents',
    description:
      'Approve drafted scene intents so they can be materialized via POST /api/projects/{id}/scene-intents/approve. Optionally pass explicit intentIds; when omitted, every not-yet-approved intent is approved. Already-approved intents are reported under skipped. An unknown intent id returns NOT_FOUND. This only changes intent status; it never creates scenes. Approval is required before materialize_scene_intents can turn drafts into scenes.',
    inputSchema: approveSceneIntentsInputSchema,
    annotations: {
      title: 'Approve Scene Intents',
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
  },
  {
    name: 'create_reference',
    description:
      'Attach a reference image to a project via POST /api/projects/{id}/references (JSON, base64 content). Reference images are the visual inputs video generation consumes, including image-to-video start/end keyframes. `contentBase64` accepts raw base64 or a full `data:image/...;base64,...` URL; png/jpg/jpeg/webp are accepted and the decoded payload is capped at 25 MB. Returns the created referenceId plus its stored filePath and dimensions, so scenes can reference it (scene.referenceIds and generation.startFrameReferenceId/endFrameReferenceId). Invalid content returns INVALID_ARGUMENT; a bad project id returns NOT_FOUND.',
    inputSchema: createReferenceInputSchema,
    annotations: {
      title: 'Create Reference Image',
      readOnlyHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'import_studio_assets',
    description:
      'Copy selected studio image files from the configured operator source directory (STUDIO_IMPORT_SOURCE_DIR, typically tmp_images) into the project assets/studio folder via POST /api/projects/{id}/studio-assets. Requires an explicit fileNames list of bare names such as studio_back.png, studio_desk.png, studio_intro.png, studio_outtro.png, plus optional extra png/jpg/jpeg/webp images. Path traversal and absolute paths are rejected. Existing project files are never overwritten. Returns project-relative localPath values so later render work does not depend on tmp_images. Missing source dir/files return NOT_FOUND; unconfigured source returns PROVIDER_NOT_CONFIGURED; collisions return CONFLICT.',
    inputSchema: importStudioAssetsInputSchema,
    annotations: {
      title: 'Import Studio Assets',
      readOnlyHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'generate_video',
    description:
      'Submit (or regenerate) a single scene video via POST /api/projects/{id}/scenes/{sceneId}/generate-video. This is the manual alternative to run_production for one scene. It forwards an explicit `provider` and `model` (e.g. provider=fal, model=minimax/h3-max-turbo/image-to-video for image-to-video, or .../text-to-video for text-to-video) and an optional `mode` (mock|real). The start/end frames and the reference set come from the scene, not this call: set scene.referenceIds and scene.visual.generation.startFrameReferenceId/endFrameReferenceId with update_project first. GENERATION IS AN EXPLICIT PAID ACTION in real mode; it is never retried automatically. Mock mode only allows the local video provider; real mode requires a real provider and its credentials. A scene that already has an active job returns CONFLICT (generation.scene.busy) so a second paid submit can never be started.',
    inputSchema: generateVideoInputSchema,
    annotations: {
      title: 'Generate Scene Video',
      readOnlyHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'cancel_video',
    description:
      'Cancel the active remote video generation for a scene via POST /api/projects/{id}/scenes/{sceneId}/cancel-video. Cancellation is explicit: an unsupported provider returns CONFLICT (generation.provider.cancelUnsupported), a remote cancel failure returns CONFLICT (generation.provider.cancelFailed) and keeps the attempt active so the job is never abandoned or double-submitted, and no active job returns CONFLICT (generation.scene.notActive). The terminal state is applied only to the active attempt observed, so a job that already finished is never overwritten.',
    inputSchema: cancelVideoInputSchema,
    annotations: {
      title: 'Cancel Scene Video',
      readOnlyHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'render_animation_template',
    description:
      'Render a server-owned Motion Canvas template into a project asset via POST /api/projects/{id}/animations/render. templateId must be northwind_arr_chart (opaque 1920x1080 H.264 bigscreen) or nix_overlay (transparent VP9/WebM overlay). params is optional structured JSON merged with catalog defaults; unknown keys, generated code, and unsafe paths are rejected. Returns assetId and project-relative localPath. A failed render does not attach anything to a scene.',
    inputSchema: renderAnimationTemplateInputSchema,
    annotations: {
      title: 'Render Animation Template',
      readOnlyHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'attach_animation',
    description:
      'Attach a previously rendered Motion Canvas asset to a scene composition via POST /api/projects/{id}/scenes/{sceneId}/animations/attach. destination=bigscreen writes the studio-screen image layer; destination=overlay writes the studio-overlay layer (z=25). Optional startSeconds/durationSeconds, scale, position, and rect. Presenter PiP and desk are left unchanged. Requires an existing asset from render_animation_template; never invents paths.',
    inputSchema: attachAnimationInputSchema,
    annotations: {
      title: 'Attach Animation',
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
  approveSceneIntents(args: unknown): Promise<AuthoringMcpResult<ApproveSceneIntentsResponse>>;
  manageProjectMusic(args: unknown): Promise<AuthoringMcpResult<ManageProjectMusicResponse>>;
  createReference(args: unknown): Promise<AuthoringMcpResult<CreateReferenceResponse>>;
  importStudioAssets(args: unknown): Promise<AuthoringMcpResult<ImportStudioAssetsResponse>>;
  generateVideo(args: unknown): Promise<AuthoringMcpResult<GenerateVideoResponse>>;
  cancelVideo(args: unknown): Promise<AuthoringMcpResult<CancelVideoResponse>>;
  renderAnimationTemplate(args: unknown): Promise<AuthoringMcpResult<RenderAnimationTemplateResponse>>;
  attachAnimation(args: unknown): Promise<AuthoringMcpResult<AttachAnimationResponse>>;
}

export function createAuthoringToolService(apiClient: AuthoringApiClient = new HttpAuthoringApiClient()): AuthoringToolService {
  return {
    async createProject(args: unknown) {
      try {
        const parsed = createProjectInputSchema.parse(args ?? {});
        const result = await apiClient.createProject(parsed);
        const response: CreateProjectResponse = {
          projectId: result.project.id,
          title: result.project.title,
          valid: true as const
        };
        if (result.claimToken) {
          response.claimToken = result.claimToken;
        }
        return toSuccess(response);
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

    async approveSceneIntents(args: unknown) {
      try {
        const parsed = approveSceneIntentsInputSchema.parse(args ?? {});
        const result = await apiClient.approveSceneIntents(parsed.projectId, parsed.intentIds);
        return toSuccess({
          projectId: result.project.id,
          valid: true as const,
          approved: result.approved,
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
    },

    async createReference(args: unknown) {
      try {
        const parsed = createReferenceInputSchema.parse(args ?? {});
        const result = await apiClient.createReference(parsed.projectId, {
          name: parsed.name,
          contentBase64: parsed.contentBase64,
          mimeType: parsed.mimeType,
          fileName: parsed.fileName,
          description: parsed.description,
          tags: parsed.tags
        });
        const metadata = result.reference.metadata ?? {};
        return toSuccess({
          projectId: parsed.projectId,
          referenceId: result.reference.id,
          name: result.reference.name,
          filePath: result.reference.filePath,
          mimeType: typeof metadata.mimeType === 'string' ? metadata.mimeType : undefined,
          width: typeof metadata.width === 'number' ? metadata.width : undefined,
          height: typeof metadata.height === 'number' ? metadata.height : undefined,
          filesize: typeof metadata.filesize === 'number' ? metadata.filesize : undefined
        });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async importStudioAssets(args: unknown) {
      try {
        const parsed = importStudioAssetsInputSchema.parse(args ?? {});
        const result = await apiClient.importStudioAssets(parsed.projectId, { fileNames: parsed.fileNames });
        return toSuccess({
          projectId: result.projectId,
          assets: result.assets.map((asset) => ({
            assetId: asset.id,
            filename: asset.filename,
            localPath: asset.localPath ?? `assets/studio/${asset.filename}`,
            mimeType: asset.mimeType,
            width: asset.width,
            height: asset.height,
            filesize: asset.filesize
          }))
        });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async generateVideo(args: unknown) {
      try {
        const parsed = generateVideoInputSchema.parse(args ?? {});
        const result = await apiClient.generateVideo(parsed.projectId, parsed.sceneId, {
          regenerate: parsed.regenerate,
          provider: parsed.provider,
          model: parsed.model,
          mode: parsed.mode
        });
        return toSuccess({
          projectId: parsed.projectId,
          sceneId: result.sceneId,
          generationAttemptId: result.generationAttemptId,
          status: result.status,
          provider: result.provider,
          model: result.model,
          providerJobId: result.providerJobId,
          providerStatus: result.providerStatus
        });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async cancelVideo(args: unknown) {
      try {
        const parsed = cancelVideoInputSchema.parse(args ?? {});
        const result = await apiClient.cancelVideo(parsed.projectId, parsed.sceneId);
        return toSuccess({
          projectId: parsed.projectId,
          sceneId: result.sceneId,
          generationAttemptId: result.generationAttemptId,
          status: result.status,
          provider: result.provider,
          model: result.model,
          providerJobId: result.providerJobId,
          providerStatus: result.providerStatus
        });
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async renderAnimationTemplate(args: unknown) {
      try {
        const parsed = renderAnimationTemplateInputSchema.parse(args ?? {});
        const result = await apiClient.renderAnimationTemplate(parsed.projectId, {
          templateId: parsed.templateId,
          params: parsed.params
        });
        return toSuccess(result);
      } catch (error) {
        return toFailure(fromValidationError(error));
      }
    },

    async attachAnimation(args: unknown) {
      try {
        const parsed = attachAnimationInputSchema.parse(args ?? {});
        const result = await apiClient.attachAnimation(parsed.projectId, parsed.sceneId, {
          assetId: parsed.assetId,
          destination: parsed.destination,
          startSeconds: parsed.startSeconds,
          durationSeconds: parsed.durationSeconds,
          scale: parsed.scale,
          position: parsed.position,
          rect: parsed.rect
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
    async (args) => asToolResponse(await service.approveSceneIntents(args))
  );

  server.registerTool(
    AUTHORING_TOOL_DEFINITIONS[5].name,
    {
      description: AUTHORING_TOOL_DEFINITIONS[5].description,
      inputSchema: AUTHORING_TOOL_DEFINITIONS[5].inputSchema,
      annotations: AUTHORING_TOOL_DEFINITIONS[5].annotations
    },
    async (args) => asToolResponse(await service.manageProjectMusic(args))
  );

  server.registerTool(
    AUTHORING_TOOL_DEFINITIONS[6].name,
    {
      description: AUTHORING_TOOL_DEFINITIONS[6].description,
      inputSchema: AUTHORING_TOOL_DEFINITIONS[6].inputSchema,
      annotations: AUTHORING_TOOL_DEFINITIONS[6].annotations
    },
    async (args) => asToolResponse(await service.createReference(args))
  );

  server.registerTool(
    AUTHORING_TOOL_DEFINITIONS[7].name,
    {
      description: AUTHORING_TOOL_DEFINITIONS[7].description,
      inputSchema: AUTHORING_TOOL_DEFINITIONS[7].inputSchema,
      annotations: AUTHORING_TOOL_DEFINITIONS[7].annotations
    },
    async (args) => asToolResponse(await service.importStudioAssets(args))
  );

  server.registerTool(
    AUTHORING_TOOL_DEFINITIONS[8].name,
    {
      description: AUTHORING_TOOL_DEFINITIONS[8].description,
      inputSchema: AUTHORING_TOOL_DEFINITIONS[8].inputSchema,
      annotations: AUTHORING_TOOL_DEFINITIONS[8].annotations
    },
    async (args) => asToolResponse(await service.generateVideo(args))
  );

  server.registerTool(
    AUTHORING_TOOL_DEFINITIONS[9].name,
    {
      description: AUTHORING_TOOL_DEFINITIONS[9].description,
      inputSchema: AUTHORING_TOOL_DEFINITIONS[9].inputSchema,
      annotations: AUTHORING_TOOL_DEFINITIONS[9].annotations
    },
    async (args) => asToolResponse(await service.cancelVideo(args))
  );

  server.registerTool(
    AUTHORING_TOOL_DEFINITIONS[10].name,
    {
      description: AUTHORING_TOOL_DEFINITIONS[10].description,
      inputSchema: AUTHORING_TOOL_DEFINITIONS[10].inputSchema,
      annotations: AUTHORING_TOOL_DEFINITIONS[10].annotations
    },
    async (args) => asToolResponse(await service.renderAnimationTemplate(args))
  );

  server.registerTool(
    AUTHORING_TOOL_DEFINITIONS[11].name,
    {
      description: AUTHORING_TOOL_DEFINITIONS[11].description,
      inputSchema: AUTHORING_TOOL_DEFINITIONS[11].inputSchema,
      annotations: AUTHORING_TOOL_DEFINITIONS[11].annotations
    },
    async (args) => asToolResponse(await service.attachAnimation(args))
  );
}
