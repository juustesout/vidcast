import { describe, expect, it } from 'vitest';

import { deriveProductionPlan } from '@/lib/production/production-planner';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { Project } from '@/lib/types/render';

function createProject(): Project {
  const now = new Date().toISOString();
  return normalizeProject({
    id: 'project-production-plan',
    title: 'Production Plan',
    description: 'desc',
    durationTarget: 45,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 5,
        type: 'image',
        narration: { text: 'Scene one narration', status: 'planned', voiceId: 'v1', model: 'm1', format: 'mp3' },
        visual: {
          kind: 'generated_image',
          generation: {
            id: 'gen-1',
            kind: 'image',
            status: 'planned',
            provider: 'openai',
            prompt: 'Prompt 1',
            referenceIds: [],
            aspectRatio: '16:9',
            createdAt: now
          }
        },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      },
      {
        id: 'scene-2',
        order: 2,
        duration: 5,
        type: 'video',
        narration: { text: 'Scene two narration', status: 'planned', voiceId: 'v1', model: 'm1', format: 'mp3' },
        visual: {
          kind: 'generated_video',
          generation: {
            id: 'gen-2',
            kind: 'video',
            status: 'generating',
            provider: 'openai',
            prompt: 'Prompt 2',
            referenceIds: [],
            aspectRatio: '16:9',
            providerJobId: 'job-2',
            createdAt: now
          }
        },
        render: { motion: { preset: 'none' }, transition: { type: 'none' } },
        overlay: { type: 'none' },
        referenceIds: [],
        notes: ''
      }
    ],
    assets: [],
    references: [],
    compositions: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1920,
      height: 1080,
      background: { type: 'color', value: '#000000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    }
  });
}

