import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSceneRenderFingerprint } from '@/lib/render/render-fingerprint';
import {
  buildAlphaExpression,
  buildDrawtextFilter,
  buildSceneOverlayFilter,
  escapeDrawtextValue,
  hasRenderableTextOverlay,
  OVERLAY_TEXT_FILENAME,
  resolveTextOverlay
} from '@/lib/render/text-overlay';
import type { OverlaySpec } from '@/lib/types/scene';
import type { RenderPlan, RenderPlanScene } from '@/lib/types/render';

const GEOMETRY = { width: 1280, height: 720, duration: 4 };

function scene(overlay: OverlaySpec, kind: RenderPlanScene['source']['kind'] = 'image'): RenderPlanScene {
  return {
    sceneId: 'scene-1',
    order: 1,
    duration: GEOMETRY.duration,
    status: 'renderable',
    source: kind === 'image' ? { kind, assetPath: '/tmp/does-not-matter.png', assetType: 'image' } : { kind },
    motion: { preset: 'none' },
    transition: { type: 'none' },
    overlay,
    referenceIds: [],
    issues: []
  };
}

function plan(overlay: OverlaySpec): RenderPlan {
  return {
    projectId: 'project-overlay',
    title: 'Overlay',
    aspectRatio: '16:9',
    fps: 30,
    width: GEOMETRY.width,
    height: GEOMETRY.height,
    background: { type: 'color', value: '#020617' },
    ready: true,
    narration: { text: '', segments: [] },
    issues: [],
    scenes: [scene(overlay)]
  };
}

describe('escapeDrawtextValue', () => {
  it('escapes filter graph separators and special characters', () => {
    expect(escapeDrawtextValue("a:b,c'd\\e[f]g;h%i j")).toBe("a\\:b\\,c\\'d\\\\e\\[f\\]g\\;h\\%i\\ j");
  });

  it('escapes backslashes before other replacements to avoid double processing', () => {
    expect(escapeDrawtextValue('\\:')).toBe('\\\\\\:');
  });

  it('leaves plain font names usable', () => {
    expect(escapeDrawtextValue('DejaVu Sans')).toBe('DejaVu\\ Sans');
  });
});

describe('hasRenderableTextOverlay', () => {
  it('rejects none, missing and blank-text overlays', () => {
    expect(hasRenderableTextOverlay(undefined)).toBe(false);
    expect(hasRenderableTextOverlay({ type: 'none' })).toBe(false);
    expect(hasRenderableTextOverlay({ type: 'text', text: '' })).toBe(false);
    expect(hasRenderableTextOverlay({ type: 'text', text: '   \n ' })).toBe(false);
  });

  it('accepts overlays with non-blank text', () => {
    expect(hasRenderableTextOverlay({ type: 'title', text: 'Hello' })).toBe(true);
  });
});

