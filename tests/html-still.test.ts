import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import { POST as renderHtmlStillRoute } from '@/app/api/projects/[id]/scenes/[sceneId]/render-html-still/route';
import { createHtmlStillFingerprint, htmlStillAssetIsCurrent } from '@/lib/render/html-still/fingerprint';
import { renderHtmlStillPng } from '@/lib/render/html-still/chromium-still';
import { HtmlStillError } from '@/lib/render/html-still/errors';
import { assertSafeCss, assertSafeHtmlFragment, wrapHtmlStillDocument } from '@/lib/render/html-still/sanitize';
import * as htmlStillService from '@/lib/render/html-still/service';
import { resolveHtmlStillTemplate } from '@/lib/render/html-still/templates';
import { createStudioComposition, STUDIO_BIGSCREEN_RECT, STUDIO_LAYER_IDS } from '@/lib/render/scene-composition';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { clearThrottleStateForTests } from '@/lib/security/access-control';
import { createUserSessionCookie, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { mediaStore } from '@/lib/storage/media-store';
import { projectStore } from '@/lib/storage/project-store';
import type { Asset } from '@/lib/types/asset';
import type { Project } from '@/lib/types/render';
import type { HtmlVisual, Scene } from '@/lib/types/scene';
import { validateProject } from '@/lib/validation/project-validation';

const NOW = '2026-10-21T00:00:00.000Z';

function makeAsset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    type: 'image',
    status: 'available',
    provenance: 'generated',
    filename: `${id}.png`,
    localPath: `assets/${id}.png`,
    mimeType: 'image/png',
    width: 1920,
    height: 1080,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function makeHtmlScene(visual: HtmlVisual, overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-html',
    order: 1,
    duration: 4,
    type: 'html',
    visual,
    render: { motion: { preset: 'none' }, transition: { type: 'none' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: '',
    ...overrides
  };
}

function makeProject(scene: Scene, assets: Asset[] = []): Project {
  return {
    id: 'project-html-still',
    title: 'HTML still',
    description: '',
    durationTarget: 4,
    aspectRatio: '16:9',
    fps: 30,
    createdAt: NOW,
    updatedAt: NOW,
    narration: { text: '', segments: [] },
    scenes: [scene],
    assets,
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
  };
}

describe('HTML still sanitize', () => {
  it('rejects remote URLs, scripts, and CSS url()', () => {
    expect(() => assertSafeHtmlFragment('<div onclick="alert(1)">x</div>', 'HTML')).toThrow(HtmlStillError);
    expect(() => assertSafeHtmlFragment('<script>alert(1)</script>', 'HTML')).toThrow(HtmlStillError);
    expect(() => assertSafeHtmlFragment('<a href="https://example.com">x</a>', 'HTML')).toThrow(HtmlStillError);
    expect(() => assertSafeHtmlFragment('<div style="background:url(https://x)">x</div>', 'HTML')).toThrow(HtmlStillError);
    expect(() => assertSafeCss('@import "https://x";')).toThrow(HtmlStillError);
    expect(() => assertSafeCss('body{background:url(file:///etc/passwd)}')).toThrow(HtmlStillError);
  });

  it('wraps a local fragment without fetching remote resources', () => {
    const document = wrapHtmlStillDocument({
      markup: '<div class="card">Headline</div>',
      css: '.card{color:#fff}',
      width: 1920,
      height: 1080,
      background: 'opaque',
      pageBackground: '#0056a7'
    });
    expect(document).toContain('<div class="card">Headline</div>');
    expect(document).toContain('background:#0056a7');
    expect(document).not.toMatch(/https?:\/\//i);
  });
});

describe('HTML still templates', () => {
  it('builds a 1920x1080 headline card from local data', () => {
    const card = resolveHtmlStillTemplate('headline_card', {
      kicker: 'Live',
      title: 'Northwind ARR',
      subtitle: 'Q5 recap'
    });
    expect(card.markup).toContain('Northwind ARR');
    expect(card.markup).toContain('Q5 recap');
    expect(card.markup).not.toContain('<script');
  });

  it('builds a comparison card from local rows', () => {
    const card = resolveHtmlStillTemplate('comparison_card', {
      title: 'Before / After',
      rows: [{ label: 'ARR', left: '24', right: '88' }]
    });
    expect(card.markup).toContain('ARR');
    expect(card.markup).toContain('24');
    expect(card.markup).toContain('88');
  });
});

describe('HTML still fingerprint', () => {
  it('changes when template data changes', () => {
    const base = { template: 'headline_card' as const, templateData: { title: 'A' }, width: 1920, height: 1080, background: 'opaque' as const };
    const first = createHtmlStillFingerprint(base);
    const second = createHtmlStillFingerprint({ ...base, templateData: { title: 'B' } });
    expect(first).not.toBe(second);
    expect(htmlStillAssetIsCurrent({ kind: 'html', ...base, assetId: 'a1', fingerprint: first })).toBe(true);
    expect(htmlStillAssetIsCurrent({ kind: 'html', ...base, templateData: { title: 'B' }, assetId: 'a1', fingerprint: first })).toBe(false);
  });
});

describe('HTML still Chromium PNG', () => {
  it('renders an opaque 1920x1080 PNG', async () => {
    const still = await renderHtmlStillPng({
      markup: '<div style="width:100%;height:100%;background:#0056a7;color:#fff;font-size:80px;display:flex;align-items:center;justify-content:center;">Headline</div>',
      width: 1920,
      height: 1080,
      background: 'opaque',
      pageBackground: '#0056a7'
    });
    expect(still.png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    const info = await sharp(still.png).metadata();
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(info.format).toBe('png');
  }, 30_000);

  it('renders a transparent background PNG', async () => {
    const still = await renderHtmlStillPng({
      markup: '<div style="width:400px;height:200px;background:#ff5a5f;"></div>',
      width: 640,
      height: 360,
      background: 'transparent'
    });
    const { data, info } = await sharp(still.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(640);
    expect(info.height).toBe(360);
    expect(info.channels).toBe(4);
    let transparent = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 16) {
        transparent += 1;
      }
    }
    expect(transparent).toBeGreaterThan(100);
  }, 30_000);

  it('rejects an invalid viewport instead of rendering a partial PNG', async () => {
    await expect(renderHtmlStillPng({
      markup: '<div>x</div>',
      width: 10,
      height: 10,
      background: 'opaque'
    })).rejects.toMatchObject({ code: 'html.invalid' });
  });
});

describe('HTML still project validation and resolver', () => {
  it('requires a template or markup', () => {
    const project = makeProject(makeHtmlScene({ kind: 'html' }));
    const result = validateProject(project);
    expect(result.errors.some((issue) => issue.code === 'scene.visual.html.source.required')).toBe(true);
  });

  it('marks html without a PNG as planned and with a PNG as renderable', () => {
    const planned = resolveRenderPlan(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'headline_card',
      templateData: { title: 'Live' }
    })));
    expect(planned.scenes[0].status).toBe('planned');
    expect(planned.scenes[0].source.kind).toBe('html');

    const renderable = resolveRenderPlan(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'headline_card',
      templateData: { title: 'Live' },
      assetId: 'html-1'
    }), [makeAsset('html-1')]));
    expect(renderable.scenes[0].status).toBe('renderable');
    expect(renderable.scenes[0].source.assetPath).toBe('assets/html-1.png');
  });
});

