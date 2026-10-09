import { describe, expect, it } from 'vitest';

import { validateRenderPlan } from '@/lib/render/render-plan-validator';
import type { RenderPlan } from '@/lib/types/render';

function createRenderPlan(overrides: Partial<RenderPlan> = {}): RenderPlan {
  return {
    projectId: 'project-1',
    title: 'Render Plan Test',
    aspectRatio: '16:9',
    fps: 30,
    width: 1920,
    height: 1080,
    background: { type: 'color', value: '#020617' },
    ready: true,
    scenes: [
      {
        sceneId: 'scene-1',
        order: 1,
        duration: 2,
        status: 'renderable',
        source: { kind: 'blank' },
        motion: { preset: 'none' },
        transition: { type: 'none' },
        referenceIds: [],
        issues: []
      }
    ],
    narration: { text: '', segments: [] },
    issues: [],
    ...overrides
  };
}

describe('render plan validator', () => {
  it('accepts a single renderable scene', () => {
    const result = validateRenderPlan(createRenderPlan());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects multi-scene plans for the P5 renderer boundary', () => {
    const result = validateRenderPlan(
      createRenderPlan({
        scenes: [
          {
            sceneId: 'scene-1',
            order: 1,
            duration: 2,
            status: 'renderable',
            source: { kind: 'blank' },
            motion: { preset: 'none' },
            transition: { type: 'none' },
            referenceIds: [],
            issues: []
          },
          {
            sceneId: 'scene-2',
            order: 2,
            duration: 2,
            status: 'renderable',
            source: { kind: 'blank' },
            motion: { preset: 'none' },
            transition: { type: 'none' },
            referenceIds: [],
            issues: []
          }
        ]
      })
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((issue) => issue.code === 'render.plan.sceneCount.invalid')).toBe(true);
  });
});