describe('resolveTextOverlay', () => {
  it('returns null for a non-renderable overlay', () => {
    expect(resolveTextOverlay({ type: 'none' }, GEOMETRY)).toBeNull();
    expect(resolveTextOverlay({ type: 'text', text: '  ' }, GEOMETRY)).toBeNull();
  });

  it('trims the copy and derives defaults from geometry and type', () => {
    const resolved = resolveTextOverlay({ type: 'text', text: '  hello  ' }, GEOMETRY);
    expect(resolved).not.toBeNull();
    expect(resolved!.text).toBe('hello');
    expect(resolved!.position).toBe('bottom');
    expect(resolved!.box).toBe(false);
    expect(resolved!.fontSize).toBe(Math.round(1280 * 0.04));
    expect(resolved!.fadeInSeconds).toBe(0.4);
    expect(resolved!.fadeOutSeconds).toBe(0);
    expect(resolved!.duration).toBe(4);
  });

  it('maps default positions per overlay type', () => {
    expect(resolveTextOverlay({ type: 'title', text: 'T' }, GEOMETRY)!.position).toBe('top');
    expect(resolveTextOverlay({ type: 'statistic', text: '42%' }, GEOMETRY)!.position).toBe('center');
    expect(resolveTextOverlay({ type: 'quote', text: 'q' }, GEOMETRY)!.position).toBe('center');
    expect(resolveTextOverlay({ type: 'callout', text: 'c' }, GEOMETRY)!.position).toBe('bottom');
  });

  it('honors explicit position and style overrides', () => {
    const resolved = resolveTextOverlay(
      { type: 'title', text: 'T', position: 'center', style: { fontSize: 80, color: '#abcdef', box: false, margin: 100 }, timing: { fadeInSeconds: 1, fadeOutSeconds: 0.5 } },
      GEOMETRY
    )!;
    expect(resolved.position).toBe('center');
    expect(resolved.fontSize).toBe(80);
    expect(resolved.fontColor).toBe('0xabcdef');
    expect(resolved.box).toBe(false);
    expect(resolved.margin).toBe(100);
    expect(resolved.fadeInSeconds).toBe(1);
    expect(resolved.fadeOutSeconds).toBe(0.5);
  });

  it('normalizes colors and falls back on invalid values', () => {
    expect(resolveTextOverlay({ type: 'text', text: 'x', style: { color: '#fff' } }, GEOMETRY)!.fontColor).toBe('0xffffff');
    expect(resolveTextOverlay({ type: 'text', text: 'x', style: { color: 'white' } }, GEOMETRY)!.fontColor).toBe('white');
    expect(resolveTextOverlay({ type: 'text', text: 'x', style: { color: 'not a color' } }, GEOMETRY)!.fontColor).toBe('0xf8fafc');
  });

  it('clamps fade timing to the scene duration', () => {
    const resolved = resolveTextOverlay({ type: 'text', text: 'x', timing: { fadeInSeconds: 99, fadeOutSeconds: 99 } }, GEOMETRY)!;
    expect(resolved.fadeInSeconds).toBe(4);
    expect(resolved.fadeOutSeconds).toBe(4);
  });

  it('ignores invalid style values and keeps type defaults', () => {
    const resolved = resolveTextOverlay(
      { type: 'title', text: 'x', style: { fontSize: -10, margin: Number.NaN, box: 'yes' as unknown as boolean, color: 123 as unknown as string } },
      GEOMETRY
    )!;
    expect(resolved.fontSize).toBe(Math.round(1280 * 0.055));
    expect(resolved.margin).toBe(Math.round(720 * 0.08));
    expect(resolved.box).toBe(true);
    expect(resolved.fontColor).toBe('0xf8fafc');
  });

  it('keeps overlays static when no fade fits a zero-length scene', () => {
    const resolved = resolveTextOverlay({ type: 'text', text: 'x' }, { width: 640, height: 360, duration: 0 })!;
    expect(resolved.fadeInSeconds).toBe(0);
    expect(buildAlphaExpression(resolved.fadeInSeconds, resolved.fadeOutSeconds, resolved.duration)).toBeUndefined();
  });
});

describe('buildAlphaExpression', () => {
  it('returns undefined when no fade is configured', () => {
    expect(buildAlphaExpression(0, 0, 4)).toBeUndefined();
  });

  it('builds a fade-in only expression', () => {
    expect(buildAlphaExpression(0.5, 0, 4)).toBe('if(lt(t,0.500),t/0.500,1)');
  });

  it('builds a fade-out only expression', () => {
    expect(buildAlphaExpression(0, 0.5, 4)).toBe('if(gt(t,3.500),(4.000-t)/0.500,1)');
  });

  it('builds a combined fade expression', () => {
    expect(buildAlphaExpression(0.5, 0.5, 4)).toBe('if(lt(t,0.500),t/0.500,if(gt(t,3.500),(4.000-t)/0.500,1))');
  });
});

