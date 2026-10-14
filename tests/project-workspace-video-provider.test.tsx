import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FAL_VIDEO_MODEL_ENDPOINTS, GENERATION_PROVIDERS, VIDEO_GENERATION_PROVIDERS } from '@/lib/constants';

function workspaceSource(): string {
  return fs.readFileSync(path.join(process.cwd(), 'components/project/project-workspace.tsx'), 'utf8');
}

function productionActionClientSource(): string {
  return fs.readFileSync(path.join(process.cwd(), 'lib/client/production-action-client.ts'), 'utf8');
}

describe('video generation provider/import constants', () => {
  it('adds fal to the video provider list without changing the image provider list', () => {
    expect(VIDEO_GENERATION_PROVIDERS).toContain('fal');
    // Every video-capable shared provider is kept.
    for (const provider of ['openai', 'local', 'other'] as const) {
      expect(VIDEO_GENERATION_PROVIDERS).toContain(provider);
    }
    // gemini is image-only and must not leak into the video list.
    expect(VIDEO_GENERATION_PROVIDERS).not.toContain('gemini');
    // Image generation is unchanged: fal is video-only.
    expect(GENERATION_PROVIDERS).not.toContain('fal');
  });

  it('suggests only validated FAL video model endpoints', () => {
    expect(FAL_VIDEO_MODEL_ENDPOINTS).toEqual([
      'minimax/h3-max-turbo/text-to-video',
      'minimax/h3-max-turbo/image-to-video'
    ]);
  });
});

describe('ProjectWorkspace image-to-video authoring', () => {
  it('exposes a video provider dropdown that includes fal and keeps image providers separate', () => {
    const source = workspaceSource();

    expect(source).toContain('VIDEO_GENERATION_PROVIDERS');
    expect(source).toContain("selectedScene.visual.kind === 'generated_video' ? VIDEO_GENERATION_PROVIDERS : GENERATION_PROVIDERS");
  });

  it('exposes a model field wired to the canonical generation object', () => {
    const source = workspaceSource();

    expect(source).toContain('label="Model"');
    expect(source).toContain('selectedScene.visual.generation.model ?? ');
    expect(source).toContain('FAL_VIDEO_MODEL_ENDPOINTS');
    expect(source).toContain('generation: { ...scene.visual.generation, model: trimmed ? trimmed : undefined }');
  });

  it('exposes start and end frame selectors backed by references', () => {
    const source = workspaceSource();

    expect(source).toContain('label="Start frame"');
    expect(source).toContain('label="End frame (optional)"');
    expect(source).toContain('function setSceneFrame');
    expect(source).toContain('startFrameReferenceId: role ===');
    expect(source).toContain('endFrameReferenceId: role ===');
  });

  it('keeps scene and generation reference sets in sync and prunes stale frames', () => {
    const source = workspaceSource();

    expect(source).toContain('function setSceneReferences');
    expect(source).toContain('referenceIds: nextReferenceIds');
    expect(source).toContain('startFrameReferenceId: startFrameReferenceId && nextReferenceIds.includes(startFrameReferenceId) ? startFrameReferenceId : undefined');
    expect(source).toContain('setSceneReferences(');
  });

  it('derives frame edits from the canonical scene reference list, never the stale snapshot', () => {
    const source = workspaceSource();

    expect(source).toContain('const base = scene.referenceIds;');
    // Regression guard: frames must not be built from `generation.referenceIds`,
    // which can silently narrow the reference set (and drop valid frames).
    expect(source).not.toContain('generation.referenceIds && generation.referenceIds.length > 0 ? generation.referenceIds : scene.referenceIds');
  });

  it('sends the selected provider and model when submitting a manual video generation', () => {
    const source = workspaceSource();

    expect(source).toContain('body: JSON.stringify({ regenerate, provider, model })');
  });

  it('forwards only real providers so the mock `local` default never forces mock in real mode', () => {
    const source = workspaceSource();

    // The real-provider-only decision lives in one shared, unit-tested helper and
    // is used by both the manual submit and the client batch runner.
    expect(source).toContain("import { resolveVideoProviderForwarding } from '@/lib/generation/video-provider-forwarding'");
    expect(source).toContain('resolveVideoProviderForwarding(videoGeneration)');
    expect(source).not.toContain('isRealProviderSelection');
  });

  it('forwards the effective provider and model from the client batch runner video submit', () => {
    const source = productionActionClientSource();

    // The batch runner must not ignore the explicit scene configuration. This
    // HTTP/mapping logic now lives in the shared production action client.
    expect(source).toContain("if (action.type === 'video_submit' && action.sceneId)");
    expect(source).toContain('const { provider, model } = resolveVideoProviderForwarding(videoGeneration);');
    expect(source).toContain('body: JSON.stringify({ regenerate, provider, model })');
  });

  it('wires an explicit cancel control to the cancel-video route', () => {
    const source = workspaceSource();

    expect(source).toContain('async function cancelVideoGeneration');
    expect(source).toContain('/cancel-video');
    expect(source).toContain('Cancel Video');
  });

  it('pauses video polling while the document is hidden and resumes on visibility', () => {
    const source = workspaceSource();

    // A single guarded interval runs only while visible; it is torn down and
    // recreated on visibility transitions instead of polling a background tab.
    expect(source).toContain("import { isHidden, subscribeToVisibility } from '@/lib/client/visibility-poll'");
    expect(source).toContain('const startPolling = () => {');
    expect(source).toContain('const stopPolling = () => {');
    expect(source).toContain('subscribeToVisibility((hidden) => {');
    expect(source).toContain('isHidden(');
    expect(source).not.toContain('const timer = window.setInterval(poll, 5000);');
  });
});
