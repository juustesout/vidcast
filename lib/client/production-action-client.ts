import type { Scene } from '@/lib/types/scene';
import type { ProductionPlannedAction } from '@/lib/production/production-planner';
import { createProductionRunnerError, type ProductionActionExecutionOutcome } from '@/lib/production/production-runner';
import { resolveVideoProviderForwarding } from '@/lib/generation/video-provider-forwarding';
import { createProjectCompositionRequest, createSceneNarrationRequest, createSceneRenderRequest } from '@/lib/client/render-client';

export interface ProductionActionLifecycle {
  setSceneGenerating?: (sceneId: string | null) => void;
  setSceneNarrating?: (sceneId: string | null) => void;
  setSceneRendering?: (sceneId: string | null) => void;
  setComposing?: (composing: boolean) => void;
  setCompositionFailed?: (failed: boolean) => void;
}

export interface ProductionActionClientOptions {
  projectId: string;
  scenes: Scene[];
  lifecycle?: ProductionActionLifecycle;
}

export async function executeProductionActionRequest(
  action: ProductionPlannedAction,
  { projectId, scenes, lifecycle }: ProductionActionClientOptions
): Promise<ProductionActionExecutionOutcome | void> {
  if (!action.execute) {
    return;
  }

  if (action.type === 'image_generate' && action.sceneId) {
    const regenerate = Boolean(action.payload?.regenerate);
    lifecycle?.setSceneGenerating?.(action.sceneId);
    const endpoint = `/api/projects/${projectId}/scenes/${action.sceneId}/generate-image`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate })
    });
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      code?: string;
      status?: string;
      providerStatus?: string;
      generationAttemptId?: string;
    };
    lifecycle?.setSceneGenerating?.(null);
    if (!response.ok) {
      throw createProductionRunnerError(body.message || 'Image generation failed.', {
        message: body.message || 'Image generation failed.',
        code: body.code,
        endpoint,
        httpStatus: response.status,
        providerStatus: body.providerStatus,
        sceneId: action.sceneId,
        attemptId: body.generationAttemptId
      });
    }
    return {
      message: body.message || body.status || 'Image generation completed.',
      endpoint,
      providerStatus: body.providerStatus,
      sceneId: action.sceneId,
      attemptId: body.generationAttemptId
    };
  }

  if (action.type === 'html_render' && action.sceneId) {
    const regenerate = Boolean(action.payload?.regenerate);
    lifecycle?.setSceneGenerating?.(action.sceneId);
    const endpoint = `/api/projects/${projectId}/scenes/${action.sceneId}/render-html-still`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate })
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string; assetId?: string };
    lifecycle?.setSceneGenerating?.(null);
    if (!response.ok) {
      throw createProductionRunnerError(body.message || 'HTML still render failed.', {
        message: body.message || 'HTML still render failed.',
        code: body.code,
        endpoint,
        httpStatus: response.status,
        sceneId: action.sceneId
      });
    }
    return {
      message: body.message || 'HTML still PNG rendered.',
      endpoint,
      sceneId: action.sceneId,
      details: body.assetId
    };
  }

  if (action.type === 'video_submit' && action.sceneId) {
    const regenerate = Boolean(action.payload?.regenerate);
    // The client batch runner must honour the scene's explicit video provider
    // (and model) so automated generation matches a manual submit, while never
    // forwarding the mock sentinel or forcing a mock/real mismatch. The server
    // remains the authority and re-validates the forwarded selection.
    const scene = scenes.find((entry) => entry.id === action.sceneId);
    const videoGeneration = scene?.visual && scene.visual.kind === 'generated_video' ? scene.visual.generation : undefined;
    const { provider, model } = resolveVideoProviderForwarding(videoGeneration);
    lifecycle?.setSceneGenerating?.(action.sceneId);
    const endpoint = `/api/projects/${projectId}/scenes/${action.sceneId}/generate-video`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate, provider, model })
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string; status?: string; providerStatus?: string; generationAttemptId?: string };
    lifecycle?.setSceneGenerating?.(null);
    if (!response.ok) {
      throw createProductionRunnerError(body.message || 'Video submit failed.', {
        message: body.message || 'Video submit failed.',
        code: body.code,
        endpoint,
        httpStatus: response.status,
        providerStatus: body.providerStatus,
        sceneId: action.sceneId,
        attemptId: body.generationAttemptId
      });
    }
    return {
      message: body.message || body.status || 'Video generation submitted.',
      endpoint,
      providerStatus: body.providerStatus,
      sceneId: action.sceneId,
      attemptId: body.generationAttemptId
    };
  }

  if (action.type === 'video_poll') {
    const attemptId = String(action.payload?.attemptId ?? '');
    if (!attemptId) {
      throw createProductionRunnerError('Missing video attempt id for polling.', {
        endpoint: `/api/projects/${projectId}/generation-jobs/:attemptId`,
        message: 'Missing video attempt id for polling.'
      });
    }
    const endpoint = `/api/projects/${projectId}/generation-jobs/${attemptId}`;
    const response = await fetch(endpoint);
    const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string; status?: string; providerStatus?: string };
    if (!response.ok) {
      throw createProductionRunnerError(body.message || 'Video poll failed.', {
        message: body.message || 'Video poll failed.',
        code: body.code,
        endpoint,
        httpStatus: response.status,
        providerStatus: body.providerStatus,
        sceneId: action.sceneId,
        attemptId
      });
    }
    return {
      message: body.message || body.status || 'Video poll completed.',
      endpoint,
      providerStatus: body.providerStatus,
      sceneId: action.sceneId,
      attemptId
    };
  }

  if (action.type === 'narration_generate' && action.sceneId) {
    const scene = scenes.find((entry) => entry.id === action.sceneId);
    if (!scene) {
      throw createProductionRunnerError(`Scene ${action.sceneId} not found for narration.`, {
        endpoint: `/api/projects/${projectId}/scenes/${action.sceneId}/generate-narration`,
        sceneId: action.sceneId
      });
    }

    const mode = String(action.payload?.mode ?? 'generate');
    lifecycle?.setSceneNarrating?.(action.sceneId);
    const result = await createSceneNarrationRequest(projectId, action.sceneId, {
      text: scene.narration?.text,
      voiceId: scene.narration?.voiceId,
      model: scene.narration?.model,
      format: scene.narration?.format ?? 'mp3',
      regenerate: mode === 'regenerate',
      retry: mode === 'retry'
    });
    lifecycle?.setSceneNarrating?.(null);
    if (!result.ok) {
      throw createProductionRunnerError(result.message || 'Narration generation failed.', {
        message: result.message || 'Narration generation failed.',
        endpoint: `/api/projects/${projectId}/scenes/${action.sceneId}/generate-narration`,
        sceneId: action.sceneId,
        attemptId: result.narration?.generationAttemptId
      });
    }
    return {
      message: result.message || 'Narration generation completed.',
      endpoint: `/api/projects/${projectId}/scenes/${action.sceneId}/generate-narration`,
      sceneId: action.sceneId,
      attemptId: result.narration?.generationAttemptId
    };
  }

  if (action.type === 'scene_render' && action.sceneId) {
    lifecycle?.setSceneRendering?.(action.sceneId);
    const result = await createSceneRenderRequest(projectId, action.sceneId);
    lifecycle?.setSceneRendering?.(null);
    if (!result.ok) {
      throw createProductionRunnerError(result.message || 'Scene render failed.', {
        message: result.message || 'Scene render failed.',
        code: result.code,
        details: result.details,
        endpoint: `/api/projects/${projectId}/scenes/${action.sceneId}/render`,
        sceneId: action.sceneId
      });
    }
    return {
      message: result.message || 'Scene render completed.',
      code: result.code,
      details: result.details,
      endpoint: `/api/projects/${projectId}/scenes/${action.sceneId}/render`,
      sceneId: action.sceneId
    };
  }

  if (action.type === 'final_compose') {
    lifecycle?.setComposing?.(true);
    lifecycle?.setCompositionFailed?.(false);
    const result = await createProjectCompositionRequest(projectId);
    lifecycle?.setComposing?.(false);
    if (!result.ok) {
      lifecycle?.setCompositionFailed?.(true);
      throw createProductionRunnerError(result.message || 'Final composition failed.', {
        message: result.message || 'Final composition failed.',
        code: result.code,
        details: result.details,
        endpoint: `/api/projects/${projectId}/compose`
      });
    }
    lifecycle?.setCompositionFailed?.(false);
    return {
      message: result.message || 'Final composition completed.',
      code: result.code,
      details: result.details,
      endpoint: `/api/projects/${projectId}/compose`
    };
  }
}
