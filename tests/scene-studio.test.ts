import { describe, expect, it } from 'vitest';

import {
  createStudioOverlaySvg,
  DEFAULT_STUDIO_ACCENT,
  DEFAULT_STUDIO_BRAND,
  DEFAULT_STUDIO_PROGRAM,
  resolveStudioOverlay
} from '@/lib/render/studio-overlay';

describe('studio overlay geometry', () => {
  it('resolves normalized defaults into canvas pixels', () => {
    const studio = resolveStudioOverlay({}, 1920, 1080);

    expect(studio).toMatchObject({
      brand: DEFAULT_STUDIO_BRAND,
      program: DEFAULT_STUDIO_PROGRAM,
      accentColor: DEFAULT_STUDIO_ACCENT,
      screen: {
        x: 96,
        y: 97,
        width: 1306,
        height: 756
      }
    });
  });

  it('keeps the screen inside the canvas when offsets are out of range', () => {
    const studio = resolveStudioOverlay(
      {
        screen: { x: 0.9, y: 0.9, width: 0.8, height: 0.8, radius: 10_000 }
      },
      640,
      360
    );

    expect(studio?.screen.x).toBe(576);
    expect(studio?.screen.y).toBe(324);
    expect(studio?.screen.width).toBe(64);
    expect(studio?.screen.height).toBe(36);
    expect(studio?.screen.radius).toBeLessThanOrEqual(9);
  });

  it('falls back to defaults for unusable brand values and colors', () => {
    const studio = resolveStudioOverlay(
      {
        brand: '   ',
        program: 'A'.repeat(80),
        accentColor: 'red',
        screen: { width: 0.01, height: 0.01 }
      },
      1280,
      720
    );

    expect(studio?.brand).toBe(DEFAULT_STUDIO_BRAND);
    expect(studio?.program).toHaveLength(24);
    expect(studio?.accentColor).toBe(DEFAULT_STUDIO_ACCENT);
    expect(studio?.screen.width).toBe(128);
    expect(studio?.screen.height).toBe(72);
  });

  it('returns undefined when no studio is configured', () => {
    expect(resolveStudioOverlay(undefined, 1920, 1080)).toBeUndefined();
  });
});

describe('studio overlay SVG', () => {
  it('cuts the content screen out of an opaque studio frame', () => {
    const studio = resolveStudioOverlay({}, 640, 360);
    const svg = createStudioOverlaySvg(studio!, 640, 360);

    expect(svg).toContain('<mask id="studio-screen-cut"');
    expect(svg).toContain('fill="#000000"');
    expect(svg).toContain('fill="url(#studio-bg)"');
    expect(svg).toContain('AI DEV FORUM');
    expect(svg).toContain('width="640" height="360"');
  });

  it('escapes brand text and uses the configured accent', () => {
    const studio = resolveStudioOverlay(
      { brand: 'A&B <News>', program: 'LIVE', accentColor: '#0056a7' },
      640,
      360
    );
    const svg = createStudioOverlaySvg(studio!, 640, 360);

    expect(svg).toContain('A&amp;B &lt;News&gt;');
    expect(svg).toContain('#0056a7');
    expect(svg).not.toContain('A&B <News>');
  });
});