describe('buildDrawtextFilter', () => {
  it('uses textfile, escapes the font and includes expansion=none', () => {
    const resolved = resolveTextOverlay({ type: 'text', text: 'hello' }, GEOMETRY)!;
    const filter = buildDrawtextFilter(resolved, OVERLAY_TEXT_FILENAME);
    expect(filter.startsWith('drawtext=')).toBe(true);
    expect(filter).toContain('font=DejaVu\\ Sans');
    expect(filter).toContain(`textfile=${OVERLAY_TEXT_FILENAME}`);
    expect(filter).toContain('expansion=none');
    expect(filter).toContain('x=(w-text_w)/2');
    expect(filter).toContain('y=h-text_h-');
    expect(filter).toContain('alpha=');
  });

  it('adds a box only when configured', () => {
    const plain = resolveTextOverlay({ type: 'text', text: 'hello' }, GEOMETRY)!;
    const boxed = resolveTextOverlay({ type: 'title', text: 'hello' }, GEOMETRY)!;
    expect(buildDrawtextFilter(plain, OVERLAY_TEXT_FILENAME)).not.toContain('box=1');
    expect(buildDrawtextFilter(boxed, OVERLAY_TEXT_FILENAME)).toContain('box=1');
  });
});

describe('buildSceneOverlayFilter', () => {
  it('writes the exact text to a UTF-8 file and references only the basename', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-filter-'));
    const text = "50% growth: \"fast\", back\\slash 'quoted' [x] & <y>\nsecond line";
    const filter = await buildSceneOverlayFilter(scene({ type: 'text', text }), { ...GEOMETRY, tempDir });

    expect(filter).toBeDefined();
    expect(filter).toContain(`textfile=${OVERLAY_TEXT_FILENAME}`);
    expect(filter).not.toContain('50%');
    expect(filter).not.toContain('growth');

    const written = await fs.readFile(path.join(tempDir, OVERLAY_TEXT_FILENAME), 'utf8');
    expect(written).toBe(text);
  });

  it('returns undefined when there is nothing to draw', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-filter-empty-'));
    expect(await buildSceneOverlayFilter(scene({ type: 'none' }), { ...GEOMETRY, tempDir })).toBeUndefined();
    expect(await buildSceneOverlayFilter(scene({ type: 'text', text: '   ' }), { ...GEOMETRY, tempDir })).toBeUndefined();
  });

  it('skips text scenes so authored copy is not duplicated', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-filter-text-'));
    const filter = await buildSceneOverlayFilter(scene({ type: 'text', text: 'hello' }, 'text'), { ...GEOMETRY, tempDir });
    expect(filter).toBeUndefined();
  });
});

describe('overlay fingerprint', () => {
  it('is stable for identical overlay settings', () => {
    const a = createSceneRenderFingerprint(plan({ type: 'title', text: 'Same', position: 'top', style: { fontSize: 60 }, timing: { fadeInSeconds: 0.5 } }), scene({ type: 'title', text: 'Same', position: 'top', style: { fontSize: 60 }, timing: { fadeInSeconds: 0.5 } }));
    const b = createSceneRenderFingerprint(plan({ type: 'title', text: 'Same', position: 'top', style: { fontSize: 60 }, timing: { fadeInSeconds: 0.5 } }), scene({ type: 'title', text: 'Same', position: 'top', style: { fontSize: 60 }, timing: { fadeInSeconds: 0.5 } }));
    expect(a).toBe(b);
  });

  it('changes when text, position, style or timing changes', () => {
    const base = createSceneRenderFingerprint(plan({ type: 'title', text: 'A', position: 'top' }), scene({ type: 'title', text: 'A', position: 'top' }));
    const text = createSceneRenderFingerprint(plan({ type: 'title', text: 'B', position: 'top' }), scene({ type: 'title', text: 'B', position: 'top' }));
    const position = createSceneRenderFingerprint(plan({ type: 'title', text: 'A', position: 'bottom' }), scene({ type: 'title', text: 'A', position: 'bottom' }));
    const style = createSceneRenderFingerprint(plan({ type: 'title', text: 'A', position: 'top', style: { color: '#ff0000' } }), scene({ type: 'title', text: 'A', position: 'top', style: { color: '#ff0000' } }));
    const timing = createSceneRenderFingerprint(plan({ type: 'title', text: 'A', position: 'top', timing: { fadeInSeconds: 1 } }), scene({ type: 'title', text: 'A', position: 'top', timing: { fadeInSeconds: 1 } }));

    expect(new Set([base, text, position, style, timing]).size).toBe(5);
  });
});
