import { createStudioComposition } from '@/lib/render/scene-composition';
import type { Asset } from '@/lib/types/asset';
import type { SceneIntentDraft, StoryBeat } from '@/lib/types/explainer';
import type { Project } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';
import type { StockSelection } from '@/lib/types/stock';

export const VISUAL_PROPOSAL_PROJECT_ID = 'project_visual_proposal';

export const VISUAL_PROPOSAL_NOW = '2026-10-23T00:00:00.000Z';

export const VISUAL_PROPOSAL_SCENE_IDS = [
  'scene-html-chart',
  'scene-stat-blank',
  'scene-product-with-asset',
  'scene-mood-blank',
  'scene-product-no-photo',
  'scene-unclear',
  'scene-stock-manual',
  'scene-existing-asset',
  'scene-asset-with-studio'
] as const;

export type VisualProposalSceneId = (typeof VISUAL_PROPOSAL_SCENE_IDS)[number];

export type VisualProposalAction = 'keep_existing' | 'propose' | 'ask';

export type VisualProposalKind =
  | 'html'
  | 'stock_image'
  | 'asset'
  | 'blank';

export interface ExpectedVisualProposal {
  sceneId: VisualProposalSceneId;
  action: VisualProposalAction;
  kind: VisualProposalKind;
  template?: 'chart' | 'stat_card' | 'product_card';
  missingInputs?: 'search query' | 'product still';
  permissionRequired: 'none';
}

export const EXPECTED_VISUAL_PROPOSALS: ExpectedVisualProposal[] = [
  {
    sceneId: 'scene-html-chart',
    action: 'keep_existing',
    kind: 'html',
    template: 'chart',
    permissionRequired: 'none'
  },
  {
    sceneId: 'scene-stat-blank',
    action: 'propose',
    kind: 'html',
    template: 'stat_card',
    permissionRequired: 'none'
  },
  {
    sceneId: 'scene-product-with-asset',
    action: 'propose',
    kind: 'html',
    template: 'product_card',
    permissionRequired: 'none'
  },
  {
    sceneId: 'scene-mood-blank',
    action: 'propose',
    kind: 'stock_image',
    missingInputs: 'search query',
    permissionRequired: 'none'
  },
  {
    sceneId: 'scene-product-no-photo',
    action: 'ask',
    kind: 'blank',
    missingInputs: 'product still',
    permissionRequired: 'none'
  },
  {
    sceneId: 'scene-unclear',
    action: 'ask',
    kind: 'blank',
    permissionRequired: 'none'
  },
  {
    sceneId: 'scene-stock-manual',
    action: 'keep_existing',
    kind: 'stock_image',
    permissionRequired: 'none'
  },
  {
    sceneId: 'scene-existing-asset',
    action: 'keep_existing',
    kind: 'asset',
    permissionRequired: 'none'
  },
  {
    sceneId: 'scene-asset-with-studio',
    action: 'keep_existing',
    kind: 'asset',
    permissionRequired: 'none'
  }
];

const PRODUCT_STILL_ASSET_ID = 'asset-product-still';
const EXISTING_ASSET_ID = 'asset-existing-photo';
const STUDIO_ASSET_ID = 'asset-studio-photo';
const MANUAL_STOCK_ASSET_ID = 'asset-stock-manual';

const manualStockSelection: StockSelection = {
  provider: 'pexels',
  photoId: '42',
  query: 'sunset over quiet water',
  orientation: 'landscape',
  usagePolicy: 'download',
  attribution: {
    provider: 'pexels',
    providerName: 'Pexels',
    photoId: '42',
    photographerName: 'Ada',
    sourceUrl: 'https://pexels.com/42',
    license: 'Pexels License'
  },
  sourceUrl: 'https://pexels.com/42',
  imageUrl: 'https://images.pexels.com/42.jpg',
  width: 1920,
  height: 1080,
  selectedAt: VISUAL_PROPOSAL_NOW,
  selectionKey: 'landscape::sunset over quiet water',
  origin: 'manual'
};