describe('deriveProductionPlan', () => {
  function currentImageProject(): Project {
    const project = createProject();
    const now = project.updatedAt;
    project.assets = [{ id: 'asset-1', type: 'image', status: 'available' }] as unknown as Project['assets'];
    project.scenes[0].visual = {
      kind: 'generated_image',
      assetId: 'asset-1',
      generation: {
        id: 'gen-1',
        kind: 'image',
        status: 'generated',
        provider: 'local',
        prompt: 'Prompt 1',
        referenceIds: [],
        aspectRatio: '16:9',
        assetId: 'asset-1',
        createdAt: now
      }
    };
    return project;
  }

  it('honours force by regenerating current outputs exactly once', () => {
    const project = currentImageProject();
    const imageId = 'scene:scene-1:image_generate';

    expect(deriveProductionPlan(project).actions.find((action) => action.id === imageId)?.status).toBe('current');

    const forced = deriveProductionPlan(project, { force: true });
    const forcedImage = forced.actions.find((action) => action.id === imageId);
    expect(forcedImage?.status).toBe('ready');
    expect(forcedImage?.execute).toBe(true);
    expect(forcedImage?.payload).toMatchObject({ regenerate: true });

    const afterComplete = deriveProductionPlan(project, { force: true, completedActionIds: [imageId] });
    expect(afterComplete.actions.find((action) => action.id === imageId)?.status).toBe('current');
  });


  it('marks current outputs as current and skips resubmission of running video', () => {
    const project = createProject();
    const plan = deriveProductionPlan(project);

    const runningSubmit = plan.actions.find((entry) => entry.id === 'scene:scene-2:video_submit');
    const pollAction = plan.actions.find((entry) => entry.id === 'scene:scene-2:video_poll');

    expect(runningSubmit?.status).toBe('running');
    expect(runningSubmit?.execute).toBe(false);
    expect(pollAction?.status).toBe('ready');
    expect(pollAction?.execute).toBe(true);
  });

  it('blocks scene render when required generated visual output is not yet available', () => {
    const project = createProject();
    const plan = deriveProductionPlan(project);

    const renderAction = plan.actions.find((entry) => entry.id === 'scene:scene-1:scene_render');
    expect(renderAction?.status).toBe('blocked');
  });

  it('schedules stale scene render and blocks composition until dependencies are current', () => {
    const project = createProject();

    project.scenes[0].visual = { kind: 'blank' };
    const plan = resolveRenderPlan(project);
    const scenePlan = plan.scenes.find((entry) => entry.sceneId === 'scene-1')!;
    project.scenes[0].renders = [{
      renderId: 'render-1',
      outputPath: 'renders/scene-1.mp4',
      createdAt: new Date().toISOString(),
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      duration: project.scenes[0].duration,
      filesize: 100,
      mimeType: 'video/mp4',
      renderer: 'ffmpeg',
      status: 'completed',
      renderFingerprint: createSceneRenderFingerprint(plan, scenePlan)
    }];

    project.scenes[0].overlay = { type: 'callout', text: 'Changed', position: 'bottom' };

    const derived = deriveProductionPlan(project);
    const renderAction = derived.actions.find((entry) => entry.id === 'scene:scene-1:scene_render');
    const composeAction = derived.actions.find((entry) => entry.id === 'project:final_compose');

    expect(renderAction?.status).toBe('ready');
    expect(composeAction?.status).toBe('blocked');
  });

  it('marks current narration as current and stale narration as ready to regenerate', () => {
    const project = createProject();

    project.assets.push({
      id: 'audio-1',
      type: 'audio',
      status: 'available',
      provenance: 'generated',
      filename: 'audio-1.mp3',
      localPath: 'assets/audio-1.mp3',
      mimeType: 'audio/mpeg',
      duration: 1,
      filesize: 100,
      metadata: { voiceId: 'v1' },
      generation: {
        generationId: 'attempt-1',
        provider: 'elevenlabs',
        model: 'm1',
        prompt: 'Scene one narration',
        referenceIds: []
      },
      createdAt: new Date().toISOString()
    });

    project.scenes[0].narration = {
      text: 'Scene one narration',
      status: 'generated',
      voiceId: 'v1',
      model: 'm1',
      format: 'mp3',
      audioAssetId: 'audio-1',
      attempts: [{
        id: 'attempt-1',
        status: 'generated',
        provider: 'elevenlabs',
        voiceId: 'v1',
        model: 'm1',
        format: 'mp3',
        createdAt: new Date().toISOString()
      }]
    };

    project.scenes[1].narration = {
      text: 'Scene two narration updated',
      status: 'generated',
      voiceId: 'v1',
      model: 'm1',
      format: 'mp3',
      audioAssetId: 'audio-1',
      attempts: [{
        id: 'attempt-2',
        status: 'generated',
        provider: 'elevenlabs',
        voiceId: 'v1',
        model: 'm1',
        format: 'mp3',
        createdAt: new Date().toISOString()
      }]
    };

    const derived = deriveProductionPlan(project);
    expect(derived.actions.find((entry) => entry.id === 'scene:scene-1:narration_generate')?.status).toBe('current');
    expect(derived.actions.find((entry) => entry.id === 'scene:scene-2:narration_generate')?.status).toBe('ready');
    expect(derived.actions.find((entry) => entry.id === 'scene:scene-2:narration_generate')?.payload?.mode).toBe('regenerate');
  });

  it('blocks a stock scene until a search query is present', () => {
    const project = createProject();
    project.scenes[0].visual = { kind: 'stock_image', query: '  ' };

    const action = deriveProductionPlan(project).actions.find((entry) => entry.id === 'scene:scene-1:stock_select');
    expect(action?.type).toBe('stock_select');
    expect(action?.status).toBe('blocked');
    expect(action?.execute).toBe(false);
  });

  it('schedules a ready stock selection for a query without a prior selection', () => {
    const project = createProject();
    project.scenes[0].visual = { kind: 'stock_image', query: 'forest', orientation: 'landscape' };

    const action = deriveProductionPlan(project).actions.find((entry) => entry.id === 'scene:scene-1:stock_select');
    expect(action?.status).toBe('ready');
    expect(action?.execute).toBe(true);
    expect(action?.payload).toMatchObject({ regenerate: false });
  });

  it('treats a downloaded stock selection with an available asset as current', () => {
    const project = createProject();
    project.assets.push({ id: 'stock-1', type: 'image', status: 'available' } as unknown as Project['assets'][number]);
    project.scenes[0].visual = {
      kind: 'stock_image',
      query: 'forest',
      assetId: 'stock-1',
      selection: {
        provider: 'pexels',
        photoId: '1',
        query: 'forest',
        usagePolicy: 'download',
        attribution: {
          provider: 'pexels',
          providerName: 'Pexels',
          photoId: '1',
          photographerName: 'Alex',
          sourceUrl: 'https://www.pexels.com/photo/1',
          license: 'Pexels License'
        },
        sourceUrl: 'https://www.pexels.com/photo/1',
        imageUrl: 'https://images.pexels.com/photos/1/large.jpg',
        width: 1000,
        height: 1000,
        selectedAt: new Date().toISOString(),
        selectionKey: 'landscape::forest'
      }
    };

    const action = deriveProductionPlan(project).actions.find((entry) => entry.id === 'scene:scene-1:stock_select');
    expect(action?.status).toBe('current');
    expect(action?.execute).toBe(false);
  });

  it('treats a hotlink selection as current even without a stored asset', () => {
    const project = createProject();
    project.scenes[0].visual = {
      kind: 'stock_image',
      query: 'city',
      selection: {
        provider: 'unsplash',
        photoId: 'abc',
        query: 'city',
        usagePolicy: 'hotlink',
        attribution: {
          provider: 'unsplash',
          providerName: 'Unsplash',
          photoId: 'abc',
          photographerName: 'Jane',
          sourceUrl: 'https://unsplash.com/photos/abc',
          license: 'Unsplash License'
        },
        sourceUrl: 'https://unsplash.com/photos/abc',
        imageUrl: 'https://images.unsplash.com/abc',
        width: 1000,
        height: 1000,
        selectedAt: new Date().toISOString(),
        selectionKey: 'any::city'
      }
    };

    const action = deriveProductionPlan(project).actions.find((entry) => entry.id === 'scene:scene-1:stock_select');
    expect(action?.status).toBe('current');
  });

  it('re-runs a current stock selection under force until it is completed', () => {
    const project = createProject();
    project.assets.push({ id: 'stock-1', type: 'image', status: 'available' } as unknown as Project['assets'][number]);
    const id = 'scene:scene-1:stock_select';
    project.scenes[0].visual = {
      kind: 'stock_image',
      query: 'forest',
      assetId: 'stock-1',
      selection: {
        provider: 'pexels',
        photoId: '1',
        query: 'forest',
        usagePolicy: 'download',
        attribution: {
          provider: 'pexels',
          providerName: 'Pexels',
          photoId: '1',
          photographerName: 'Alex',
          sourceUrl: 'https://www.pexels.com/photo/1',
          license: 'Pexels License'
        },
        sourceUrl: 'https://www.pexels.com/photo/1',
        imageUrl: 'https://images.pexels.com/photos/1/large.jpg',
        width: 1000,
        height: 1000,
        selectedAt: new Date().toISOString(),
        selectionKey: 'landscape::forest'
      }
    };

    const forced = deriveProductionPlan(project, { force: true }).actions.find((entry) => entry.id === id);
    expect(forced?.status).toBe('ready');
    expect(forced?.payload).toMatchObject({ regenerate: true });

    const completed = deriveProductionPlan(project, { force: true, completedActionIds: [id] }).actions.find((entry) => entry.id === id);
    expect(completed?.status).toBe('current');
  });

  it('pins a manual stock selection so a forced run never replaces it', () => {
    const project = createProject();
    project.assets.push({ id: 'stock-1', type: 'image', status: 'available' } as unknown as Project['assets'][number]);
    const id = 'scene:scene-1:stock_select';
    project.scenes[0].visual = {
      kind: 'stock_image',
      query: 'forest',
      assetId: 'stock-1',
      selection: {
        provider: 'pexels',
        photoId: '1',
        query: 'forest',
        usagePolicy: 'download',
        origin: 'manual',
        attribution: {
          provider: 'pexels',
          providerName: 'Pexels',
          photoId: '1',
          photographerName: 'Alex',
          sourceUrl: 'https://www.pexels.com/photo/1',
          license: 'Pexels License'
        },
        sourceUrl: 'https://www.pexels.com/photo/1',
        imageUrl: 'https://images.pexels.com/photos/1/large.jpg',
        width: 1000,
        height: 1000,
        selectedAt: new Date().toISOString(),
        selectionKey: 'landscape::forest'
      }
    };

    const action = deriveProductionPlan(project, { force: true }).actions.find((entry) => entry.id === id);
    expect(action?.status).toBe('current');
    expect(action?.execute).toBe(false);
    expect(action?.reason).toMatch(/pinned/i);
  });
});
