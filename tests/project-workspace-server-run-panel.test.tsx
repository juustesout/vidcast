import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('ProjectWorkspace production controls', () => {
  it('keeps browserrunner controls and mounts the server-run panel in the production section', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'components/project/project-workspace.tsx'), 'utf8');

    expect(source).toContain('Produce ${productionPlan.summary.ready}');
    expect(source).toContain('<ServerRunPanel projectId={draft.id} onEnsureSaved={saveProject} />');
    expect(source).toContain('Live activity');
  });
});