function makeImageAsset(id: string, filename: string): Asset {
  return {
    id,
    type: 'image',
    status: 'available',
    provenance: 'imported',
    filename,
    localPath: `assets/${filename}`,
    mimeType: 'image/png',
    width: 1920,
    height: 1080,
    metadata: {},
    createdAt: VISUAL_PROPOSAL_NOW,
    updatedAt: VISUAL_PROPOSAL_NOW
  };
}

function makeStockAsset(id: string, filename: string): Asset {
  return {
    ...makeImageAsset(id, filename),
    provenance: 'stock'
  };
}

function baseScene(id: VisualProposalSceneId, order: number, duration: number, overrides: Partial<Scene>): Scene {
  return {
    id,
    order,
    duration,
    type: 'blank',
    narration: { text: '' },
    visual: { kind: 'blank' },
    render: { motion: { preset: 'none' }, transition: { type: 'fade' } },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: '',
    renders: [],
    ...overrides
  };
}

const beats: StoryBeat[] = [
  { id: 'beat-html-chart', order: 1, label: 'Chart', text: 'Quarterly adoption rose across every region.' },
  { id: 'beat-stat-blank', order: 2, label: 'Statistic', text: 'Retention hit 92 percent this quarter.' },
  { id: 'beat-product-with-asset', order: 3, label: 'Product', text: 'Show the bottle next to its claim.' },
  { id: 'beat-mood-blank', order: 4, label: 'Mood', text: 'Open on a calm evening atmosphere.' },
  { id: 'beat-product-no-photo', order: 5, label: 'Missing still', text: 'The cream needs a product card.' },
  { id: 'beat-unclear', order: 6, label: 'Unclear', text: 'Something visual belongs here.' },
  { id: 'beat-stock-manual', order: 7, label: 'Pinned stock', text: 'Keep the chosen sunset photo.' },
  { id: 'beat-existing-asset', order: 8, label: 'Local asset', text: 'Use the imported still as-is.' },
  { id: 'beat-asset-with-studio', order: 9, label: 'Studio asset', text: 'Keep the asset inside the studio frame.' }
];

const sceneIntents: SceneIntentDraft[] = [
  {
    id: 'intent-html-chart',
    order: 1,
    beatIds: ['beat-html-chart'],
    label: 'Chart already authored',
    narrativeRole: 'explanation',
    visualIntent: 'Bar chart of regional adoption',
    narrationDraft: 'Adoption rose in every region.',
    timing: { durationSeconds: 6 },
    status: 'approved',
    materializedSceneId: 'scene-html-chart'
  },
  {
    id: 'intent-stat-blank',
    order: 2,
    beatIds: ['beat-stat-blank'],
    label: 'Statistic still blank',
    narrativeRole: 'explanation',
    visualIntent: 'Large statistic for 92 percent retention',
    narrationDraft: 'Retention hit 92 percent.',
    timing: { durationSeconds: 5 },
    status: 'approved',
    materializedSceneId: 'scene-stat-blank'
  },
  {
    id: 'intent-product-with-asset',
    order: 3,
    beatIds: ['beat-product-with-asset'],
    label: 'Product with still',
    narrativeRole: 'example',
    visualIntent: 'Product card using the local bottle still',
    narrationDraft: 'Here is the bottle.',
    timing: { durationSeconds: 6 },
    status: 'approved',
    materializedSceneId: 'scene-product-with-asset'
  },
  {
    id: 'intent-mood-blank',
    order: 4,
    beatIds: ['beat-mood-blank'],
    label: 'Mood without query',
    narrativeRole: 'hook',
    visualIntent: 'Moody evening environment',
    narrationDraft: 'Evening settles over the water.',
    timing: { durationSeconds: 5 },
    status: 'approved',
    materializedSceneId: 'scene-mood-blank'
  },
  {
    id: 'intent-product-no-photo',
    order: 5,
    beatIds: ['beat-product-no-photo'],
    label: 'Product without still',
    narrativeRole: 'example',
    visualIntent: 'Product card for the cream, no still on the project',
    narrationDraft: 'The cream needs a card.',
    timing: { durationSeconds: 5 },
    status: 'approved',
    materializedSceneId: 'scene-product-no-photo'
  },
  {
    id: 'intent-unclear',
    order: 6,
    beatIds: ['beat-unclear'],
    label: 'Unclear intent',
    narrativeRole: 'custom',
    visualIntent: '',
    narrationDraft: 'Something belongs here.',
    timing: { durationSeconds: 4 },
    status: 'approved',
    materializedSceneId: 'scene-unclear'
  },
  {
    id: 'intent-stock-manual',
    order: 7,
    beatIds: ['beat-stock-manual'],
    label: 'Pinned stock',
    narrativeRole: 'setup',
    visualIntent: 'Keep the manually chosen sunset',
    narrationDraft: 'This sunset stays.',
    timing: { durationSeconds: 5 },
    status: 'approved',
    materializedSceneId: 'scene-stock-manual'
  },
  {
    id: 'intent-existing-asset',
    order: 8,
    beatIds: ['beat-existing-asset'],
    label: 'Existing asset',
    narrativeRole: 'example',
    visualIntent: 'Keep the imported still',
    narrationDraft: 'Use the imported photo.',
    timing: { durationSeconds: 5 },
    status: 'approved',
    materializedSceneId: 'scene-existing-asset'
  },
  {
    id: 'intent-asset-with-studio',
    order: 9,
    beatIds: ['beat-asset-with-studio'],
    label: 'Asset with studio',
    narrativeRole: 'example',
    visualIntent: 'Keep the asset even with a studio composition',
    narrationDraft: 'The still stays in the studio frame.',
    timing: { durationSeconds: 5 },
    status: 'approved',
    materializedSceneId: 'scene-asset-with-studio'
  }
];

