import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AUTHORING_TOOL_DEFINITIONS } from '@/mcp/authoring/tools';
import { PRODUCTION_TOOL_DEFINITIONS } from '@/mcp/production/tools';
import { READ_ONLY_TOOL_DEFINITIONS } from '@/mcp/read-only/tools';

const manual = readFileSync(path.join(process.cwd(), 'agent_manual.md'), 'utf8');
const legacyManual = readFileSync(path.join(process.cwd(), 'docs', 'hermes-mcp-manual.md'), 'utf8');

const toolNames = [
  ...READ_ONLY_TOOL_DEFINITIONS.map((tool) => tool.name),
  ...AUTHORING_TOOL_DEFINITIONS.map((tool) => tool.name),
  ...PRODUCTION_TOOL_DEFINITIONS.map((tool) => tool.name)
];

describe('agent manual', () => {
  it('documents every registered MCP tool', () => {
    for (const name of toolNames) {
      expect(manual, `agent_manual.md is missing tool ${name}`).toContain(name);
    }
  });

  it('documents the presenter production contract', () => {
    expect(manual).toContain('presenter_submit');
    expect(manual).toContain('presenter_poll');
    expect(manual).toContain('maxCostUsd');
    expect(manual).toContain('HEYGEN_PRICING_JSON');
    expect(manual).toContain('presenter.cost.notConfigured');
    expect(manual).toContain('presenter.budget.exceeded');
  });

  it('documents connection configuration', () => {
    expect(manual).toContain('EXPLAINER_API_BASE_URL');
    expect(manual).toContain('EXPLAINER_API_TOKEN');
    expect(manual).toContain('http://localhost:3000');
  });

  it('keeps the legacy Hermes manual pointed at the canonical file', () => {
    expect(legacyManual).toContain('agent_manual.md');
  });
});
