import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BackgroundMusicPanel } from '@/components/project/background-music-panel';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';

function createAsset(id: string, type: Asset['type']): Asset {
  const now = new Date().toISOString();
  return {
    id,
    type,
    status: 'available',
    provenance: 'generated',
    filename: `${id}.mp3`,
    localPath: `assets/${id}.mp3`,
    mimeType: 'audio/mpeg',
    duration: 30,
    filesize: 100,
    metadata: {},
    createdAt: now,
    updatedAt: now
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-1',
    title: 'Background Music Panel Test',
    description: 'desc',
    durationTarget: 30,
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
      background: { type: 'color', value: '#000' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    assets: [],
    references: [],
    scenes: [],
    ...overrides
  };
}

const noopRefresh = async (): Promise<Project | null> => null;

describe('BackgroundMusicPanel', () => {
  it('renders the generate form when no music is selected', () => {
    const html = renderToStaticMarkup(React.createElement(BackgroundMusicPanel, { project: createProject(), onRefresh: noopRefresh }));

    expect(html).toContain('Background music');
    expect(html).toContain('Generate music');
    expect(html).toContain('No background music selected.');
    expect(html).not.toContain('Disable background music');
  });

  it('renders the current selection with regenerate and disable controls', () => {
    const asset = createAsset('asset-music', 'music');
    const project = createProject({
      assets: [asset],
      music: {
        assetId: asset.id,
        status: 'generated',
        prompt: 'calm ambient',
        provider: 'elevenlabs',
        model: 'music_v2_5',
        instrumental: true,
        musicLengthMs: 30000
      }
    });

    const html = renderToStaticMarkup(React.createElement(BackgroundMusicPanel, { project, onRefresh: noopRefresh }));

    expect(html).toContain('asset-music.mp3');
    expect(html).toContain('Regenerate music');
    expect(html).toContain('Disable background music');
    expect(html).toContain('/api/projects/project-1/assets/asset-music/file');
    expect(html).toContain('previous audio file is kept');
  });

  it('surfaces a failed generation without exposing controls to auto-retry', () => {
    const project = createProject({
      music: { status: 'failed', error: 'Music generation failed. No automatic retry was started.' }
    });

    const html = renderToStaticMarkup(React.createElement(BackgroundMusicPanel, { project, onRefresh: noopRefresh }));

    expect(html).toContain('No background music selected.');
    expect(html).toContain('No automatic retry was started');
    expect(html).toContain('Generate music');
  });

  it('offers existing music-capable assets for selection', () => {
    const audio = createAsset('asset-audio', 'audio');
    const project = createProject({ assets: [audio] });

    const html = renderToStaticMarkup(React.createElement(BackgroundMusicPanel, { project, onRefresh: noopRefresh }));

    expect(html).toContain('Use an existing asset');
    expect(html).toContain('asset-audio.mp3');
  });
});
