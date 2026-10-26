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

  it('documents the visual source playbook safety rules', () => {
    expect(manual).toContain('Visual source playbook');
    expect(manual).toMatch(/narrativeRole[\s\S]*visualIntent[\s\S]*metadata/);
    expect(manual).toContain('visual.kind: "blank"');
    expect(manual).toContain('origin: "manual"');
    expect(manual).toContain('stock.search.expired');
    expect(manual).toContain('image_generate');
    expect(manual).toContain('fail closed');
    expect(manual).toMatch(/HTML `chart` or `stat_card`/);
    expect(manual).toMatch(/product_card/);
    expect(manual).toContain('select_stock_photo');
    expect(manual).toContain('import_asset');
    expect(manual).toMatch(/explicit permission/);
    expect(manual).toMatch(/Stock CDN URLs are rejected/);
  });

  it('documents the propose-then-wait visual workflow', () => {
    expect(manual).toContain('Propose → Wait → Apply');
    expect(manual).toContain('sceneId:');
    expect(manual).toContain('keep_existing');
    expect(manual).toContain('propose');
    expect(manual).toContain('ask');
    expect(manual).toContain('proposed.kind');
    expect(manual).toContain('reason:');
    expect(manual).toContain('missingInputs');
    expect(manual).toContain('permissionRequired');
    expect(manual).toContain('image_generate');
    expect(manual).toContain('video_submit');
    expect(manual).toMatch(/keep_existing/);
    expect(manual).toMatch(/selection\.origin[\s\S]*manual/);
    expect(manual).toMatch(/Stop after the proposal/);
    expect(manual).toMatch(/Wait for explicit user approval/);
    expect(manual).toMatch(/A proposal is not a patch/);
    expect(manual).toMatch(/Do not call[\s\S]*search_stock_photos[\s\S]*select_stock_photo[\s\S]*update_project[\s\S]*generate_video[\s\S]*run_production/);
  });

  it('documents that a service token cannot grant human approval', () => {
    expect(manual).toContain('explainer.humanApproval');
    expect(manual).toMatch(/service token cannot grant that approval/);
    expect(manual).toMatch(/cannot forge intent `status: "approved"`/);
    expect(manual).toMatch(/human browser session only; MCP\/service token is FORBIDDEN/);
    expect(manual).toMatch(/That includes real stock search/);
    expect(manual).toContain('get_mandate_status');
    expect(manual).toMatch(/live production mandate/);
    expect(manual).toMatch(/never mints, revokes, or forges a mandate/);
    expect(manual).toContain('Let the agent finish this video');
    expect(manual).toContain('mandate.budget.exceeded');
    expect(manual).toMatch(/maxCostUsd[\s\S]*enforced only for HeyGen presenter estimates/);
  });

  it('documents P153 proposal clarifications', () => {
    expect(manual).toMatch(/propose[\s\S]*stock_image[\s\S]*missingInputs: search query/);
    expect(manual).toMatch(/does not call `search_stock_photos` or `select_stock_photo`/);
    expect(manual).toMatch(/Product template that needs an image[\s\S]*`ask`/);
    expect(manual).toMatch(/Do not import an asset/);
    expect(manual).toMatch(/`asset`, `html`, `text`, `graphic`/);
    expect(manual).toMatch(/composition[\s\S]*not a reason to replace `visual.kind`/);
    expect(manual).toMatch(/keep_existing[\s\S]*even if another template/);
  });
});
