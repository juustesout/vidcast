import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('ProjectWorkspace studio inspector controls', () => {
  function source(): string {
    return fs.readFileSync(path.join(process.cwd(), 'components/project/project-workspace.tsx'), 'utf8');
  }

  it('edits scene composition presenter mode through updateScene, not project.presenter.layout', () => {
    const text = source();

    expect(text).toContain('label="Presenter mode"');
    expect(text).toContain('updatePresenterMode(selectedScene.id');
    expect(text).toContain("mode: 'full_canvas'");
    expect(text).toContain("mode: 'pip'");
    expect(text).toContain('label="PiP preset"');
    expect(text).toContain('updatePresenterPipPreset(selectedScene.id');
    expect(text).not.toContain('project.presenter.sceneSettings');
    expect(text).not.toContain('layout: \'fullscreen\'');
  });

  it('edits scene.logo through updateScene and keeps inherit/custom/off without swapping assets', () => {
    const text = source();

    expect(text).toContain('function updateLogo');
    expect(text).toContain('label="Logo mode"');
    expect(text).toContain('Logo asset');
    expect(text).toContain('label="Logo position"');
    expect(text).toContain('Logo max width');
    expect(text).toContain('updateLogo(selectedScene.id');
    expect(text).toContain("updateLogo(selectedScene.id, () => null)");
    expect(text).toContain('delete next.logo');
    expect(text).toContain('invalid or missing');
    expect(text).not.toContain('draft.assets[0].id');
  });

  it('lists Motion Canvas templates and attaches via the existing animation APIs', () => {
    const text = source();

    expect(text).toContain("fetch('/api/animation-templates')");
    expect(text).toContain('`/api/projects/${draft.id}/animations/render`');
    expect(text).toContain('`/api/projects/${draft.id}/scenes/${sceneId}/animations/attach`');
    expect(text).toContain('northwind_arr_chart');
    expect(text).toContain('nix_overlay');
    expect(text).toContain('Attach to scene');
    expect(text).toContain('updateScene(sceneId, (scene) =>');
    expect(text).not.toContain('scenes: nextScenes');
  });
});
