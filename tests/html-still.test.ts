import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import { POST as renderHtmlStillRoute } from '@/app/api/projects/[id]/scenes/[sceneId]/render-html-still/route';
import { createHtmlStillFingerprint, htmlStillAssetIsCurrent } from '@/lib/render/html-still/fingerprint';
import * as chromiumStill from '@/lib/render/html-still/chromium-still';
import { renderHtmlStillPng } from '@/lib/render/html-still/chromium-still';
import { HtmlStillError } from '@/lib/render/html-still/errors';
import { assertSafeCss, assertSafeHtmlFragment, wrapHtmlStillDocument } from '@/lib/render/html-still/sanitize';
import * as htmlStillService from '@/lib/render/html-still/service';
import { injectTrustedHtmlStillImages, resolveHtmlStillImageAsset, resolveHtmlStillImages } from '@/lib/render/html-still/image-assets';
import { canonicalizeHtmlStillTemplateId, parseHtmlStillTemplateData, resolveHtmlStillTemplate } from '@/lib/render/html-still/templates';
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
    expect(() => assertSafeHtmlFragment('<img src="data:image/png;base64,AAAA">', 'HTML')).toThrow(/data|URL/i);
    expect(() => assertSafeHtmlFragment('<img src="file:///etc/passwd">', 'HTML')).toThrow(HtmlStillError);
    expect(() => assertSafeHtmlFragment('<img src="https://example.com/x.png">', 'HTML')).toThrow(HtmlStillError);
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
    const card = resolveHtmlStillTemplate('headline', {
      kicker: 'Live',
      title: 'Northwind ARR',
      subtitle: 'Q5 recap',
      source: 'Earnings call'
    });
    expect(card.markup).toContain('Northwind ARR');
    expect(card.markup).toContain('Q5 recap');
    expect(card.markup).toContain('Earnings call');
    expect(card.markup).not.toContain('<script');
    expect(card.css).toContain('font-size:92px');
  });

  it('accepts the P120 headline_card alias', () => {
    expect(canonicalizeHtmlStillTemplateId('headline_card')).toBe('headline');
    const card = resolveHtmlStillTemplate('headline_card', {
      title: 'Northwind ARR',
      subtitle: 'Q5 recap'
    });
    expect(card.markup).toContain('Northwind ARR');
  });

  it('builds a stat card from typed data', () => {
    const card = resolveHtmlStillTemplate('stat_card', {
      label: 'NPS',
      value: '72',
      detail: 'Trailing 90 days',
      trend: 'up',
      delta: '+8'
    });
    expect(card.markup).toContain('NPS');
    expect(card.markup).toContain('72');
    expect(card.markup).toContain('Trailing 90 days');
    expect(card.markup).toContain('+8');
    expect(card.markup).toContain('trend-up');
  });

  it('builds a comparison card from named items', () => {
    const card = resolveHtmlStillTemplate('comparison', {
      title: 'Before / After',
      items: [
        { name: 'Before', features: [{ label: 'ARR', value: '24' }] },
        { name: 'After', features: [{ label: 'ARR', value: '88' }] }
      ]
    });
    expect(card.markup).toContain('ARR');
    expect(card.markup).toContain('24');
    expect(card.markup).toContain('88');
    expect(card.markup).toContain('Before');
    expect(card.markup).toContain('After');
  });

  it('accepts the P120 comparison_card rows alias', () => {
    const card = resolveHtmlStillTemplate('comparison_card', {
      title: 'Before / After',
      rows: [{ label: 'ARR', left: '24', right: '88' }]
    });
    expect(card.markup).toContain('ARR');
    expect(card.markup).toContain('24');
    expect(card.markup).toContain('88');
  });

  it('is deterministic for the same template data', () => {
    const data = { title: 'Live', subtitle: 'Q5', source: 'IR' };
    expect(resolveHtmlStillTemplate('headline', data)).toEqual(resolveHtmlStillTemplate('headline', { ...data }));
  });

  it('escapes untrusted template text', () => {
    const card = resolveHtmlStillTemplate('headline', {
      title: '<script>alert(1)</script>',
      subtitle: 'A & B'
    });
    expect(card.markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(card.markup).toContain('A &amp; B');
    expect(card.markup).not.toContain('<script>alert(1)</script>');
  });

  it('rejects unknown templates, missing fields, and invalid comparison data', () => {
    expect(() => resolveHtmlStillTemplate('unknown' as never, { title: 'x' })).toThrow(HtmlStillError);
    expect(() => parseHtmlStillTemplateData('headline', {})).toThrow(/title is required/);
    expect(() => parseHtmlStillTemplateData('stat_card', { label: 'NPS' })).toThrow(/value is required/);
    expect(() => parseHtmlStillTemplateData('comparison', { title: 'X', items: [{ name: 'Only', features: [{ label: 'A', value: '1' }] }] })).toThrow(/2-4 items/);
    expect(() => parseHtmlStillTemplateData('comparison', {
      title: 'X',
      items: [
        { name: 'A', features: [{ label: 'One', value: '1' }] },
        { name: 'B', features: [{ label: 'One', value: '1' }, { label: 'Two', value: '2' }] }
      ]
    })).toThrow(/same number of features/);
    expect(() => parseHtmlStillTemplateData('headline', { title: 'x', imageAssetId: 'https://example.com/x.png' })).toThrow(/asset id/);
  });

  it('builds a bar chart from typed numeric points', () => {
    const card = resolveHtmlStillTemplate('chart', {
      title: 'ARR',
      kind: 'bar',
      unit: 'M',
      points: [
        { label: 'Q1', value: 12 },
        { label: 'Q2', value: 18 },
        { label: 'Q3', value: 9 }
      ]
    });
    expect(card.markup).toContain('ARR');
    expect(card.markup).toContain('<svg');
    expect(card.markup).toContain('<rect');
    expect(card.markup).toContain('Q1');
    expect(card.markup).toContain('12');
    expect(card.markup).not.toContain('<script');
    const document = wrapHtmlStillDocument({
      markup: card.markup,
      css: card.css,
      width: 1920,
      height: 1080,
      background: 'opaque',
      pageBackground: card.background
    });
    expect(document).toContain('<svg');
    expect(document).not.toMatch(/https?:\/\//i);
  });

  it('builds a line chart and keeps equal or negative values readable', () => {
    const equal = resolveHtmlStillTemplate('chart', {
      title: 'Flat',
      kind: 'line',
      points: [
        { label: 'A', value: 10 },
        { label: 'B', value: 10 }
      ]
    });
    expect(equal.markup).toContain('<polyline');
    expect(equal.markup).toContain('10');
    const mixed = resolveHtmlStillTemplate('chart', {
      title: 'Delta',
      kind: 'bar',
      points: [
        { label: 'Loss', value: -4 },
        { label: 'Zero', value: 0 },
        { label: 'Gain', value: 6 }
      ]
    });
    expect(mixed.markup).toContain('-4');
    expect(mixed.markup).toContain('Gain');
  });

  it('builds a vertical timeline and omits missing dates', () => {
    const card = resolveHtmlStillTemplate('timeline', {
      title: 'Roadmap',
      events: [
        { date: 'Jan', label: 'Kickoff', detail: 'Scope locked' },
        { label: 'Beta', detail: 'First customer' }
      ]
    });
    expect(card.markup).toContain('Roadmap');
    expect(card.markup).toContain('Kickoff');
    expect(card.markup).toContain('Scope locked');
    expect(card.markup).toContain('date-empty');
    expect(card.markup).toContain('Beta');
  });

  it('is deterministic for chart and timeline data', () => {
    const chart = { title: 'ARR', kind: 'bar' as const, points: [{ label: 'Q1', value: 12 }] };
    const timeline = { title: 'Roadmap', events: [{ label: 'Kickoff', detail: 'Go' }] };
    expect(resolveHtmlStillTemplate('chart', chart)).toEqual(resolveHtmlStillTemplate('chart', { ...chart, points: [...chart.points] }));
    expect(resolveHtmlStillTemplate('timeline', timeline)).toEqual(resolveHtmlStillTemplate('timeline', { ...timeline, events: [...timeline.events] }));
  });

  it('escapes untrusted chart and timeline text', () => {
    const chart = resolveHtmlStillTemplate('chart', {
      title: '<b>ARR</b>',
      kind: 'bar',
      points: [{ label: 'Q1 & Q2', value: 3 }]
    });
    expect(chart.markup).toContain('&lt;b&gt;ARR&lt;/b&gt;');
    expect(chart.markup).toContain('Q1 &amp; Q2');
    expect(chart.markup).not.toContain('<b>ARR</b>');
    const timeline = resolveHtmlStillTemplate('timeline', {
      title: 'Plan',
      events: [{ date: 'Jan', label: '<img>', detail: 'A & B' }]
    });
    expect(timeline.markup).toContain('&lt;img&gt;');
    expect(timeline.markup).toContain('A &amp; B');
  });

  it('rejects empty, oversized, and non-numeric chart or timeline data', () => {
    expect(() => parseHtmlStillTemplateData('chart', { title: 'ARR', kind: 'pie', points: [{ label: 'Q1', value: 1 }] })).toThrow(/bar or line/);
    expect(() => parseHtmlStillTemplateData('chart', { title: 'ARR', kind: 'bar', points: [] })).toThrow(/1-8 points/);
    expect(() => parseHtmlStillTemplateData('chart', { title: 'ARR', kind: 'bar', points: [{ label: 'Q1', value: '12' }] })).toThrow(/finite number/);
    expect(() => parseHtmlStillTemplateData('chart', { title: 'ARR', kind: 'bar', points: [{ label: 'Q1', value: Number.NaN }] })).toThrow(/finite number/);
    expect(() => parseHtmlStillTemplateData('chart', {
      title: 'ARR',
      kind: 'bar',
      points: Array.from({ length: 9 }, (_, index) => ({ label: `P${index}`, value: index }))
    })).toThrow(/1-8 points/);
    expect(() => parseHtmlStillTemplateData('timeline', { title: 'Roadmap', events: [] })).toThrow(/1-6 events/);
    expect(() => parseHtmlStillTemplateData('timeline', { title: 'Roadmap', events: [{ label: 'Only' }] })).toThrow(/detail is required/);
    expect(() => parseHtmlStillTemplateData('timeline', {
      title: 'Roadmap',
      events: Array.from({ length: 7 }, (_, index) => ({ label: `E${index}`, detail: 'x' }))
    })).toThrow(/1-6 events/);
  });

  it('builds a location card without inventing coordinates', () => {
    const card = resolveHtmlStillTemplate('location_card', {
      place: 'Helsinki',
      region: 'Finland',
      detail: 'Studio origin'
    });
    expect(card.markup).toContain('Helsinki');
    expect(card.markup).toContain('Finland');
    expect(card.markup).toContain('Studio origin');
    expect(card.markup).toContain('class="pin"');
    expect(card.markup).not.toContain('coords');
    const withCoords = resolveHtmlStillTemplate('location_card', {
      place: 'Helsinki',
      lat: 60.17,
      lon: 24.94
    });
    expect(withCoords.markup).toContain('60.17');
    expect(withCoords.markup).toContain('24.94');
  });

  it('builds a schematic route map from location ids and links', () => {
    const card = resolveHtmlStillTemplate('route_map', {
      title: 'Nordic hop',
      locations: [
        { id: 'hel', label: 'Helsinki' },
        { id: 'sto', label: 'Stockholm' }
      ],
      links: [{ from: 'hel', to: 'sto' }]
    });
    expect(card.markup).toContain('Nordic hop');
    expect(card.markup).toContain('Schematic map');
    expect(card.markup).toContain('<svg');
    expect(card.markup).toContain('Helsinki');
    expect(card.markup).toContain('Stockholm');
    expect(card.markup).toContain('<line');
    const document = wrapHtmlStillDocument({
      markup: card.markup,
      css: card.css,
      width: 1920,
      height: 1080,
      background: 'opaque',
      pageBackground: card.background
    });
    expect(document).not.toMatch(/https?:\/\//i);
  });

  it('projects complete coordinates and keeps schematic layout without them', () => {
    const geo = resolveHtmlStillTemplate('route_map', {
      title: 'Geo',
      locations: [
        { id: 'a', label: 'West', lat: 60, lon: 10 },
        { id: 'b', label: 'East', lat: 60, lon: 30 }
      ],
      links: [{ from: 'a', to: 'b' }]
    });
    const schematic = resolveHtmlStillTemplate('route_map', {
      title: 'Geo',
      locations: [
        { id: 'a', label: 'West' },
        { id: 'b', label: 'East' }
      ],
      links: [{ from: 'a', to: 'b' }]
    });
    expect(geo.markup).not.toEqual(schematic.markup);
    expect(geo.markup).toContain('West');
    expect(schematic.markup).toContain('East');
  });

  it('is deterministic for location and route data', () => {
    const location = { place: 'Helsinki', region: 'Finland' };
    const route = {
      title: 'Hop',
      locations: [{ id: 'hel', label: 'Helsinki' }, { id: 'sto', label: 'Stockholm' }],
      links: [{ from: 'hel', to: 'sto' }]
    };
    expect(resolveHtmlStillTemplate('location_card', location)).toEqual(resolveHtmlStillTemplate('location_card', { ...location }));
    expect(resolveHtmlStillTemplate('route_map', route)).toEqual(resolveHtmlStillTemplate('route_map', {
      ...route,
      locations: [...route.locations],
      links: [...route.links]
    }));
  });

  it('escapes untrusted location and route text', () => {
    const location = resolveHtmlStillTemplate('location_card', {
      place: '<b>Helsinki</b>',
      region: 'A & B'
    });
    expect(location.markup).toContain('&lt;b&gt;Helsinki&lt;/b&gt;');
    expect(location.markup).toContain('A &amp; B');
    expect(location.markup).not.toContain('<b>Helsinki</b>');
    const route = resolveHtmlStillTemplate('route_map', {
      title: '<img>',
      locations: [
        { id: 'a', label: 'Q1 & Q2' },
        { id: 'b', label: '<script>' }
      ],
      links: [{ from: 'a', to: 'b' }]
    });
    expect(route.markup).toContain('&lt;img&gt;');
    expect(route.markup).toContain('Q1 &amp; Q2');
    expect(route.markup).toContain('&lt;script&gt;');
  });

  it('rejects invalid location cards and route maps', () => {
    expect(() => parseHtmlStillTemplateData('location_card', {})).toThrow(/place is required/);
    expect(() => parseHtmlStillTemplateData('location_card', { place: 'Helsinki', lat: 60 })).toThrow(/both be set/);
    expect(() => parseHtmlStillTemplateData('location_card', { place: 'Helsinki', lat: 91, lon: 24 })).toThrow(/between -90 and 90/);
    expect(() => parseHtmlStillTemplateData('location_card', { place: 'Helsinki', lat: 60, lon: 200 })).toThrow(/between -180 and 180/);
    expect(() => parseHtmlStillTemplateData('route_map', { title: 'Hop', locations: [{ id: 'a', label: 'A' }], links: [{ from: 'a', to: 'b' }] })).toThrow(/2-6 locations/);
    expect(() => parseHtmlStillTemplateData('route_map', {
      title: 'Hop',
      locations: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }],
      links: [{ from: 'a', to: 'b' }]
    })).toThrow(/duplicate location id/);
    expect(() => parseHtmlStillTemplateData('route_map', {
      title: 'Hop',
      locations: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      links: [{ from: 'a', to: 'missing' }]
    })).toThrow(/unknown location id/);
    expect(() => parseHtmlStillTemplateData('route_map', {
      title: 'Hop',
      locations: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      links: [{ from: 'a', to: 'a' }]
    })).toThrow(/cannot connect a location to itself/);
    expect(() => parseHtmlStillTemplateData('route_map', {
      title: 'Hop',
      locations: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      links: []
    })).toThrow(/1-8 links/);
  });

  it('builds a product card and uses an explicit placeholder without an image', () => {
    const card = resolveHtmlStillTemplate('product_card', {
      name: 'Northwind Hub',
      subtitle: 'Studio kit',
      description: 'Local still',
      price: 129,
      currency: 'EUR',
      features: [{ label: 'Weight', value: '1.2 kg' }]
    });
    expect(card.markup).toContain('Northwind Hub');
    expect(card.markup).toContain('Studio kit');
    expect(card.markup).toContain('Local still');
    expect(card.markup).toContain('EUR 129');
    expect(card.markup).toContain('Weight');
    expect(card.markup).toContain('1.2 kg');
    expect(card.markup).toContain('No image');
    expect(card.markup).toContain('image-missing');
    expect(card.markup).not.toContain('<script');
    const withAsset = resolveHtmlStillTemplate('product_card', {
      name: 'Northwind Hub',
      imageAssetId: 'product-1'
    });
    expect(withAsset.markup).toContain('Asset');
    expect(withAsset.markup).not.toContain('No image');
  });

  it('builds a product comparison with shared feature labels', () => {
    const card = resolveHtmlStillTemplate('product_comparison', {
      title: 'Air vs Pro',
      products: [
        { name: 'Air', features: [{ label: 'Weight', value: '0.9 kg' }, { label: 'Range', value: '8 h' }] },
        { name: 'Pro', imageAssetId: 'pro-1', features: [{ label: 'Weight', value: '1.4 kg' }, { label: 'Range', value: '12 h' }] }
      ]
    });
    expect(card.markup).toContain('Air vs Pro');
    expect(card.markup).toContain('Air');
    expect(card.markup).toContain('Pro');
    expect(card.markup).toContain('0.9 kg');
    expect(card.markup).toContain('12 h');
    expect(card.markup).toContain('No image');
    expect(card.markup).toContain('Asset');
  });

  it('builds feature callouts and defaults even/odd sides', () => {
    const card = resolveHtmlStillTemplate('feature_callouts', {
      name: 'Northwind Hub',
      callouts: [
        { label: 'Lens', detail: 'Wide capture' },
        { label: 'Mic', detail: 'Studio voice' }
      ]
    });
    expect(card.markup).toContain('Northwind Hub');
    expect(card.markup).toContain('Lens');
    expect(card.markup).toContain('Wide capture');
    expect(card.markup).toContain('Mic');
    expect(card.markup).toContain('No image');
    expect(card.markup).toContain('<svg');
    expect(card.markup).not.toContain('xmlns=');
    const sided = resolveHtmlStillTemplate('feature_callouts', {
      name: 'Hub',
      imageAssetId: 'hub-1',
      callouts: [
        { label: 'A', detail: 'Left', side: 'left' },
        { label: 'B', detail: 'Right', side: 'right' }
      ]
    });
    expect(sided.markup).toContain('Asset');
    expect(sided.markup).toContain('Left');
    expect(sided.markup).toContain('Right');
  });

  it('is deterministic for product templates', () => {
    const product = { name: 'Hub', features: [{ label: 'Weight', value: '1 kg' }] };
    const comparison = {
      title: 'Compare',
      products: [
        { name: 'Air', features: [{ label: 'Weight', value: '1 kg' }] },
        { name: 'Pro', features: [{ label: 'Weight', value: '2 kg' }] }
      ]
    };
    const callouts = { name: 'Hub', callouts: [{ label: 'Lens', detail: 'Wide' }] };
    expect(resolveHtmlStillTemplate('product_card', product)).toEqual(resolveHtmlStillTemplate('product_card', { ...product, features: [...product.features] }));
    expect(resolveHtmlStillTemplate('product_comparison', comparison)).toEqual(resolveHtmlStillTemplate('product_comparison', {
      ...comparison,
      products: comparison.products.map((item) => ({ ...item, features: [...item.features] }))
    }));
    expect(resolveHtmlStillTemplate('feature_callouts', callouts)).toEqual(resolveHtmlStillTemplate('feature_callouts', {
      ...callouts,
      callouts: [...callouts.callouts]
    }));
  });

  it('escapes untrusted product template text', () => {
    const product = resolveHtmlStillTemplate('product_card', {
      name: '<b>Hub</b>',
      subtitle: 'A & B',
      description: '<img>',
      features: [{ label: 'Q1 & Q2', value: '<script>' }]
    });
    expect(product.markup).toContain('&lt;b&gt;Hub&lt;/b&gt;');
    expect(product.markup).toContain('A &amp; B');
    expect(product.markup).toContain('&lt;img&gt;');
    expect(product.markup).toContain('Q1 &amp; Q2');
    expect(product.markup).toContain('&lt;script&gt;');
    expect(product.markup).not.toContain('<b>Hub</b>');
    const comparison = resolveHtmlStillTemplate('product_comparison', {
      title: '<img>',
      products: [
        { name: 'A & B', features: [{ label: '<b>W</b>', value: '1' }] },
        { name: 'C', features: [{ label: '<b>W</b>', value: '2' }] }
      ]
    });
    expect(comparison.markup).toContain('&lt;img&gt;');
    expect(comparison.markup).toContain('A &amp; B');
    expect(comparison.markup).toContain('&lt;b&gt;W&lt;/b&gt;');
    const callouts = resolveHtmlStillTemplate('feature_callouts', {
      name: '<script>',
      callouts: [{ label: 'A & B', detail: '<img>' }]
    });
    expect(callouts.markup).toContain('&lt;script&gt;');
    expect(callouts.markup).toContain('A &amp; B');
    expect(callouts.markup).toContain('&lt;img&gt;');
  });

  it('rejects invalid product template data', () => {
    expect(() => parseHtmlStillTemplateData('product_card', {})).toThrow(/name is required/);
    expect(() => parseHtmlStillTemplateData('product_card', { name: 'Hub', currency: 'EUR' })).toThrow(/currency requires price/);
    expect(() => parseHtmlStillTemplateData('product_card', { name: 'Hub', price: -1 })).toThrow(/finite number/);
    expect(() => parseHtmlStillTemplateData('product_card', { name: 'Hub', imageAssetId: 'https://example.com/x.png' })).toThrow(/asset id/);
    expect(() => parseHtmlStillTemplateData('product_comparison', { title: 'X', products: [{ name: 'Only', features: [{ label: 'A', value: '1' }] }] })).toThrow(/2-4 products/);
    expect(() => parseHtmlStillTemplateData('product_comparison', {
      title: 'X',
      products: [
        { name: 'A', features: [{ label: 'One', value: '1' }] },
        { name: 'B', features: [{ label: 'Two', value: '2' }] }
      ]
    })).toThrow(/same feature labels/);
    expect(() => parseHtmlStillTemplateData('product_comparison', {
      title: 'X',
      products: [
        { name: 'A', features: [{ label: 'One', value: '1' }] },
        { name: 'B', features: [{ label: 'One', value: '1' }, { label: 'Two', value: '2' }] }
      ]
    })).toThrow(/same number of features/);
    expect(() => parseHtmlStillTemplateData('feature_callouts', { name: 'Hub', callouts: [] })).toThrow(/1-4 callouts/);
    expect(() => parseHtmlStillTemplateData('feature_callouts', { name: 'Hub', callouts: [{ label: 'Only' }] })).toThrow(/detail is required/);
    expect(() => parseHtmlStillTemplateData('feature_callouts', {
      name: 'Hub',
      callouts: Array.from({ length: 5 }, (_, index) => ({ label: `C${index}`, detail: 'x' }))
    })).toThrow(/1-4 callouts/);
    expect(() => parseHtmlStillTemplateData('feature_callouts', {
      name: 'Hub',
      callouts: [{ label: 'A', detail: 'B', side: 'up' }]
    })).toThrow(/left or right/);
  });

  it('builds a flow diagram from unique steps and directed links', () => {
    const card = resolveHtmlStillTemplate('flow_diagram', {
      title: 'Studio flow',
      steps: [
        { id: 'brief', label: 'Brief', detail: 'Lock scope' },
        { id: 'render', label: 'Render' },
        { id: 'compose', label: 'Compose' }
      ],
      links: [
        { from: 'brief', to: 'render' },
        { from: 'render', to: 'compose' }
      ]
    });
    expect(card.markup).toContain('Studio flow');
    expect(card.markup).toContain('Process flow');
    expect(card.markup).toContain('Brief');
    expect(card.markup).toContain('Lock scope');
    expect(card.markup).toContain('Render');
    expect(card.markup).toContain('<svg');
    expect(card.markup).toContain('<polygon');
    expect(card.markup).not.toContain('xmlns=');
    expect(card.markup).not.toContain('url(#');
    const document = wrapHtmlStillDocument({
      markup: card.markup,
      css: card.css,
      width: 1920,
      height: 1080,
      background: 'opaque',
      pageBackground: card.background
    });
    expect(document).not.toMatch(/https?:\/\//i);
  });

  it('builds a decision tree with question diamonds and outcome boxes', () => {
    const card = resolveHtmlStillTemplate('decision_tree', {
      title: 'Go or wait',
      nodes: [
        { id: 'ready', kind: 'question', label: 'Ready?' },
        { id: 'go', kind: 'outcome', label: 'Ship' },
        { id: 'hold', kind: 'outcome', label: 'Hold' }
      ],
      branches: [
        { from: 'ready', to: 'go', label: 'Ja' },
        { from: 'ready', to: 'hold', label: 'Nee' }
      ]
    });
    expect(card.markup).toContain('Go or wait');
    expect(card.markup).toContain('Decision tree');
    expect(card.markup).toContain('Ready?');
    expect(card.markup).toContain('Ship');
    expect(card.markup).toContain('Ja');
    expect(card.markup).toContain('<polygon');
    expect(card.markup).toContain('<rect');
  });

  it('builds a system diagram from labeled components', () => {
    const card = resolveHtmlStillTemplate('system_diagram', {
      title: 'Studio stack',
      components: [
        { id: 'author', label: 'Authoring', role: 'Input' },
        { id: 'still', label: 'HTML still', role: 'PNG' }
      ],
      links: [{ from: 'author', to: 'still', label: 'render' }]
    });
    expect(card.markup).toContain('Studio stack');
    expect(card.markup).toContain('System map');
    expect(card.markup).toContain('Authoring');
    expect(card.markup).toContain('Input');
    expect(card.markup).toContain('render');
  });

  it('is deterministic for diagram templates', () => {
    const flow = {
      title: 'Flow',
      steps: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      links: [{ from: 'a', to: 'b' }]
    };
    const decision = {
      title: 'Tree',
      nodes: [
        { id: 'q', kind: 'question' as const, label: 'Q' },
        { id: 'yes', kind: 'outcome' as const, label: 'Yes' }
      ],
      branches: [{ from: 'q', to: 'yes', label: 'Ja' }]
    };
    const system = {
      title: 'Stack',
      components: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      links: [{ from: 'a', to: 'b' }]
    };
    expect(resolveHtmlStillTemplate('flow_diagram', flow)).toEqual(resolveHtmlStillTemplate('flow_diagram', {
      ...flow,
      steps: [...flow.steps],
      links: [...flow.links]
    }));
    expect(resolveHtmlStillTemplate('decision_tree', decision)).toEqual(resolveHtmlStillTemplate('decision_tree', {
      ...decision,
      nodes: [...decision.nodes],
      branches: [...decision.branches]
    }));
    expect(resolveHtmlStillTemplate('system_diagram', system)).toEqual(resolveHtmlStillTemplate('system_diagram', {
      ...system,
      components: [...system.components],
      links: [...system.links]
    }));
  });

  it('escapes untrusted diagram text', () => {
    const flow = resolveHtmlStillTemplate('flow_diagram', {
      title: '<b>Flow</b>',
      steps: [
        { id: 'a', label: 'A & B', detail: '<img>' },
        { id: 'b', label: '<script>' }
      ],
      links: [{ from: 'a', to: 'b' }]
    });
    expect(flow.markup).toContain('&lt;b&gt;Flow&lt;/b&gt;');
    expect(flow.markup).toContain('A &amp; B');
    expect(flow.markup).toContain('&lt;img&gt;');
    expect(flow.markup).toContain('&lt;script&gt;');
    expect(flow.markup).not.toContain('<b>Flow</b>');
    const decision = resolveHtmlStillTemplate('decision_tree', {
      title: '<img>',
      nodes: [
        { id: 'q', kind: 'question', label: 'Q & A' },
        { id: 'out', kind: 'outcome', label: '<b>No</b>' }
      ],
      branches: [{ from: 'q', to: 'out', label: '<script>' }]
    });
    expect(decision.markup).toContain('&lt;img&gt;');
    expect(decision.markup).toContain('Q &amp; A');
    expect(decision.markup).toContain('&lt;b&gt;No&lt;/b&gt;');
    expect(decision.markup).toContain('&lt;script&gt;');
    const system = resolveHtmlStillTemplate('system_diagram', {
      title: '<b>Stack</b>',
      components: [
        { id: 'a', label: 'A & B', role: '<img>' },
        { id: 'b', label: 'C' }
      ],
      links: [{ from: 'a', to: 'b', label: '<script>' }]
    });
    expect(system.markup).toContain('&lt;b&gt;Stack&lt;/b&gt;');
    expect(system.markup).toContain('A &amp; B');
    expect(system.markup).toContain('&lt;img&gt;');
    expect(system.markup).toContain('&lt;script&gt;');
  });

  it('rejects invalid diagram structures', () => {
    expect(() => parseHtmlStillTemplateData('flow_diagram', { title: 'X', steps: [{ id: 'a', label: 'A' }], links: [{ from: 'a', to: 'b' }] })).toThrow(/2-8 steps/);
    expect(() => parseHtmlStillTemplateData('flow_diagram', {
      title: 'X',
      steps: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }],
      links: [{ from: 'a', to: 'b' }]
    })).toThrow(/duplicate step id/);
    expect(() => parseHtmlStillTemplateData('flow_diagram', {
      title: 'X',
      steps: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      links: [{ from: 'a', to: 'missing' }]
    })).toThrow(/unknown step id/);
    expect(() => parseHtmlStillTemplateData('flow_diagram', {
      title: 'X',
      steps: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      links: [{ from: 'a', to: 'a' }]
    })).toThrow(/cannot connect a node to itself/);
    expect(() => parseHtmlStillTemplateData('flow_diagram', {
      title: 'X',
      steps: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      links: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]
    })).toThrow(/cannot contain a cycle/);
    expect(() => parseHtmlStillTemplateData('decision_tree', {
      title: 'X',
      nodes: [{ id: 'a', kind: 'outcome', label: 'A' }, { id: 'b', kind: 'outcome', label: 'B' }],
      branches: [{ from: 'a', to: 'b' }]
    })).toThrow(/at least one question/);
    expect(() => parseHtmlStillTemplateData('decision_tree', {
      title: 'X',
      nodes: [{ id: 'q', kind: 'question', label: 'Q' }, { id: 'out', kind: 'outcome', label: 'Out' }],
      branches: [{ from: 'out', to: 'q' }]
    })).toThrow(/must start from a question/);
    expect(() => parseHtmlStillTemplateData('decision_tree', {
      title: 'X',
      nodes: [{ id: 'q', kind: 'question', label: 'Q' }, { id: 'out', kind: 'outcome', label: 'Out' }],
      branches: []
    })).toThrow(/1-8 branches/);
    expect(() => parseHtmlStillTemplateData('decision_tree', {
      title: 'X',
      nodes: [
        { id: 'q', kind: 'question', label: 'Q' },
        { id: 'a', kind: 'outcome', label: 'A' },
        { id: 'b', kind: 'outcome', label: 'B' },
        { id: 'c', kind: 'outcome', label: 'C' },
        { id: 'd', kind: 'outcome', label: 'D' }
      ],
      branches: [
        { from: 'q', to: 'a' },
        { from: 'q', to: 'b' },
        { from: 'q', to: 'c' },
        { from: 'q', to: 'd' }
      ]
    })).toThrow(/at most 3 branches/);
    expect(() => parseHtmlStillTemplateData('system_diagram', {
      title: 'X',
      components: [{ id: 'a', label: 'A' }],
      links: [{ from: 'a', to: 'b' }]
    })).toThrow(/2-6 components/);
    expect(() => parseHtmlStillTemplateData('system_diagram', {
      title: 'X',
      components: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      links: [{ from: 'a', to: 'a' }]
    })).toThrow(/cannot connect a node to itself/);
    expect(() => parseHtmlStillTemplateData('system_diagram', {
      title: 'X',
      components: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      links: [{ from: 'a', to: 'missing' }]
    })).toThrow(/unknown component id/);
  });
});

