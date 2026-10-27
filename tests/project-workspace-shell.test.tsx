import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('ProjectWorkspace shell wiring', () => {
  function source(): string {
    return fs.readFileSync(path.join(process.cwd(), 'components/project/project-workspace.tsx'), 'utf8');
  }

  it('drives scene selection from lint, neighbors and the plan bar', () => {
    const text = source();
    expect(text).toContain('WorkspaceTopbar');
    expect(text).toContain('SceneLint');
    expect(text).toContain('ProgramBar');
    expect(text).toContain('buildWorkspaceTimeline');
    expect(text).toContain('resolveTimeToScene');
    expect(text).toContain('resolveNeighborSceneId');
    expect(text).toContain('setSelectedSceneId(hit.sceneId)');
    expect(text).toContain('deriveSaveStatus');
    expect(text).not.toContain('xl:grid-cols-[280px_minmax(0,1fr)_400px]');
  });

  it('keeps manual PUT save and does not add autosave', () => {
    const text = source();
    expect(text).toContain('method: \'PUT\'');
    expect(text).toContain('setSavedSnapshot');
    expect(text).not.toContain('autosave');
  });
});
