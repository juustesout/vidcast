import { describe, expect, it } from 'vitest';

import { listAnimationTemplateSummaries } from '@/lib/animation/catalog';
import { AnimationError } from '@/lib/animation/errors';
import {
  validateAnimationAttachInput,
  validateAnimationParams,
  validateAnimationRenderInput
} from '@/lib/animation/validate';

describe('animation catalog', () => {
  it('exposes only the two existing Motion Canvas templates', () => {
    const summaries = listAnimationTemplateSummaries();
    expect(summaries.map((entry) => entry.id)).toEqual(['northwind_arr_chart', 'nix_overlay']);
    expect(summaries[0].destination).toBe('bigscreen');
    expect(summaries[0].output).toMatchObject({ container: 'mp4', codec: 'h264', pixFmt: 'yuv420p', alpha: false });
    expect(summaries[1].destination).toBe('overlay');
    expect(summaries[1].output).toMatchObject({ container: 'webm', codec: 'vp9', pixFmt: 'yuva420p', alpha: true });
  });
});

describe('animation param validation', () => {
  it('merges Northwind chart defaults', () => {
    const params = validateAnimationParams('northwind_arr_chart', undefined);
    expect(params).toMatchObject({
      title: 'Northwind ARR',
      labels: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'],
      values: [24, 41, 63, 88, 76],
      background: '#0f172a'
    });
  });

  it('rejects unknown template ids', () => {
    expect(() => validateAnimationRenderInput({
      projectId: 'project-1',
      templateId: 'invented_chart'
    })).toThrow(AnimationError);
    try {
      validateAnimationRenderInput({ projectId: 'project-1', templateId: 'invented_chart' });
    } catch (error) {
      expect(error).toBeInstanceOf(AnimationError);
      expect((error as AnimationError).code).toBe('animation.template.notFound');
    }
  });

  it('rejects unknown param keys and mismatched series lengths', () => {
    expect(() => validateAnimationParams('northwind_arr_chart', { eval: '1+1' })).toThrow(AnimationError);
    expect(() => validateAnimationParams('northwind_arr_chart', {
      labels: ['Q1', 'Q2'],
      values: [1, 2, 3],
      colors: ['#fff', '#000']
    })).toThrow(/same length/);
  });

  it('rejects unsafe text and invalid colors', () => {
    expect(() => validateAnimationParams('northwind_arr_chart', { title: '<script>' })).toThrow(AnimationError);
    expect(() => validateAnimationParams('nix_overlay', { badgeColor: 'red' })).toThrow(AnimationError);
    expect(() => validateAnimationParams('nix_overlay', { badge: 'NIX\nOS' })).toThrow(AnimationError);
  });

  it('accepts overlay color overrides', () => {
    const params = validateAnimationParams('nix_overlay', { badge: 'BOT', headColor: '#22d3ee' });
    expect(params).toMatchObject({ badge: 'BOT', headColor: '#22d3ee', bodyColor: '#0e7490' });
  });
});

describe('animation attach validation', () => {
  it('rejects unknown fields and unsafe destinations', () => {
    expect(() => validateAnimationAttachInput({
      projectId: 'p',
      sceneId: 's',
      assetId: 'a',
      destination: 'bigscreen',
      extra: true
    })).toThrow(AnimationError);
    expect(() => validateAnimationAttachInput({
      projectId: 'p',
      sceneId: 's',
      assetId: 'a',
      destination: 'foreground'
    })).toThrow(AnimationError);
  });

  it('accepts timed overlay placement', () => {
    const parsed = validateAnimationAttachInput({
      projectId: 'project-1',
      sceneId: 'scene-1',
      assetId: 'asset-1',
      destination: 'overlay',
      startSeconds: 0.2,
      durationSeconds: 4,
      scale: 1
    });
    expect(parsed.destination).toBe('overlay');
    expect(parsed.startSeconds).toBe(0.2);
    expect(parsed.durationSeconds).toBe(4);
  });
});
