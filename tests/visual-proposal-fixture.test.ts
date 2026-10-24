import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeProject } from '@/lib/projects/normalize-project';
import type { HtmlVisual, Scene, StockImageVisual } from '@/lib/types/scene';
import { validateProject } from '@/lib/validation/project-validation';
import {
  EXPECTED_VISUAL_PROPOSALS,
  VISUAL_PROPOSAL_EXISTING_ASSET_ID,
  VISUAL_PROPOSAL_MANUAL_STOCK_ASSET_ID,
  VISUAL_PROPOSAL_MANUAL_STOCK_SELECTION,
  VISUAL_PROPOSAL_PRODUCT_STILL_ASSET_ID,
  VISUAL_PROPOSAL_PROJECT_ID,
  VISUAL_PROPOSAL_SCENE_IDS,
  VISUAL_PROPOSAL_STUDIO_ASSET_ID,
  visualProposalProject,
  type VisualProposalSceneId
} from '@/tests/fixtures/visual-proposal-project';

const WORKSPACE_ROOT = process.cwd();

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(fullPath);
    }
    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [fullPath] : [];
  });
}

function sceneById(sceneId: VisualProposalSceneId): Scene {
  const scene = visualProposalProject.scenes.find((entry) => entry.id === sceneId);
  if (!scene) {
    throw new Error(`Missing scene ${sceneId}`);
  }
  return scene;
}

function intentForScene(sceneId: VisualProposalSceneId) {
  const scene = sceneById(sceneId);
  const intentId = scene.source?.sceneIntentId;
  const intent = visualProposalProject.explainer?.sceneIntents.find((entry) => entry.id === intentId);
  if (!intent) {
    throw new Error(`Missing scene intent for ${sceneId}`);
  }
  return intent;
}