const scenes: Scene[] = [
  baseScene('scene-html-chart', 1, 6, {
    type: 'html',
    source: { sceneIntentId: 'intent-html-chart', beatIds: ['beat-html-chart'] },
    narration: { text: 'Adoption rose in every region.' },
    visual: {
      kind: 'html',
      template: 'chart',
      templateData: {
        title: 'Regional adoption',
        kind: 'bar',
        points: [
          { label: 'North', value: 42 },
          { label: 'South', value: 31 },
          { label: 'West', value: 27 }
        ],
        unit: '%'
      }
    },
    notes: 'Visual intent: Bar chart of regional adoption'
  }),
  baseScene('scene-stat-blank', 2, 5, {
    source: { sceneIntentId: 'intent-stat-blank', beatIds: ['beat-stat-blank'] },
    narration: { text: 'Retention hit 92 percent.' },
    notes: 'Visual intent: Large statistic for 92 percent retention'
  }),
  baseScene('scene-product-with-asset', 3, 6, {
    source: { sceneIntentId: 'intent-product-with-asset', beatIds: ['beat-product-with-asset'] },
    narration: { text: 'Here is the bottle.' },
    notes: 'Visual intent: Product card using the local bottle still'
  }),
  baseScene('scene-mood-blank', 4, 5, {
    source: { sceneIntentId: 'intent-mood-blank', beatIds: ['beat-mood-blank'] },
    narration: { text: 'Evening settles over the water.' },
    notes: 'Visual intent: Moody evening environment'
  }),
  baseScene('scene-product-no-photo', 5, 5, {
    source: { sceneIntentId: 'intent-product-no-photo', beatIds: ['beat-product-no-photo'] },
    narration: { text: 'The cream needs a card.' },
    notes: 'Visual intent: Product card for the cream, no still on the project'
  }),
  baseScene('scene-unclear', 6, 4, {
    source: { sceneIntentId: 'intent-unclear', beatIds: ['beat-unclear'] },
    narration: { text: 'Something belongs here.' },
    notes: ''
  }),
  baseScene('scene-stock-manual', 7, 5, {
    type: 'image',
    source: { sceneIntentId: 'intent-stock-manual', beatIds: ['beat-stock-manual'] },
    narration: { text: 'This sunset stays.' },
    visual: {
      kind: 'stock_image',
      query: 'sunset over quiet water',
      orientation: 'landscape',
      preferredProviders: ['pexels'],
      assetId: MANUAL_STOCK_ASSET_ID,
      selection: manualStockSelection
    },
    notes: 'Visual intent: Keep the manually chosen sunset'
  }),
  baseScene('scene-existing-asset', 8, 5, {
    type: 'image',
    source: { sceneIntentId: 'intent-existing-asset', beatIds: ['beat-existing-asset'] },
    narration: { text: 'Use the imported photo.' },
    visual: {
      kind: 'asset',
      assetId: EXISTING_ASSET_ID
    },
    notes: 'Visual intent: Keep the imported still'
  }),
  baseScene('scene-asset-with-studio', 9, 5, {
    type: 'image',
    source: { sceneIntentId: 'intent-asset-with-studio', beatIds: ['beat-asset-with-studio'] },
    narration: { text: 'The still stays in the studio frame.' },
    visual: {
      kind: 'asset',
      assetId: STUDIO_ASSET_ID
    },
    composition: JSON.parse(JSON.stringify(createStudioComposition({
      imageAssetId: STUDIO_ASSET_ID,
      imageLocalPath: `assets/${STUDIO_ASSET_ID}.png`,
      overlayEnabled: false
    }))),
    notes: 'Visual intent: Keep the asset even with a studio composition'
  })
];

