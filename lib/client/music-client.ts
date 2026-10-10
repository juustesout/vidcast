'use client';

import { describeMusicError } from '@/lib/music/music-form';

export interface MusicRequestResult {
  ok: boolean;
  status: number;
  code?: string;
  message: string;
  assetId?: string;
  generationAttemptId?: string;
  duration?: number;
  provider?: string;
  model?: string;
  musicLengthMs?: number;
  instrumental?: boolean;
  selectionStatus?: 'generated' | 'cleared';
}

interface MusicResponseBody {
  message?: string;
  code?: string;
  assetId?: string;
  generationAttemptId?: string;
  duration?: number;
  provider?: string;
  model?: string;
  musicLengthMs?: number;
  instrumental?: boolean;
  status?: string;
}

function failure(response: Response, body: MusicResponseBody): MusicRequestResult {
  return {
    ok: false,
    status: response.status,
    code: body.code,
    message: describeMusicError({ status: response.status, code: body.code, message: body.message })
  };
}

// A single request per call; there are deliberately no automatic retries so a
// paid generation is never billed twice by the client.
export async function generateProjectMusicRequest(
  projectId: string,
  payload: { prompt: string; musicLengthMs: number; instrumental: boolean; regenerate?: boolean; model?: string; provider?: string }
): Promise<MusicRequestResult> {
  const response = await fetch(`/api/projects/${projectId}/music`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: payload.regenerate ? 'regenerate' : 'generate',
      prompt: payload.prompt,
      musicLengthMs: payload.musicLengthMs,
      instrumental: payload.instrumental,
      model: payload.model,
      provider: payload.provider
    })
  });

  const body = (await response.json().catch(() => ({}))) as MusicResponseBody;
  if (!response.ok) {
    return failure(response, body);
  }

  return {
    ok: true,
    status: response.status,
    message: payload.regenerate ? 'Music regenerated and saved.' : 'Music generated and saved.',
    assetId: body.assetId,
    generationAttemptId: body.generationAttemptId,
    duration: body.duration,
    provider: body.provider,
    model: body.model,
    musicLengthMs: body.musicLengthMs,
    instrumental: body.instrumental
  };
}

export async function selectProjectMusicRequest(projectId: string, assetId: string): Promise<MusicRequestResult> {
  const response = await fetch(`/api/projects/${projectId}/music`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'select', assetId })
  });

  const body = (await response.json().catch(() => ({}))) as MusicResponseBody;
  if (!response.ok) {
    return failure(response, body);
  }

  return {
    ok: true,
    status: response.status,
    message: 'Selected as background music.',
    assetId,
    selectionStatus: 'generated'
  };
}

export async function clearProjectMusicRequest(projectId: string): Promise<MusicRequestResult> {
  const response = await fetch(`/api/projects/${projectId}/music`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'clear' })
  });

  const body = (await response.json().catch(() => ({}))) as MusicResponseBody;
  if (!response.ok) {
    return failure(response, body);
  }

  return {
    ok: true,
    status: response.status,
    message: 'Background music disabled. The audio file was kept.',
    selectionStatus: 'cleared'
  };
}
