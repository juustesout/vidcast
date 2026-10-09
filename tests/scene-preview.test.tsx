import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ScenePreview } from '@/components/preview/scene-preview';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import type { Project } from '@/lib/types/render';

vi.mock('next/image', () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => React.createElement('img', props)
}));

function createImageProject(): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-preview-image',
    title: 'Preview Test',
    description: 'desc',
    durationTarget: 5,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: now,
    updatedAt: now,
    narration: { text: '', segments: [] },
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1280,
      height: 720,
      background: { type: 'color', value: '#020617' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    assets: [
      {
        id: 'asset-1',
        type: 'image',
        status: 'available',
        provenance: 'imported',
        filename: 'image.png',
        localPath: 'assets/image.png',
        mimeType: 'image/png',
        filesize: 120,
        metadata: {},
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'audio-1',
        type: 'audio',
        status: 'available',
        provenance: 'generated',
        filename: 'voice.mp3',
        localPath: 'assets/voice.mp3',
        mimeType: 'audio/mpeg',
        duration: 1,
        filesize: 50,
        metadata: {},
        createdAt: now,
        updatedAt: now
      }
    ],
    references: [],
    scenes: [
      {
        id: 'scene-1',
        order: 1,
        duration: 2,
        type: 'image',
        narration: { text: 'hello world', audioAssetId: 'audio-1' },
        visual: { kind: 'asset', assetId: 'asset-1' },
        render: { motion: { preset: 'zoom_in' }, transition: { type: 'fade' } },
        overlay: { type: 'callout', text: 'Overlay text', position: 'bottom' },
        referenceIds: [],
        notes: '',
        renders: []
      }
    ],
    compositions: []
  };
}

function createVideoProject(): Project {
  const project = createImageProject();
  project.id = 'project-preview-video';
  project.assets[0] = {
    ...project.assets[0],
    id: 'asset-video',
    type: 'video',
    filename: 'clip.mp4',
    localPath: 'assets/clip.mp4',
    mimeType: 'video/mp4',
    duration: 2
  };
  project.scenes[0].type = 'video';
  project.scenes[0].visual = { kind: 'asset', assetId: 'asset-video' };
  return project;
}

describe('ScenePreview', () => {
  it('renders browser preview labels, narration audio, and non-renderable reason', () => {
    const project = createImageProject();
    project.scenes[0].visual = { kind: 'asset' };
    const renderPlan = resolveRenderPlan(project);
    const html = renderToStaticMarkup(React.createElement(ScenePreview, { project, scene: project.scenes[0], renderPlan }));

    expect(html).toContain('Browser preview only');
    expect(html).toContain('Narration audio');
    expect(html).toContain('No rendered MP4 available yet');
    expect(html).toContain('Existing asset visual is missing an asset id.');
  });

  it('renders video preview and rendered mp4 section when a current render exists', () => {
    const project = createVideoProject();
    const renderPlan = resolveRenderPlan(project);
    const scenePlan = renderPlan.scenes[0];
    project.scenes[0].renders = [{
      renderId: 'render-1',
      outputPath: 'renders/scene-1.mp4',
      createdAt: new Date().toISOString(),
      width: renderPlan.width,
      height: renderPlan.height,
      fps: renderPlan.fps,
      duration: 2,
      filesize: 100,
      mimeType: 'video/mp4',
      renderer: 'ffmpeg',
      status: 'completed',
      renderFingerprint: createSceneRenderFingerprint(renderPlan, scenePlan)
    }];

    const html = renderToStaticMarkup(React.createElement(ScenePreview, { project, scene: project.scenes[0], renderPlan }));
    expect(html).toContain('Rendered');
    expect(html).toContain('/api/projects/project-preview-video/renders/render-1/file');
    expect(html).toContain('/api/projects/project-preview-video/files/assets/clip.mp4');
  });
});