export const visualProposalProject: Project = {
  id: VISUAL_PROPOSAL_PROJECT_ID,
  title: 'Visual proposal fixture',
  description: 'Golden project covering the nine visual proposal scenarios.',
  durationTarget: 46,
  aspectRatio: '16:9',
  fps: 30,
  createdAt: VISUAL_PROPOSAL_NOW,
  updatedAt: VISUAL_PROPOSAL_NOW,
  explainer: {
    brief: {
      topic: 'Visual proposal scenarios',
      goal: 'Hold one typed project for the nine proposal cases',
      audience: 'Authors choosing a visual source',
      tone: 'Direct',
      targetDurationSeconds: 46,
      notes: ''
    },
    story: {
      title: 'Visual proposal fixture',
      hook: 'Nine scenes, nine proposal shapes.',
      script: beats.map((beat) => beat.text).join(' '),
      beats,
      cta: '',
      notes: '',
      versions: [
        {
          id: 'script-version-1',
          script: beats.map((beat) => beat.text).join(' '),
          createdAt: VISUAL_PROPOSAL_NOW,
          source: 'manual'
        }
      ]
    },
    sceneIntents
  },
  narration: { text: '', segments: [] },
  scenes,
  assets: [
    makeImageAsset(PRODUCT_STILL_ASSET_ID, `${PRODUCT_STILL_ASSET_ID}.png`),
    makeImageAsset(EXISTING_ASSET_ID, `${EXISTING_ASSET_ID}.png`),
    makeImageAsset(STUDIO_ASSET_ID, `${STUDIO_ASSET_ID}.png`),
    makeStockAsset(MANUAL_STOCK_ASSET_ID, `${MANUAL_STOCK_ASSET_ID}.png`)
  ],
  references: [],
  compositions: [],
  renderSettings: {
    aspectRatio: '16:9',
    fps: 30,
    width: 1920,
    height: 1080,
    background: { type: 'color', value: '#070b10' },
    audio: {
      narrationVolume: 1,
      musicVolume: 0.35,
      effectsVolume: 0.2
    },
    subtitlesEnabled: true
  }
};

export const VISUAL_PROPOSAL_PRODUCT_STILL_ASSET_ID = PRODUCT_STILL_ASSET_ID;
export const VISUAL_PROPOSAL_EXISTING_ASSET_ID = EXISTING_ASSET_ID;
export const VISUAL_PROPOSAL_STUDIO_ASSET_ID = STUDIO_ASSET_ID;
export const VISUAL_PROPOSAL_MANUAL_STOCK_ASSET_ID = MANUAL_STOCK_ASSET_ID;
export const VISUAL_PROPOSAL_MANUAL_STOCK_SELECTION = manualStockSelection;
