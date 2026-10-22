import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeProductionActionRequest } from '@/lib/client/production-action-client';
import { ProductionRunnerExecutionError } from '@/lib/production/production-runner';
import type { ProductionActionType, ProductionPlannedAction } from '@/lib/production/production-planner';
import type { Scene } from '@/lib/types/scene';

function makeAction(type: ProductionActionType, sceneId?: string, payload?: Record<string, unknown>): ProductionPlannedAction {
  return {
    id: `${type}-${sceneId ?? 'global'}`,
    type,
    sceneId,
    status: 'ready',
    execute: true,
    dependencyActionIds: [],
    payload
  };
}

function makeScene(id: string, generation?: { provider?: string; model?: string }): Scene {
  return {
    id,
    order: 1,
    duration: 5,
    type: 'generated',
    visual: generation
      ? { kind: 'generated_video', generation }
      : undefined,
    render: {} as Scene['render'],
    referenceIds: [],
    notes: ''
  } as unknown as Scene;
}

function makeLifecycle() {
  return {
    setSceneGenerating: vi.fn(),
    setSceneNarrating: vi.fn(),
    setSceneRendering: vi.fn(),
    setComposing: vi.fn(),
    setCompositionFailed: vi.fn()
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('executeProductionActionRequest', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns early without fetching when the action is not executable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeProductionActionRequest({ ...makeAction('image_generate', 's1'), execute: false }, {
      projectId: 'p1',
      scenes: []
    });

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits an image generation and reports the lifecycle', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'queued', status: 'running', providerStatus: 'pending', generationAttemptId: 'att-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const lifecycle = makeLifecycle();

    const result = await executeProductionActionRequest(makeAction('image_generate', 's1', { regenerate: true }), {
      projectId: 'p1',
      scenes: [],
      lifecycle
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe('/api/projects/p1/scenes/s1/generate-image');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ regenerate: true });
    expect(lifecycle.setSceneGenerating.mock.calls).toEqual([['s1'], [null]]);
    expect(result).toMatchObject({ message: 'queued', endpoint, providerStatus: 'pending', sceneId: 's1', attemptId: 'att-1' });
  });

  it('maps a failed image generation to a runner error carrying diagnostics', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'no provider', code: 'PROVIDER_NOT_CONFIGURED', providerStatus: 'failed', generationAttemptId: 'att-2' }, 409)));
    const lifecycle = makeLifecycle();

    const error = await executeProductionActionRequest(makeAction('image_generate', 's1'), {
      projectId: 'p1',
      scenes: [],
      lifecycle
    }).catch((err) => err);

    expect(error).toBeInstanceOf(ProductionRunnerExecutionError);
    expect(error.diagnostics).toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED', httpStatus: 409, sceneId: 's1', attemptId: 'att-2' });
    expect(lifecycle.setSceneGenerating.mock.calls).toEqual([['s1'], [null]]);
  });

  it('forwards the effective real video provider and model when submitting video', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'running', generationAttemptId: 'att-3' }));
    vi.stubGlobal('fetch', fetchMock);
    const lifecycle = makeLifecycle();

    await executeProductionActionRequest(makeAction('video_submit', 's1', { regenerate: false }), {
      projectId: 'p1',
      scenes: [makeScene('s1', { provider: 'fal', model: ' minimax/h3-max-turbo/text-to-video ' })],
      lifecycle
    });

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe('/api/projects/p1/scenes/s1/generate-video');
    expect(JSON.parse(String(init.body))).toEqual({ regenerate: false, provider: 'fal', model: 'minimax/h3-max-turbo/text-to-video' });
    expect(lifecycle.setSceneGenerating.mock.calls).toEqual([['s1'], [null]]);
  });

  it('never forwards the mock sentinel for a scene without a real provider', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'running' }));
    vi.stubGlobal('fetch', fetchMock);

    await executeProductionActionRequest(makeAction('video_submit', 's1'), {
      projectId: 'p1',
      scenes: [makeScene('s1', { provider: 'local', model: 'mock' })],
      lifecycle: makeLifecycle()
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ regenerate: false });
  });

  it('polls a video job and returns the attempt id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'done', status: 'succeeded', providerStatus: 'succeeded' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeProductionActionRequest(makeAction('video_poll', 's1', { attemptId: 'att-9' }), {
      projectId: 'p1',
      scenes: [],
      lifecycle: makeLifecycle()
    });

    const [endpoint] = fetchMock.mock.calls[0] as unknown as [string];
    expect(endpoint).toBe('/api/projects/p1/generation-jobs/att-9');
    expect(result).toMatchObject({ message: 'done', endpoint, attemptId: 'att-9', sceneId: 's1' });
  });

  it('rejects a video poll with no attempt id before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const error = await executeProductionActionRequest(makeAction('video_poll', 's1'), {
      projectId: 'p1',
      scenes: [],
      lifecycle: makeLifecycle()
    }).catch((err) => err);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ProductionRunnerExecutionError);
    expect(error.diagnostics).toMatchObject({ endpoint: '/api/projects/p1/generation-jobs/:attemptId' });
  });

  it('generates narration from the stored scene narration and reports the attempt', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'ok', assetId: 'aud-1', generationAttemptId: 'att-n1' }));
    vi.stubGlobal('fetch', fetchMock);
    const lifecycle = makeLifecycle();
    const scene = makeScene('s1');
    scene.narration = { text: 'hello', voiceId: 'voice-1', model: 'tts-1', format: 'mp3' };

    const result = await executeProductionActionRequest(makeAction('narration_generate', 's1', { mode: 'regenerate' }), {
      projectId: 'p1',
      scenes: [scene],
      lifecycle
    });

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe('/api/projects/p1/scenes/s1/generate-narration');
    expect(JSON.parse(String(init.body))).toMatchObject({ text: 'hello', voiceId: 'voice-1', regenerate: true, retry: false, format: 'mp3' });
    expect(lifecycle.setSceneNarrating.mock.calls).toEqual([['s1'], [null]]);
    expect(result).toMatchObject({ endpoint, sceneId: 's1', attemptId: 'att-n1' });
  });

  it('throws when narration targets a scene that is not present', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const error = await executeProductionActionRequest(makeAction('narration_generate', 'missing'), {
      projectId: 'p1',
      scenes: [],
      lifecycle: makeLifecycle()
    }).catch((err) => err);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ProductionRunnerExecutionError);
    expect(error.diagnostics).toMatchObject({ sceneId: 'missing' });
  });

  it('renders a scene and surfaces the render artifact', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'rendered', render: { renderId: 'r1', outputPath: 'out.mp4' } }));
    vi.stubGlobal('fetch', fetchMock);
    const lifecycle = makeLifecycle();

    const result = await executeProductionActionRequest(makeAction('scene_render', 's1'), {
      projectId: 'p1',
      scenes: [],
      lifecycle
    });

    const [endpoint] = fetchMock.mock.calls[0] as unknown as [string];
    expect(endpoint).toBe('/api/projects/p1/scenes/s1/render');
    expect(lifecycle.setSceneRendering.mock.calls).toEqual([['s1'], [null]]);
    expect(result).toMatchObject({ message: 'rendered', endpoint, sceneId: 's1' });
  });

  it('maps a failed scene render to a runner error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'ffmpeg failed', code: 'RENDER_FAILED', details: 'stderr' }, 500)));

    const error = await executeProductionActionRequest(makeAction('scene_render', 's1'), {
      projectId: 'p1',
      scenes: [],
      lifecycle: makeLifecycle()
    }).catch((err) => err);

    expect(error).toBeInstanceOf(ProductionRunnerExecutionError);
    expect(error.diagnostics).toMatchObject({ code: 'RENDER_FAILED', details: 'stderr', sceneId: 's1' });
  });

  it('drives the composition lifecycle on a successful final compose', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'composed', artifact: { compositionId: 'c1', outputPath: 'final.mp4' } })));
    const lifecycle = makeLifecycle();

    const result = await executeProductionActionRequest(makeAction('final_compose'), {
      projectId: 'p1',
      scenes: [],
      lifecycle
    });

    expect(lifecycle.setComposing.mock.calls).toEqual([[true], [false]]);
    expect(lifecycle.setCompositionFailed.mock.calls).toEqual([[false], [false]]);
    expect(result).toMatchObject({ message: 'composed', endpoint: '/api/projects/p1/compose' });
  });

  it('flags composition failure before throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'compose failed', code: 'COMPOSE_FAILED', details: 'missing scene' }, 422)));
    const lifecycle = makeLifecycle();

    const error = await executeProductionActionRequest(makeAction('final_compose'), {
      projectId: 'p1',
      scenes: [],
      lifecycle
    }).catch((err) => err);

    expect(error).toBeInstanceOf(ProductionRunnerExecutionError);
    expect(error.diagnostics).toMatchObject({ code: 'COMPOSE_FAILED', details: 'missing scene' });
    expect(lifecycle.setComposing.mock.calls).toEqual([[true], [false]]);
    expect(lifecycle.setCompositionFailed.mock.calls).toEqual([[false], [true]]);
  });

  it('renders an HTML still PNG and reports the asset', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'HTML still PNG rendered.', assetId: 'html-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const lifecycle = makeLifecycle();

    const result = await executeProductionActionRequest(makeAction('html_render', 's1', { regenerate: true }), {
      projectId: 'p1',
      scenes: [],
      lifecycle
    });

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe('/api/projects/p1/scenes/s1/render-html-still');
    expect(JSON.parse(String(init.body))).toEqual({ regenerate: true });
    expect(lifecycle.setSceneGenerating.mock.calls).toEqual([['s1'], [null]]);
    expect(result).toMatchObject({ message: 'HTML still PNG rendered.', endpoint, sceneId: 's1', details: 'html-1' });
  });

  it('maps a failed HTML still render to a runner error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'bad html', code: 'html.invalid' }, 400)));
    const lifecycle = makeLifecycle();

    const error = await executeProductionActionRequest(makeAction('html_render', 's1'), {
      projectId: 'p1',
      scenes: [],
      lifecycle
    }).catch((err) => err);

    expect(error).toBeInstanceOf(ProductionRunnerExecutionError);
    expect(error.diagnostics).toMatchObject({ code: 'html.invalid', httpStatus: 400, sceneId: 's1' });
    expect(lifecycle.setSceneGenerating.mock.calls).toEqual([['s1'], [null]]);
  });

  it('returns undefined for an action type with no request mapping', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeProductionActionRequest(makeAction('image_generate'), {
      projectId: 'p1',
      scenes: [],
      lifecycle: makeLifecycle()
    });

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
