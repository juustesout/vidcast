import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ProgramBar } from '@/components/project/program-bar';
import { SceneLint } from '@/components/project/scene-lint';
import { WorkspaceTopbar } from '@/components/project/workspace-topbar';
import { buildWorkspaceTimeline } from '@/lib/workspace/timeline';

vi.mock('next/image', () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => React.createElement('img', props)
}));

describe('WorkspaceTopbar', () => {
  it('shows Saved only for a successful snapshot and Unsaved after edits', () => {
    const saved = renderToStaticMarkup(
      React.createElement(WorkspaceTopbar, { title: 'Northwind', saveStatus: 'saved', onSave: () => {} })
    );
    const unsaved = renderToStaticMarkup(
      React.createElement(WorkspaceTopbar, {
        title: 'Northwind',
        saveStatus: 'unsaved',
        saveError: 'Could not save project.',
        onSave: () => {}
      })
    );

    expect(saved).toContain('data-save-status="saved"');
    expect(saved).toContain('Saved');
    expect(saved).not.toContain('Unsaved');
    expect(unsaved).toContain('data-save-status="unsaved"');
    expect(unsaved).toContain('Unsaved');
    expect(unsaved).toContain('Could not save project.');
  });
});

describe('SceneLint', () => {
  const items = [1, 2, 3, 4, 5].map((order) => ({
    sceneId: `scene-${order}`,
    order,
    type: 'image',
    durationLabel: `${order}.0s`,
    statusLabel: 'Not rendered',
    selected: order === 5,
    placeholder: 'image'
  }));

  it('marks the selected scene and keeps previous/next available inside the range', () => {
    const html = renderToStaticMarkup(
      React.createElement(SceneLint, {
        items,
        onSelect: () => {},
        onPrevious: () => {},
        onNext: () => {},
        canGoPrevious: true,
        canGoNext: false
      })
    );

    expect(html).toContain('Previous scene');
    expect(html).toContain('Next scene');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('Scene 05');
    expect(html).toContain('disabled=""');
  });

  it('uses a horizontally scrolling row so more than four scenes can overflow', () => {
    const html = renderToStaticMarkup(
      React.createElement(SceneLint, {
        items,
        onSelect: () => {},
        onPrevious: () => {},
        onNext: () => {},
        canGoPrevious: true,
        canGoNext: false
      })
    );

    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('min-w-[180px]');
    expect(html).toContain('shrink-0');
    expect(html).toContain('Scene 01');
    expect(html).toContain('Scene 05');
  });
});

describe('ProgramBar', () => {
  const timeline = buildWorkspaceTimeline({
    scenes: [
      { sceneId: 'intro', order: 1, duration: 3 },
      { sceneId: 'news', order: 2, duration: 6 },
      { sceneId: 'outro', order: 3, duration: 3 }
    ]
  });

  it('stays usable when the final render is missing', () => {
    const html = renderToStaticMarkup(
      React.createElement(ProgramBar, {
        timeline,
        selectedSceneId: 'intro',
        compositionStatus: 'missing',
        onSeek: () => {}
      })
    );

    expect(html).toContain('data-composition-status="missing"');
    expect(html).toContain('Final render missing');
    expect(html).toContain('aria-label="Program timeline"');
    expect(html).toContain('Plan bar navigates scenes only');
    expect(html).toContain('12.0s');
  });

  it('does not claim a stale final MP4 is current', () => {
    const html = renderToStaticMarkup(
      React.createElement(ProgramBar, {
        timeline,
        selectedSceneId: 'news',
        compositionStatus: 'stale',
        compositionReason: 'Scene 2 changed after its latest render.',
        onSeek: () => {}
      })
    );

    expect(html).toContain('data-composition-status="stale"');
    expect(html).toContain('Final render stale');
    expect(html).toContain('Scene 2 changed after its latest render.');
    expect(html).not.toContain('Final render current');
  });

  it('labels a current final render without changing scene navigation', () => {
    const html = renderToStaticMarkup(
      React.createElement(ProgramBar, {
        timeline,
        selectedSceneId: 'outro',
        compositionStatus: 'current',
        onSeek: () => {}
      })
    );

    expect(html).toContain('data-composition-status="current"');
    expect(html).toContain('Final render current');
    expect(html).toContain('data-scene-id="outro"');
  });
});
