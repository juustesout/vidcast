import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('ProjectWorkspace production controls', () => {
  it('keeps browserrunner controls and mounts the server-run panel in the production section', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'components/project/project-workspace.tsx'), 'utf8');

    expect(source).toContain('Produce ${productionPlan.summary.ready}');
    expect(source).toContain('<ServerRunPanel projectId={draft.id} onEnsureSaved={saveProject} />');
    expect(source).toContain('Live activity');
    expect(source).toContain('startServerRunFlow({');
    expect(source).toContain('followServerRunFlow({');
    expect(source).toContain('ensureSaved: saveProject');
    expect(source).not.toContain('runProductionBatch');
    expect(source).not.toContain('executeProductionActionRequest');
  });
});

describe('ServerRunPanel idle-aware polling', () => {
  function panelSource(): string {
    return fs.readFileSync(path.join(process.cwd(), 'components/project/server-run-panel.tsx'), 'utf8');
  }

  it('suspends the run poll while hidden and resumes without dropping the tracker', () => {
    const source = panelSource();

    expect(source).toContain("import { isHidden, subscribeToVisibility } from '@/lib/client/visibility-poll'");
    expect(source).toContain('const visibleRef = useRef(true);');
    expect(source).toContain('const pollRef = useRef<() => Promise<void>>(');
    // Scheduling is gated on visibility, and a poll already running becomes a no-op.
    expect(source).toContain('if (!visibleRef.current) {');
    expect(source).toContain('const tracker = trackerRef.current;');
    expect(source).toContain('subscribeToVisibility((hidden) => {');
    // The remote job must be recovered on resume, not cancelled.
    expect(source).not.toContain('.cancel(');
  });

  it('routes timers through the latest poll callback instead of a captured one', () => {
    const source = panelSource();

    expect(source).toContain('void pollRef.current();');
    expect(source).not.toContain('void pollServerRun();');
  });

  it('renders the production QC report from the run snapshot', () => {
    const source = panelSource();

    expect(source).toContain('trackerState.run.report');
    expect(source).toContain('Production QC');
    expect(source).toContain('report.qcStatus');
    expect(source).toContain('output.downloadPath');
    expect(source).toContain('report.scenes.passed');
    expect(source).toContain('report.recoveryAttempts');
  });
});
