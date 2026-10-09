'use client';

export async function createSceneRenderRequest(projectId: string, sceneId: string): Promise<{ ok: boolean; message: string; code?: string; details?: string; render?: { renderId: string; outputPath: string } }> {
  const response = await fetch(`/api/projects/${projectId}/scenes/${sceneId}/render`, {
    method: 'POST'
  });

  const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string; details?: string; render?: { renderId: string; outputPath: string } };

  return {
    ok: response.ok,
    message: body.message ?? (response.ok ? 'Render completed.' : 'FFmpeg renderer failed.'),
    code: body.code,
    details: body.details,
    render: body.render
  };
}

export async function createProjectCompositionRequest(projectId: string): Promise<{ ok: boolean; message: string; code?: string; details?: string; composition?: { compositionId: string; outputPath: string } }> {
  const response = await fetch(`/api/projects/${projectId}/compose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transition: { type: 'none' } })
  });

  const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string; details?: string; artifact?: { compositionId: string; outputPath: string } };

  return {
    ok: response.ok,
    message: body.message ?? (response.ok ? 'Composition completed.' : 'Composition failed.'),
    code: body.code,
    details: body.details,
    composition: body.artifact
  };
}

export async function createSceneNarrationRequest(
  projectId: string,
  sceneId: string,
  payload: {
    text?: string;
    voiceId?: string;
    model?: string;
    format?: 'mp3' | 'wav' | 'm4a';
    regenerate?: boolean;
    retry?: boolean;
  }
): Promise<{ ok: boolean; message: string; narration?: { assetId: string; generationAttemptId: string; duration?: number } }> {
  const response = await fetch(`/api/projects/${projectId}/scenes/${sceneId}/generate-narration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const body = (await response.json().catch(() => ({}))) as { message?: string; assetId?: string; generationAttemptId?: string; duration?: number };

  return {
    ok: response.ok,
    message: body.message ?? (response.ok ? 'Narration generated.' : 'Narration generation failed.'),
    narration: body.assetId && body.generationAttemptId ? { assetId: body.assetId, generationAttemptId: body.generationAttemptId, duration: body.duration } : undefined
  };
}
