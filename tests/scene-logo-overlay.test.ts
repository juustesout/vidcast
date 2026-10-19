import { describe, expect, it } from 'vitest';

import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import { AI_DEV_FORUM_GRAPHIC_STYLE } from '@/lib/render/graphic-style';
import { buildLogoOverlayFilter, resolveLogoGeometry } from '@/lib/render/logo-overlay';
import { createStillSceneSvg } from '@/lib/render/render-source';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { validateProject } from '@/lib/validation/project-validation';
import type { Asset } from '@/lib/types/asset';
import type { Project, RenderPlanScene } from '@/lib/types/render';
import type { Scene, VisualSpec } from '@/lib/types/scene';

const NOW = '2026-10-19T00:00:00.000Z';

function makeAsset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    type: 'image',
    status: 'available',
    provenance: 'imported',
    filename: `${id}.png`,
    localPath: `assets/${id}.png`,
    mimeType: 'image/png',
    width: 400,
    height: 200,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function makeScene(id: string, visual: VisualSpec, overrides: Partial<Scene> = {}): Scene {
  return {
    id,
    order: 1,
    duration: 2,
    type: visual.kind === 'blank' ? 'blank' : visual.kind === 'graphic' ? 'graphic' : 'image',
    visual,
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: '',
    ...overrides
  };
}

function makeProject(scenes: Scene[], overrides: Partial<Project> = {}): Project {
  return normalizeProject({
    id: 'project-logo-test',
    title: 'Logo Overlay Test',
    description: 'desc',
    durationTarget: 4,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: NOW,
    updatedAt: NOW,
    narration: { text: '', segments: [] },
    scenes,
    assets: [makeAsset('logo-a'), makeAsset('logo-b'), makeAsset('base')],
    references: [],
    renderSettings: {
      aspectRatio: '16:9',
      fps: 30,
      width: 1280,
      height: 720,
      background: { type: 'color', value: '#070b10' },
      audio: { narrationVolume: 1, musicVolume: 0.35, effectsVolume: 0.2 },
      subtitlesEnabled: true
    },
    ...overrides
  } as Project);
}

function planScene(overrides: Partial<RenderPlanScene> = {}): RenderPlanScene {
  return {
    sceneId: 'scene-1',
    order: 1,
    duration: 2,
    status: 'renderable',
    source: { kind: 'graphic', template: 'statistic' },
    motion: { preset: 'none' },
    transition: { type: 'none' },
    referenceIds: [],
    issues: [],
    ...overrides
  };
}

describe('logo overlay geometry', () => {
  it('uses safe defaults and clamps authored values', () => {
    expect(resolveLogoGeometry({}, 1920, 1080)).toEqual({
      position: 'bottom_right',
      width: 288,
      margin: 49,
      opacity: 1
    });

    expect(resolveLogoGeometry({ scale: 9, margin: -10, opacity: 3 }, 1000, 500)).toEqual({
      position: 'bottom_right',
      width: 500,
      margin: 0,
      opacity: 1
    });
  });

  it('honours maxWidth and all four positions', () => {
    expect(resolveLogoGeometry({ scale: 0.4, maxWidth: 120 }, 1000, 500).width).toBe(120);
    expect(resolveLogoGeometry({ position: 'top_left' }, 1000, 500).position).toBe('top_left');
    expect(resolveLogoGeometry({ position: 'top_right' }, 1000, 500).position).toBe('top_right');
    expect(resolveLogoGeometry({ position: 'bottom_left' }, 1000, 500).position).toBe('bottom_left');
  });

  it('builds scale, alpha and corner overlay filters without affecting audio', () => {
    const filter = buildLogoOverlayFilter(
      { position: 'top_right', width: 240, margin: 36, opacity: 0.5 },
      '1:v',
      'base',
      'logoout'
    );

    expect(filter).toContain('scale=w=240:h=-2');
    expect(filter).toContain('colorchannelmixer=aa=0.500');
    expect(filter).toContain('overlay=x=W-w-36:y=36');
    expect(filter).toContain('shortest=1');
    expect(filter).not.toContain('0:a');
  });
});

