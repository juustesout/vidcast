import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('ProjectWorkspace overlay controls', () => {
  it('exposes overlay enable, type, text, position, color, size, box and fade controls', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'components/project/project-workspace.tsx'), 'utf8');

    expect(source).toContain('function updateOverlay');
    expect(source).toContain('label="Overlay type"');
    expect(source).toContain('label="Overlay text"');
    expect(source).toContain('label="Overlay position"');
    expect(source).toContain('Overlay color (hex or name)');
    expect(source).toContain('Overlay font size');
    expect(source).toContain('Overlay background box');
    expect(source).toContain('Overlay fade in (seconds)');
    expect(source).toContain('Overlay fade out (seconds)');
    // Overlay edits go through the local draft scene mapper, not a stale
    // whole-array replacement.
    expect(source).toContain('updateOverlay(selectedScene.id');
  });
});
