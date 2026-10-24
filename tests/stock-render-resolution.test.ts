import { describe, expect, it } from 'vitest';

import { normalizeProject } from '@/lib/projects/normalize-project';
import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { Project } from '@/lib/types/render';

function baseProject(): Project {
  const now = new Date().toISOString();
  return normalizeProject({
    id: 'project-stock-render',
    title: 'Stock render',
    description: '',
    durationTarget: 5,
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
        narration: { text: '' },
        visual: { kind: 'stock_image', query: 'city' },
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

describe('stock image render resolution', () => {
  it('marks an unselected stock scene as planned', () => {
    const plan = resolveRenderPlan(baseProject());
    const scene = plan.scenes.find((entry) => entry.sceneId === 'scene-1')!;
    expect(scene.source.kind).toBe('image');
    expect(scene.source.assetPath).toBeUndefined();
    expect(scene.source.remoteUrl).toBeUndefined();
  });

  it('references a hotlink selection by remote URL', () => {
    const project = baseProject();
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
        imageUrl: 'https://images.unsplash.com/abc?w=1200',
        width: 1200,
        height: 800,
        selectedAt: new Date().toISOString(),
        selectionKey: 'any::city'
      }
    };

    const scene = resolveRenderPlan(project).scenes.find((entry) => entry.sceneId === 'scene-1')!;
    expect(scene.source.remoteUrl).toBe('https://images.unsplash.com/abc?w=1200');
    expect(scene.source.assetPath).toBeUndefined();
    expect(scene.source.width).toBe(1200);
  });

  it.each([
    'http://127.0.0.1/secret',
    'https://localhost/secret',
    'https://10.0.0.8/photo.jpg',
    'file:///etc/passwd',
    'https://evil.example/photo.jpg'
  ])('does not expose untrusted hotlink URL %s as a fetch target', (imageUrl) => {
    const project = baseProject();
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
        imageUrl,
        width: 1200,
        height: 800,
        selectedAt: new Date().toISOString(),
        selectionKey: 'any::city'
      }
    };

    const scene = resolveRenderPlan(project).scenes.find((entry) => entry.sceneId === 'scene-1')!;
    expect(scene.status).toBe('invalid');
    expect(scene.source.remoteUrl).toBeUndefined();
    expect(scene.issues.some((issue) => issue.code === 'scene.visual.stock.remoteUrl.untrusted')).toBe(true);
  });

  it('renders a downloaded selection from the persisted local asset', () => {
    const project = baseProject();
    project.assets.push({
      id: 'stock-1',
      type: 'image',
      status: 'available',
      provenance: 'stock',
      filename: 'stock-1.jpg',
      localPath: '/projects/project-stock-render/assets/stock-1.jpg',
      mimeType: 'image/jpeg',
      width: 1000,
      height: 1000,
      metadata: {},
      createdAt: new Date().toISOString()
    } as Project['assets'][number]);
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
        selectionKey: 'any::forest'
      }
    };

    const scene = resolveRenderPlan(project).scenes.find((entry) => entry.sceneId === 'scene-1')!;
    expect(scene.source.assetId).toBe('stock-1');
    expect(scene.source.assetPath).toBe('/projects/project-stock-render/assets/stock-1.jpg');
    expect(scene.source.remoteUrl).toBeUndefined();
  });

  it('changes the scene render fingerprint when a hotlink URL changes at the same dimensions', () => {
    const project = baseProject();
    const selection = {
      provider: 'unsplash' as const,
      photoId: 'abc',
      query: 'city',
      usagePolicy: 'hotlink' as const,
      attribution: {
        provider: 'unsplash' as const,
        providerName: 'Unsplash',
        photoId: 'abc',
        photographerName: 'Jane',
        sourceUrl: 'https://unsplash.com/photos/abc',
        license: 'Unsplash License'
      },
      sourceUrl: 'https://unsplash.com/photos/abc',
      imageUrl: 'https://images.unsplash.com/abc?w=1200',
      width: 1200,
      height: 800,
      selectedAt: new Date().toISOString(),
      selectionKey: 'any::city'
    };
    project.scenes[0].visual = { kind: 'stock_image', query: 'city', selection };

    const firstPlan = resolveRenderPlan(project);
    const first = createSceneRenderFingerprint(firstPlan, firstPlan.scenes[0]);

    project.scenes[0].visual = {
      kind: 'stock_image',
      query: 'city',
      selection: { ...selection, imageUrl: 'https://images.unsplash.com/xyz?w=1200' }
    };
    const secondPlan = resolveRenderPlan(project);
    const second = createSceneRenderFingerprint(secondPlan, secondPlan.scenes[0]);

    expect(firstPlan.scenes[0].source.width).toBe(secondPlan.scenes[0].source.width);
    expect(firstPlan.scenes[0].source.height).toBe(secondPlan.scenes[0].source.height);
    expect(first).not.toBe(second);

    const unchangedPlan = resolveRenderPlan({
      ...project,
      scenes: [{ ...project.scenes[0], visual: { kind: 'stock_image', query: 'city', selection } }]
    });
    expect(createSceneRenderFingerprint(unchangedPlan, unchangedPlan.scenes[0])).toBe(first);
  });
});
