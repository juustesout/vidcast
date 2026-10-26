import fs from 'node:fs';
import path from 'node:path';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentMandatePanel } from '@/components/project/agent-mandate-panel';

describe('AgentMandatePanel', () => {
  it('renders the one-time authorization action and production brief', () => {
    const html = renderToStaticMarkup(React.createElement(AgentMandatePanel, { projectId: 'project-1', projectTitle: 'Northwind' }));

    expect(html).toContain('Agent authorization');
    expect(html).toContain('Let the agent finish this video');
    expect(html).toContain('Production brief');
    expect(html).toContain('Finish video production for &quot;Northwind&quot; independently');
    expect(html).toContain('Valid for 1 day unless revoked earlier.');
    expect(html).toContain('No per-scene, per-asset, or per-step approval after this.');
    expect(html).toContain('Host real-provider flag and spend cap still apply.');
    expect(html).not.toContain('maxCostUsd');
    expect(html).not.toContain('maxSubmits');
    expect(html).not.toContain('Approve scene');
  });

  it('uses the existing user-only mandate routes and does not mint from MCP', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'components/project/agent-mandate-panel.tsx'), 'utf8');

    expect(source).toContain("from '@/lib/client/mandate-client'");
    expect(source).toContain('issueProjectMandate');
    expect(source).toContain('revokeProjectMandate');
    expect(source).toContain('getMandateStatus');
    expect(source).toContain('Revoke mandate');
    expect(source).toContain('Mandate revoked. New production actions are not authorized.');
    expect(source).toContain('Mandate expired. New production actions are not authorized.');
    expect(source).not.toContain('create_mandate');
    expect(source).not.toContain('EXPLAINER_API_TOKEN');
  });
});

describe('ProjectWorkspace agent authorization', () => {
  it('mounts the mandate panel in the production section without replacing Produce or ServerRunPanel', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'components/project/project-workspace.tsx'), 'utf8');

    expect(source).toContain('<AgentMandatePanel projectId={draft.id} projectTitle={draft.title} />');
    expect(source).toContain('Produce ${productionPlan.summary.ready}');
    expect(source).toContain('<ServerRunPanel projectId={draft.id} onEnsureSaved={saveProject} />');
  });
});