describe('visual proposal fixture', () => {
  it('normalizes and validates without errors', () => {
    const normalized = normalizeProject(visualProposalProject);
    const result = validateProject(normalized);
    expect(normalized.id).toBe(VISUAL_PROPOSAL_PROJECT_ID);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    for (const scene of visualProposalProject.scenes) {
      const normalizedScene = normalized.scenes.find((entry) => entry.id === scene.id);
      expect(normalizedScene?.source).toEqual(scene.source);
    }
  });

  it('covers all nine scenarios and expected outcomes', () => {
    expect(visualProposalProject.scenes.map((scene) => scene.id)).toEqual([...VISUAL_PROPOSAL_SCENE_IDS]);
    expect(EXPECTED_VISUAL_PROPOSALS.map((proposal) => proposal.sceneId)).toEqual([...VISUAL_PROPOSAL_SCENE_IDS]);
    expect(EXPECTED_VISUAL_PROPOSALS).toHaveLength(9);
    expect(EXPECTED_VISUAL_PROPOSALS.every((proposal) => proposal.permissionRequired === 'none')).toBe(true);
  });

  it('matches scenario input fields used by the expected table', () => {
    const htmlChart = sceneById('scene-html-chart');
    expect(htmlChart.visual?.kind).toBe('html');
    expect((htmlChart.visual as HtmlVisual).template).toBe('chart');

    const statBlank = sceneById('scene-stat-blank');
    expect(statBlank.visual?.kind).toBe('blank');
    expect(intentForScene('scene-stat-blank').visualIntent).toMatch(/statistic/i);

    const productWithAsset = sceneById('scene-product-with-asset');
    expect(productWithAsset.visual?.kind).toBe('blank');
    expect(intentForScene('scene-product-with-asset').visualIntent).toMatch(/product card/i);
    expect(visualProposalProject.assets.some((asset) => asset.id === VISUAL_PROPOSAL_PRODUCT_STILL_ASSET_ID)).toBe(true);

    const moodBlank = sceneById('scene-mood-blank');
    expect(moodBlank.visual?.kind).toBe('blank');
    expect(intentForScene('scene-mood-blank').visualIntent).toMatch(/environment|mood/i);

    const productNoPhoto = sceneById('scene-product-no-photo');
    expect(productNoPhoto.visual?.kind).toBe('blank');
    expect(intentForScene('scene-product-no-photo').visualIntent).toMatch(/no still/i);

    const unclear = sceneById('scene-unclear');
    expect(unclear.visual?.kind).toBe('blank');
    expect(intentForScene('scene-unclear').visualIntent).toBe('');

    const stockVisual = sceneById('scene-stock-manual').visual as StockImageVisual;
    expect(stockVisual.kind).toBe('stock_image');
    expect(stockVisual.assetId).toBe(VISUAL_PROPOSAL_MANUAL_STOCK_ASSET_ID);
    expect(stockVisual.selection).toEqual(VISUAL_PROPOSAL_MANUAL_STOCK_SELECTION);
    expect(stockVisual.selection?.origin).toBe('manual');

    const existingAsset = sceneById('scene-existing-asset');
    expect(existingAsset.visual).toEqual({ kind: 'asset', assetId: VISUAL_PROPOSAL_EXISTING_ASSET_ID });

    const assetWithStudio = sceneById('scene-asset-with-studio');
    expect(assetWithStudio.visual).toEqual({ kind: 'asset', assetId: VISUAL_PROPOSAL_STUDIO_ASSET_ID });
    expect(assetWithStudio.composition?.preset).toBe('studio');

    expect(EXPECTED_VISUAL_PROPOSALS).toEqual([
      { sceneId: 'scene-html-chart', action: 'keep_existing', kind: 'html', template: 'chart', permissionRequired: 'none' },
      { sceneId: 'scene-stat-blank', action: 'propose', kind: 'html', template: 'stat_card', permissionRequired: 'none' },
      { sceneId: 'scene-product-with-asset', action: 'propose', kind: 'html', template: 'product_card', permissionRequired: 'none' },
      { sceneId: 'scene-mood-blank', action: 'propose', kind: 'stock_image', missingInputs: 'search query', permissionRequired: 'none' },
      { sceneId: 'scene-product-no-photo', action: 'ask', kind: 'blank', missingInputs: 'product still', permissionRequired: 'none' },
      { sceneId: 'scene-unclear', action: 'ask', kind: 'blank', permissionRequired: 'none' },
      { sceneId: 'scene-stock-manual', action: 'keep_existing', kind: 'stock_image', permissionRequired: 'none' },
      { sceneId: 'scene-existing-asset', action: 'keep_existing', kind: 'asset', permissionRequired: 'none' },
      { sceneId: 'scene-asset-with-studio', action: 'keep_existing', kind: 'asset', permissionRequired: 'none' }
    ]);
  });

  it('keeps blank scenes linked to valid scene intents', () => {
    const blankScenes = visualProposalProject.scenes.filter((scene) => scene.visual?.kind === 'blank');
    expect(blankScenes.map((scene) => scene.id)).toEqual([
      'scene-stat-blank',
      'scene-product-with-asset',
      'scene-mood-blank',
      'scene-product-no-photo',
      'scene-unclear'
    ]);
    for (const scene of blankScenes) {
      const intent = intentForScene(scene.id as VisualProposalSceneId);
      expect(scene.source?.sceneIntentId).toBe(intent.id);
      expect(scene.source?.beatIds).toEqual(intent.beatIds);
      expect(intent.materializedSceneId).toBe(scene.id);
    }
  });

  it('is unchanged after JSON clone', () => {
    const cloned = JSON.parse(JSON.stringify(visualProposalProject));
    expect(cloned).toEqual(visualProposalProject);
    expect(normalizeProject(cloned)).toEqual(normalizeProject(visualProposalProject));
  });

  it('is not imported by production code or existing planner, HTML, or stock tests', () => {
    const productionFiles = ['app', 'lib', 'mcp'].flatMap((dir) => collectSourceFiles(path.join(WORKSPACE_ROOT, dir)));
    for (const file of productionFiles) {
      const contents = readFileSync(file, 'utf8');
      expect(contents, file).not.toContain('visual-proposal-project');
      expect(contents, file).not.toContain('visual-proposal-fixture');
    }
    const existingTests = [
      'tests/production-planner.test.ts',
      'tests/html-still.test.ts',
      'tests/html-still-slot-images.test.ts',
      'tests/mcp-stock-select.test.ts',
      'tests/stock-selection-persistence.test.ts',
      'tests/scene-intent-materializer.test.ts',
      'tests/scene-intent-planner.test.ts'
    ];
    for (const relativePath of existingTests) {
      const contents = readFileSync(path.join(WORKSPACE_ROOT, relativePath), 'utf8');
      expect(contents, relativePath).not.toContain('visual-proposal-project');
      expect(contents, relativePath).not.toContain('visual-proposal-fixture');
    }
  });
});