describe('scene logo resolution', () => {
  it('leaves scenes without logo configuration unchanged', () => {
    const project = makeProject([makeScene('scene-1', { kind: 'blank' })]);
    const plan = resolveRenderPlan(project);

    expect(plan.scenes[0].logo).toBeUndefined();
    expect(plan.issues).toEqual([]);
  });

  it('uses a project default and lets a scene override or disable it', () => {
    const project = makeProject(
      [
        makeScene('scene-default', { kind: 'blank' }),
        makeScene('scene-override', { kind: 'blank' }, { logo: { assetId: 'logo-b', position: 'top_left' } }),
        makeScene('scene-disabled', { kind: 'blank' }, { logo: null })
      ],
      { renderSettings: { ...makeProject([]).renderSettings, logo: { assetId: 'logo-a', scale: 0.2 } } }
    );

    const plan = resolveRenderPlan(project);
    const byId = new Map(plan.scenes.map((scene) => [scene.sceneId, scene]));

    expect(byId.get('scene-default')?.logo).toMatchObject({ assetId: 'logo-a', assetPath: 'assets/logo-a.png', scale: 0.2 });
    expect(byId.get('scene-override')?.logo).toMatchObject({ assetId: 'logo-b', position: 'top_left' });
    expect(byId.get('scene-disabled')?.logo).toBeUndefined();
  });

  it('reuses one logo asset across multiple scenes', () => {
    const project = makeProject([
      makeScene('scene-1', { kind: 'blank' }, { logo: { assetId: 'logo-a' } }),
      makeScene('scene-2', { kind: 'graphic', template: 'title_card' }, { logo: { assetId: 'logo-a', position: 'top_right' } })
    ]);
    const plan = resolveRenderPlan(project);

    expect(plan.scenes[0].logo).toMatchObject({ assetId: 'logo-a', assetPath: 'assets/logo-a.png' });
    expect(plan.scenes[1].logo).toMatchObject({ assetId: 'logo-a', assetPath: 'assets/logo-a.png', position: 'top_right' });
  });

  it('degrades to no logo with a warning when the referenced asset is missing', () => {
    const project = makeProject([
      makeScene('scene-1', { kind: 'blank' }, { logo: { assetId: 'missing-logo' } })
    ]);
    const plan = resolveRenderPlan(project);

    expect(plan.scenes[0].logo).toBeUndefined();
    expect(plan.issues.some((issue) => issue.code === 'scene.logo.asset.notFound' && issue.severity === 'warning')).toBe(true);
    expect(validateProject(project).warnings.some((issue) => issue.code === 'scene.logo.asset.notFound')).toBe(true);
  });

  it('rejects non-image assets without blocking the scene', () => {
    const project = makeProject(
      [makeScene('scene-1', { kind: 'blank' }, { logo: { assetId: 'voice-a' } })],
      { assets: [makeAsset('voice-a', { type: 'voice', mimeType: 'audio/mpeg' })] }
    );

    expect(resolveRenderPlan(project).scenes[0].logo).toBeUndefined();
    expect(validateProject(project).warnings.some((issue) => issue.code === 'scene.logo.asset.invalidType')).toBe(true);
  });
});

describe('logo validation and fingerprints', () => {
  it('validates position, scale, maxWidth, margin and opacity', () => {
    const project = makeProject([
      makeScene('scene-1', { kind: 'blank' }, {
        logo: {
          assetId: 'logo-a',
          position: 'middle' as never,
          scale: 4,
          maxWidth: 1,
          margin: 1000,
          opacity: -1
        }
      })
    ]);
    const result = validateProject(project);

    expect(result.valid).toBe(false);
    for (const code of [
      'scene.logo.position.invalid',
      'scene.logo.scale.invalid',
      'scene.logo.maxWidth.invalid',
      'scene.logo.margin.invalid',
      'scene.logo.opacity.invalid'
    ]) {
      expect(result.errors.some((issue) => issue.code === code)).toBe(true);
    }
  });

  it('changes the render fingerprint when only the logo changes', () => {
    const withoutLogo = makeProject([makeScene('scene-1', { kind: 'blank' })]);
    const withLogo = makeProject([
      makeScene('scene-1', { kind: 'blank' }, { logo: { assetId: 'logo-a' } })
    ]);

    const planA = resolveRenderPlan(withoutLogo);
    const planB = resolveRenderPlan(withLogo);

    expect(createSceneRenderFingerprint(planA, planA.scenes[0])).not.toBe(
      createSceneRenderFingerprint(planB, planB.scenes[0])
    );
  });
});

describe('graphic style', () => {
  it('keeps the historical colors when no style is configured', () => {
    const svg = createStillSceneSvg(planScene(), 1280, 720, '#070b10');

    expect(svg).toContain('stop-color="#070b10"');
    expect(svg).toContain('fill="#f8fafc"');
    expect(svg).toContain('fill="#93c5fd"');
  });

  it('applies scene overrides with project fallbacks', () => {
    const project = makeProject(
      [
        makeScene('scene-1', {
          kind: 'graphic',
          template: 'statistic',
          templateData: { value: '82%', label: 'adoption' },
          style: { textColor: '#ffffff' }
        })
      ],
      {
        renderSettings: {
          ...makeProject([]).renderSettings,
          graphicStyle: { background: '#0056a7', accentColor: '#ff5a5f', statisticLabelColor: '#ffd9da' }
        }
      }
    );

    const plan = resolveRenderPlan(project);
    const svg = createStillSceneSvg(plan.scenes[0], plan.width, plan.height, plan.background?.value);

    expect(svg).toContain('stop-color="#0056a7"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('fill="#ffd9da"');
  });

  it('exposes a readable AI Dev Forum preset using the existing brand colors', () => {
    const svg = createStillSceneSvg(
      planScene({
        source: {
          kind: 'graphic',
          template: 'statistic',
          templateData: { value: '82%', label: 'adoption' },
          style: AI_DEV_FORUM_GRAPHIC_STYLE
        }
      }),
      1280,
      720,
      '#070b10'
    );

    expect(AI_DEV_FORUM_GRAPHIC_STYLE).toEqual({
      background: '#0056a7',
      textColor: '#ffffff',
      accentColor: '#ff5a5f',
      statisticLabelColor: '#ffd9da'
    });
    expect(svg).toContain('stop-color="#0056a7"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('fill="#ffd9da"');
  });

  it('rejects malformed style colors', () => {
    const project = makeProject([
      makeScene('scene-1', {
        kind: 'graphic',
        template: 'title_card',
        style: { background: 'blue', textColor: '#12' }
      })
    ]);
    const result = validateProject(project);

    expect(result.valid).toBe(false);
    expect(result.errors.some((issue) => issue.code === 'scene.visual.style.background.invalid')).toBe(true);
    expect(result.errors.some((issue) => issue.code === 'scene.visual.style.textColor.invalid')).toBe(true);
  });
});