describe('HTML still image assets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks template image slots without embedding URLs', () => {
    const headline = resolveHtmlStillTemplate('headline', { title: 'Live', imageAssetId: 'still-1' });
    expect(headline.markup).toContain('data-html-still-image="still-1"');
    expect(headline.markup).toContain('Still');
    expect(headline.markup).not.toMatch(/data:image\//);
    expect(headline.markup).not.toMatch(/https?:\/\//i);
    expect(() => wrapHtmlStillDocument({
      markup: headline.markup,
      css: headline.css,
      width: 1920,
      height: 1080,
      background: 'opaque'
    })).not.toThrow();

    const missing = resolveHtmlStillTemplate('product_card', { name: 'Hub' });
    expect(missing.markup).toContain('No image');
    expect(missing.markup).not.toContain('data-html-still-image');
  });

  it('injects only trusted server-built data URIs after sanitization', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const dataUri = `data:image/png;base64,${png.toString('base64')}`;
    const document = wrapHtmlStillDocument({
      markup: '<div class="image" data-html-still-image="still-1"><span>Still</span></div>',
      width: 1920,
      height: 1080,
      background: 'opaque'
    });
    const injected = injectTrustedHtmlStillImages(document, [{ assetId: 'still-1', mimeType: 'image/png', dataUri, sha256: 'abc' }]);
    expect(injected).toContain(`src="${dataUri}"`);
    expect(injected).not.toContain('<span>Still</span>');
    expect(() => injectTrustedHtmlStillImages(document, [{
      assetId: 'still-1',
      mimeType: 'image/png',
      dataUri: 'data:text/html;base64,PHNjcmlwdD4=',
      sha256: 'abc'
    }])).toThrow(/untrusted/i);
    expect(() => injectTrustedHtmlStillImages(document, [{
      assetId: 'still-1',
      mimeType: 'image/png',
      dataUri: 'https://example.com/x.png',
      sha256: 'abc'
    }])).toThrow(/untrusted/i);
  });

  it('resolves PNG, JPEG, and WebP bytes from assets/', async () => {
    const project = makeProject(makeHtmlScene({ kind: 'html', template: 'headline', templateData: { title: 'Live', imageAssetId: 'still-1' } }), [
      makeAsset('still-1')
    ]);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00ff00' } }).jpeg().toBuffer();
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0000ff' } }).webp().toBuffer();
    vi.spyOn(mediaStore, 'exists').mockResolvedValue(true);
    const read = vi.spyOn(mediaStore, 'readRelativeFile');
    read.mockResolvedValueOnce(png);
    const resolvedPng = await resolveHtmlStillImageAsset(project, 'still-1');
    expect(resolvedPng).toMatchObject({
      assetId: 'still-1',
      mimeType: 'image/png',
      sha256: createHash('sha256').update(png).digest('hex')
    });
    read.mockResolvedValueOnce(jpeg);
    await expect(resolveHtmlStillImageAsset(project, 'still-1')).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    read.mockResolvedValueOnce(webp);
    await expect(resolveHtmlStillImageAsset(project, 'still-1')).resolves.toMatchObject({ mimeType: 'image/webp' });
  });

  it('rejects missing, SVG, unsafe, and remote image assets', async () => {
    const pngProject = makeProject(makeHtmlScene({ kind: 'html', html: '<div>x</div>' }), [makeAsset('still-1')]);
    await expect(resolveHtmlStillImageAsset(makeProject(makeHtmlScene({ kind: 'html', html: '<div>x</div>' })), 'missing-1')).rejects.toMatchObject({ code: 'html.image.missing' });

    vi.spyOn(mediaStore, 'exists').mockResolvedValue(false);
    await expect(resolveHtmlStillImageAsset(pngProject, 'still-1')).rejects.toMatchObject({ code: 'html.image.missing' });
    vi.restoreAllMocks();

    vi.spyOn(mediaStore, 'exists').mockResolvedValue(true);
    vi.spyOn(mediaStore, 'readRelativeFile').mockResolvedValue(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
    await expect(resolveHtmlStillImageAsset(pngProject, 'still-1')).rejects.toMatchObject({ code: 'html.image.invalid' });
    vi.restoreAllMocks();

    await expect(resolveHtmlStillImageAsset(makeProject(makeHtmlScene({ kind: 'html', html: '<div>x</div>' }), [
      makeAsset('still-1', { localPath: 'assets/../secret.png' })
    ]), 'still-1')).rejects.toMatchObject({ code: 'html.image.unsafe' });
    await expect(resolveHtmlStillImageAsset(makeProject(makeHtmlScene({ kind: 'html', html: '<div>x</div>' }), [
      makeAsset('still-1', { localPath: 'file:///etc/passwd' })
    ]), 'still-1')).rejects.toMatchObject({ code: 'html.image.unsafe' });
    await expect(resolveHtmlStillImageAsset(makeProject(makeHtmlScene({ kind: 'html', html: '<div>x</div>' }), [
      makeAsset('still-1', { localPath: 'https://example.com/x.png' })
    ]), 'still-1')).rejects.toMatchObject({ code: 'html.image.unsafe' });
  });

  it('does not resolve images for custom HTML without a template', async () => {
    const images = await resolveHtmlStillImages(makeProject(makeHtmlScene({ kind: 'html', html: '<div>Custom</div>' })), {
      kind: 'html',
      html: '<div>Custom</div>'
    });
    expect(images).toEqual([]);
  });

  it('resolves only template-used assets', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const project = makeProject(makeHtmlScene({
      kind: 'html',
      template: 'product_card',
      templateData: { name: 'Hub', imageAssetId: 'product-1' }
    }), [makeAsset('product-1'), makeAsset('unused-1')]);
    vi.spyOn(mediaStore, 'exists').mockResolvedValue(true);
    const read = vi.spyOn(mediaStore, 'readRelativeFile').mockResolvedValue(png);
    const images = await resolveHtmlStillImages(project, project.scenes[0].visual as HtmlVisual);
    expect(images.map((image) => image.assetId)).toEqual(['product-1']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(project.id, 'assets/product-1.png');
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

  it('stays equal for the same used image bytes and changes when those bytes change', () => {
    const visual = {
      template: 'product_card' as const,
      templateData: { name: 'Hub', imageAssetId: 'product-1' },
      width: 1920,
      height: 1080,
      background: 'opaque' as const
    };
    const first = createHtmlStillFingerprint(visual, [{ assetId: 'product-1', sha256: 'aaa' }]);
    const same = createHtmlStillFingerprint(visual, [{ assetId: 'product-1', sha256: 'aaa' }]);
    const changed = createHtmlStillFingerprint(visual, [{ assetId: 'product-1', sha256: 'bbb' }]);
    expect(first).toBe(same);
    expect(first).not.toBe(changed);
    expect(htmlStillAssetIsCurrent({ kind: 'html', ...visual, assetId: 'still-png', fingerprint: first }, [
      { assetId: 'product-1', sha256: 'aaa' }
    ])).toBe(true);
    expect(htmlStillAssetIsCurrent({ kind: 'html', ...visual, assetId: 'still-png', fingerprint: first }, [
      { assetId: 'product-1', sha256: 'bbb' }
    ])).toBe(false);
  });

  it('changes when any used comparison image changes and ignores unused assets', () => {
    const visual = {
      template: 'product_comparison' as const,
      templateData: {
        title: 'Compare',
        products: [
          { name: 'Air', imageAssetId: 'air-1', features: [{ label: 'Weight', value: '1 kg' }] },
          { name: 'Pro', imageAssetId: 'pro-1', features: [{ label: 'Weight', value: '2 kg' }] }
        ]
      },
      width: 1920,
      height: 1080,
      background: 'opaque' as const
    };
    const used = [
      { assetId: 'pro-1', sha256: 'pro-a' },
      { assetId: 'air-1', sha256: 'air-a' }
    ];
    const first = createHtmlStillFingerprint(visual, used);
    const reordered = createHtmlStillFingerprint(visual, used.slice().reverse());
    const airChanged = createHtmlStillFingerprint(visual, [
      { assetId: 'air-1', sha256: 'air-b' },
      { assetId: 'pro-1', sha256: 'pro-a' }
    ]);
    const unused = createHtmlStillFingerprint(visual, [...used, { assetId: 'unused-1', sha256: 'zzz' }]);
    expect(first).toBe(reordered);
    expect(first).toBe(unused);
    expect(first).not.toBe(airChanged);
    expect(createHtmlStillFingerprint(visual)).not.toBe(first);
    expect(htmlStillAssetIsCurrent({ kind: 'html', ...visual, assetId: 'still-png', fingerprint: first })).toBe(false);
  });
});

describe('HTML still Chromium PNG', () => {
  it('renders an opaque 1920x1080 PNG', async () => {
    const still = await renderHtmlStillPng({
      markup: '<div style="width:100%;height:100%;background:#0056a7;color:#fff;font-size:80px;display:flex;align-items:center;justify-content:center;">Headline</div>',
      width: 1920,
      height: 1080,
      background: 'opaque',
      pageBackground: '#0056a7',
      timeoutMs: 45_000
    });
    expect(still.png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    const info = await sharp(still.png).metadata();
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(info.format).toBe('png');
  }, 60_000);

  it('renders a transparent background PNG', async () => {
    const still = await renderHtmlStillPng({
      markup: '<div style="width:400px;height:200px;background:#ff5a5f;"></div>',
      width: 640,
      height: 360,
      background: 'transparent',
      timeoutMs: 45_000
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
  }, 60_000);

  it('rejects an invalid viewport instead of rendering a partial PNG', async () => {
    await expect(renderHtmlStillPng({
      markup: '<div>x</div>',
      width: 10,
      height: 10,
      background: 'opaque'
    })).rejects.toMatchObject({ code: 'html.invalid' });
  });

  it('paints trusted PNG, JPEG, and WebP pixels into the Chromium PNG', async () => {
    async function renderColor(mime: 'png' | 'jpeg' | 'webp', color: string) {
      const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: color } })[mime]().toBuffer();
      const mimeType = mime === 'png' ? 'image/png' : mime === 'jpeg' ? 'image/jpeg' : 'image/webp';
      return renderHtmlStillPng({
        markup: '<div class="image" data-html-still-image="still-1" style="width:100%;height:100%;"></div>',
        width: 320,
        height: 180,
        background: 'opaque',
        pageBackground: '#000000',
        timeoutMs: 45_000,
        images: [{ assetId: 'still-1', mimeType, dataUri: `data:${mimeType};base64,${bytes.toString('base64')}`, sha256: 'abc' }]
      });
    }

    function countNear(png: Buffer, rgb: [number, number, number]): Promise<number> {
      return sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true }).then(({ data }) => {
        let count = 0;
        for (let i = 0; i < data.length; i += 3) {
          if (Math.abs(data[i] - rgb[0]) <= 48 && Math.abs(data[i + 1] - rgb[1]) <= 48 && Math.abs(data[i + 2] - rgb[2]) <= 48) {
            count += 1;
          }
        }
        return count;
      });
    }

    const png = await renderColor('png', '#ff0000');
    const jpeg = await renderColor('jpeg', '#00ff00');
    const webp = await renderColor('webp', '#0000ff');
    expect(await countNear(png.png, [255, 0, 0])).toBeGreaterThan(200);
    expect(await countNear(jpeg.png, [0, 255, 0])).toBeGreaterThan(200);
    expect(await countNear(webp.png, [0, 0, 255])).toBeGreaterThan(200);
  }, 90_000);

  it('keeps the placeholder when no imageAssetId is set', async () => {
    const card = resolveHtmlStillTemplate('product_card', { name: 'Hub' });
    const still = await renderHtmlStillPng({
      markup: card.markup,
      css: card.css,
      width: 640,
      height: 360,
      background: 'opaque',
      pageBackground: card.background,
      timeoutMs: 45_000
    });
    expect(card.markup).toContain('No image');
    expect(card.markup).not.toContain('data-html-still-image');
    expect(still.png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  }, 45_000);
});

describe('HTML still project validation and resolver', () => {
  it('requires a template or markup', () => {
    const project = makeProject(makeHtmlScene({ kind: 'html' }));
    const result = validateProject(project);
    expect(result.errors.some((issue) => issue.code === 'scene.visual.html.source.required')).toBe(true);
  });

  it('rejects unknown templates and missing typed fields', () => {
    const unknown = validateProject(makeProject(makeHtmlScene({ kind: 'html', template: 'billboard' as never })));
    expect(unknown.errors.some((issue) => issue.code === 'scene.visual.html.template.unknown')).toBe(true);

    const missing = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'headline',
      templateData: { subtitle: 'No title' }
    })));
    expect(missing.errors.some((issue) => issue.code === 'html.template.data.invalid')).toBe(true);

    const emptyChart = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'chart',
      templateData: { title: 'ARR', kind: 'bar', points: [] }
    })));
    expect(emptyChart.errors.some((issue) => issue.code === 'html.template.data.invalid')).toBe(true);

    const badRoute = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'route_map',
      templateData: { title: 'Hop', locations: [{ id: 'a', label: 'A' }], links: [] }
    })));
    expect(badRoute.errors.some((issue) => issue.code === 'html.template.data.invalid')).toBe(true);
  });

  it('accepts typed chart and timeline scenes', () => {
    const chart = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'chart',
      templateData: { title: 'ARR', kind: 'bar', points: [{ label: 'Q1', value: 12 }] }
    })));
    expect(chart.errors).toEqual([]);
    const timeline = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'timeline',
      templateData: { title: 'Roadmap', events: [{ label: 'Kickoff', detail: 'Go' }] }
    })));
    expect(timeline.errors).toEqual([]);
    const location = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'location_card',
      templateData: { place: 'Helsinki', region: 'Finland' }
    })));
    expect(location.errors).toEqual([]);
    const route = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'route_map',
      templateData: {
        title: 'Hop',
        locations: [{ id: 'hel', label: 'Helsinki' }, { id: 'sto', label: 'Stockholm' }],
        links: [{ from: 'hel', to: 'sto' }]
      }
    })));
    expect(route.errors).toEqual([]);
    const product = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'product_card',
      templateData: { name: 'Hub', features: [{ label: 'Weight', value: '1 kg' }] }
    })));
    expect(product.errors).toEqual([]);
    const comparison = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'product_comparison',
      templateData: {
        title: 'Compare',
        products: [
          { name: 'Air', features: [{ label: 'Weight', value: '1 kg' }] },
          { name: 'Pro', features: [{ label: 'Weight', value: '2 kg' }] }
        ]
      }
    })));
    expect(comparison.errors).toEqual([]);
    const callouts = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'feature_callouts',
      templateData: { name: 'Hub', callouts: [{ label: 'Lens', detail: 'Wide' }] }
    })));
    expect(callouts.errors).toEqual([]);
    const flow = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'flow_diagram',
      templateData: {
        title: 'Flow',
        steps: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        links: [{ from: 'a', to: 'b' }]
      }
    })));
    expect(flow.errors).toEqual([]);
    const decision = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'decision_tree',
      templateData: {
        title: 'Tree',
        nodes: [
          { id: 'q', kind: 'question', label: 'Q' },
          { id: 'yes', kind: 'outcome', label: 'Yes' }
        ],
        branches: [{ from: 'q', to: 'yes', label: 'Ja' }]
      }
    })));
    expect(decision.errors).toEqual([]);
    const system = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'system_diagram',
      templateData: {
        title: 'Stack',
        components: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        links: [{ from: 'a', to: 'b' }]
      }
    })));
    expect(system.errors).toEqual([]);
  });

  it('rejects missing local image assets on product templates', () => {
    const missing = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'product_card',
      templateData: { name: 'Hub', imageAssetId: 'missing-image' }
    })));
    expect(missing.errors.some((issue) => issue.code === 'scene.visual.html.imageAsset.missing')).toBe(true);

    const present = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'product_card',
      templateData: { name: 'Hub', imageAssetId: 'product-1' }
    }), [makeAsset('product-1')]));
    expect(present.errors).toEqual([]);

    const comparisonMissing = validateProject(makeProject(makeHtmlScene({
      kind: 'html',
      template: 'product_comparison',
      templateData: {
        title: 'Compare',
        products: [
          { name: 'Air', imageAssetId: 'air-1', features: [{ label: 'Weight', value: '1 kg' }] },
          { name: 'Pro', features: [{ label: 'Weight', value: '2 kg' }] }
        ]
      }
    })));
    expect(comparisonMissing.errors.some((issue) => issue.code === 'scene.visual.html.imageAsset.missing')).toBe(true);
  });

  it('keeps a custom HTML still without a template valid', () => {
    const project = makeProject(makeHtmlScene({
      kind: 'html',
      html: '<div>Custom still</div>',
      css: '.card{color:#fff}'
    }));
    const result = validateProject(project);
    expect(result.errors.some((issue) => issue.path.includes('visual'))).toBe(false);
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

  it('reuses a current PNG when used image bytes are unchanged', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const sha256 = createHash('sha256').update(png).digest('hex');
    const visual: HtmlVisual = {
      kind: 'html',
      template: 'headline_card',
      templateData: { title: 'Live', imageAssetId: 'still-1' },
      width: 1920,
      height: 1080,
      background: 'opaque',
      assetId: 'html-1',
      fingerprint: ''
    };
    visual.fingerprint = createHtmlStillFingerprint(visual, [{ assetId: 'still-1', sha256 }]);
    const project = makeProject(makeHtmlScene(visual), [makeAsset('html-1'), makeAsset('still-1')]);
    vi.spyOn(projectStore, 'getProject').mockResolvedValue(project);
    vi.spyOn(mediaStore, 'exists').mockResolvedValue(true);
    vi.spyOn(mediaStore, 'readRelativeFile').mockImplementation(async (_projectId, localPath) => {
      if (localPath === 'assets/still-1.png') {
        return png;
      }
      throw new Error(`unexpected path ${localPath}`);
    });
    const save = vi.spyOn(mediaStore, 'saveAsset');

    const result = await htmlStillService.renderSceneHtmlStill(project.id, 'scene-html');
    expect(result.reused).toBe(true);
    expect(result.fingerprint).toBe(visual.fingerprint);
    expect(save).not.toHaveBeenCalled();
  });

  it('does not reuse when used image bytes change', async () => {
    const original = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const changed = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00ff00' } }).png().toBuffer();
    const visual: HtmlVisual = {
      kind: 'html',
      template: 'headline_card',
      templateData: { title: 'Live', imageAssetId: 'still-1' },
      width: 1920,
      height: 1080,
      background: 'opaque',
      assetId: 'html-1',
      fingerprint: createHtmlStillFingerprint(
        {
          template: 'headline_card',
          templateData: { title: 'Live', imageAssetId: 'still-1' },
          width: 1920,
          height: 1080,
          background: 'opaque'
        },
        [{ assetId: 'still-1', sha256: createHash('sha256').update(original).digest('hex') }]
      )
    };
    const project = makeProject(makeHtmlScene(visual), [makeAsset('html-1'), makeAsset('still-1')]);
    vi.spyOn(projectStore, 'getProject').mockResolvedValue(project);
    vi.spyOn(mediaStore, 'exists').mockResolvedValue(true);
    vi.spyOn(mediaStore, 'readRelativeFile').mockResolvedValue(changed);
    vi.spyOn(chromiumStill, 'renderHtmlStillPng').mockResolvedValue({
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      width: 1920,
      height: 1080,
      background: 'opaque'
    });
    vi.spyOn(mediaStore, 'saveAsset').mockResolvedValue({
      asset: makeAsset('html-new', { localPath: 'assets/html-new.png', width: 1920, height: 1080 })
    });
    vi.spyOn(projectStore, 'mutateProject').mockImplementation(async (_id, mutator) => mutator(structuredClone(project)));

    const result = await htmlStillService.renderSceneHtmlStill(project.id, 'scene-html');
    expect(result.reused).toBe(false);
    expect(result.assetId).toBe('html-new');
    expect(result.fingerprint).not.toBe(visual.fingerprint);
    expect(result.fingerprint).toContain(createHash('sha256').update(changed).digest('hex'));
  });

  it('fails closed when a referenced image asset is missing', async () => {
    const project = makeProject(makeHtmlScene({
      kind: 'html',
      template: 'product_card',
      templateData: { name: 'Hub', imageAssetId: 'missing-image' }
    }));
    vi.spyOn(projectStore, 'getProject').mockResolvedValue(project);
    await expect(htmlStillService.renderSceneHtmlStill(project.id, 'scene-html')).rejects.toMatchObject({
      code: 'html.image.missing'
    });
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