describe('HTML still persist and studio bind', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists a PNG asset and binds it to the studio bigscreen', async () => {
    const composition = createStudioComposition({
      backgroundLocalPath: 'assets/studio/studio_back.png',
      foregroundLocalPath: 'assets/studio/studio_desk.png',
      presenterMode: 'full_canvas'
    });
    composition.layers = composition.layers.filter((layer) => layer.type !== 'presenter');
    const project = makeProject(makeHtmlScene({
      kind: 'html',
      template: 'headline_card',
      templateData: { title: 'Live' },
      width: 1920,
      height: 1080,
      background: 'opaque'
    }, { composition }));

    vi.spyOn(projectStore, 'getProject').mockResolvedValue(project);
    vi.spyOn(mediaStore, 'saveAsset').mockResolvedValue({
      asset: makeAsset('html-new', { localPath: 'assets/html-new.png', width: 1920, height: 1080 })
    });
    let persisted: Project | undefined;
    vi.spyOn(projectStore, 'mutateProject').mockImplementation(async (_id, mutator) => {
      persisted = await mutator(structuredClone(project));
      return persisted;
    });

    const result = await htmlStillService.renderSceneHtmlStill(project.id, 'scene-html');
    expect(result.reused).toBe(false);
    expect(result.assetId).toBe('html-new');

    const scene = persisted!.scenes[0];
    expect(scene.visual).toMatchObject({ kind: 'html', assetId: 'html-new' });
    const screen = scene.composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.image);
    expect(screen).toMatchObject({
      type: 'image',
      assetId: 'html-new',
      localPath: 'assets/html-new.png',
      rect: STUDIO_BIGSCREEN_RECT,
      fit: 'contain'
    });
  }, 30_000);

  it('reuses a current PNG without calling Chromium', async () => {
    const visual: HtmlVisual = {
      kind: 'html',
      template: 'headline_card',
      templateData: { title: 'Live' },
      width: 1920,
      height: 1080,
      background: 'opaque',
      assetId: 'html-1',
      fingerprint: ''
    };
    visual.fingerprint = createHtmlStillFingerprint(visual);
    const project = makeProject(makeHtmlScene(visual), [makeAsset('html-1')]);
    vi.spyOn(projectStore, 'getProject').mockResolvedValue(project);
    const save = vi.spyOn(mediaStore, 'saveAsset');

    const result = await htmlStillService.renderSceneHtmlStill(project.id, 'scene-html');
    expect(result.reused).toBe(true);
    expect(result.assetId).toBe('html-1');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('HTML still API route', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearThrottleStateForTests();
  });

  it('requires authentication', async () => {
    const response = await renderHtmlStillRoute(
      new Request('http://localhost/api/projects/project-html-still/scenes/scene-html/render-html-still', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      }),
      { params: Promise.resolve({ id: 'project-html-still', sceneId: 'scene-html' }) }
    );
    expect(response.status).toBe(401);
  });

  it('returns the still result for the owner', async () => {
    vi.spyOn(projectStore, 'getProject').mockResolvedValue({ id: 'project-html-still', ownerId: 'user-a' } as never);
    const render = vi.spyOn(htmlStillService, 'renderSceneHtmlStill').mockResolvedValue({
      sceneId: 'scene-html',
      assetId: 'html-1',
      localPath: 'assets/html-1.png',
      fingerprint: 'abc',
      width: 1920,
      height: 1080,
      reused: false
    });

    const response = await renderHtmlStillRoute(
      new Request('http://localhost/api/projects/project-html-still/scenes/scene-html/render-html-still', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE_NAME}=${createUserSessionCookie('user-a')}`
        },
        body: JSON.stringify({ regenerate: true })
      }),
      { params: Promise.resolve({ id: 'project-html-still', sceneId: 'scene-html' }) }
    );
    const body = await response.json() as { assetId?: string };

    expect(response.status).toBe(200);
    expect(body.assetId).toBe('html-1');
    expect(render).toHaveBeenCalledWith('project-html-still', 'scene-html', { regenerate: true });
  });
});
