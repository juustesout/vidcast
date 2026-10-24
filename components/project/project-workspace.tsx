'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ANIMATION_TEMPLATE_IDS, type AnimationDestination, type AnimationTemplateSummary } from '@/lib/animation/types';
import { ASPECT_RATIOS, GENERATION_PROVIDERS, GENERATION_STATUSES, LOGO_OVERLAY_LIMITS, LOGO_OVERLAY_POSITIONS, MOTION_PRESETS, OVERLAY_POSITIONS, OVERLAY_STYLE_LIMITS, OVERLAY_TYPES, SCENE_TYPES, TRANSITION_PRESETS, VIDEO_GENERATION_PROVIDERS } from '@/lib/constants';
import { ExplainerStoryWorkspace } from '@/components/project/explainer-story-workspace';
import { BackgroundMusicPanel } from '@/components/project/background-music-panel';
import { HtmlStillSlotImagePicker } from '@/components/project/html-still-slot-image-picker';
import { ProductionWorkflow } from '@/components/project/production-workflow';
import { ServerRunPanel } from '@/components/project/server-run-panel';
import { ScenePreview } from '@/components/preview/scene-preview';
import { ValidationPanel } from '@/components/project/validation-panel';
import { ReferencesPanel } from '@/components/project/references-panel';
import { EmptyPanel, Field, InfoMiniCard, SelectField, TabButton } from '@/components/project/workspace-controls';
import { createProjectCompositionRequest, createSceneNarrationRequest, createSceneRenderRequest } from '@/lib/client/render-client';
import { followServerRunFlow, ProductionRunTracker, startServerRunFlow } from '@/lib/client/production-run-tracker';
import { deriveGenerationTasks } from '@/lib/projects/generation-tasks';
import { resolveVideoProviderForwarding } from '@/lib/generation/video-provider-forwarding';
import { resolveVideoModelAuthoringHints } from '@/lib/ai/video-generation/models';
import { deriveCompositionArtifactStatus, deriveCompositionReadiness, deriveSceneRenderStatus, formatRenderStatusLabel } from '@/lib/render/render-status';
import { applyHtmlStillSlotImage, isHtmlStillSlotImageAsset } from '@/lib/projects/html-still-slot-images';
import { getAssetUsage } from '@/lib/projects/usage';
import { defaultBoxForType, defaultPositionForType } from '@/lib/render/overlay-resolve';
import {
  createStudioComposition,
  resolveStudioPipRect,
  resolveStudioPresenterRect,
  STUDIO_COMPOSITION_CANVAS,
  STUDIO_LAYER_IDS,
  STUDIO_PRESENTER_PIP_OFFSET_X,
  STUDIO_PRESENTER_PIP_OFFSET_Y,
  STUDIO_PRESENTER_PIP_SCALE
} from '@/lib/render/scene-composition';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { createId } from '@/lib/utils/ids';
import { isHidden, subscribeToVisibility } from '@/lib/client/visibility-poll';
import { joinProjectAssetUrl, joinProjectReferenceUrl } from '@/lib/utils/project-files';
import { deriveActiveWorkflowStepId } from '@/lib/workflow/workflow-navigation';
import { deriveWorkflowStatus } from '@/lib/workflow/workflow-status';
import { deriveProductionPlan, groupProductionActionsByScene, type ProductionPlannedAction } from '@/lib/production/production-planner';
import { type ProductionRunnerEvent, type ProductionRunnerResultStatus } from '@/lib/production/production-runner';
import { formatProductionLogAsText } from '@/lib/production/production-log-export';
import type { WorkflowNavigationTarget, WorkflowStepId } from '@/lib/workflow/workflow-status';
import type { GenerationProvider, GenerationStatus } from '@/lib/types/generation';
import type { Project } from '@/lib/types/render';
import type { ReferenceImage } from '@/lib/types/reference';
import type { GraphicTemplateType, HtmlStillTemplateType, LogoOverlaySpec, OverlaySpec, Scene, VisualSpec } from '@/lib/types/scene';
import type {
  SceneCompositionCanvas,
  SceneCompositionPipPresetName,
  SceneCompositionPresenterLayer,
  SceneCompositionPresenterMode
} from '@/lib/types/scene-composition';
import type { StockOrientation } from '@/lib/types/stock';
import { validateProject } from '@/lib/validation/project-validation';

interface ProjectWorkspaceProps {
  project: Project;
}

type VisualMode = 'asset' | 'generated_image' | 'generated_video' | 'stock_image' | 'graphic' | 'html' | 'text' | 'blank';
type WorkspaceTab = 'story' | 'scenes' | 'assets' | 'references' | 'generation';
type AssetFilter = 'all' | 'images' | 'video' | 'audio' | 'generated' | 'imported';
type StoryFocusArea = 'brief' | 'story' | 'scene_plan';

// Mirrors the JSON returned by the server-side stock search route. Declared
// locally (rather than imported) so no server-only module (fs/sharp) is pulled
// into the client bundle.
interface StockSearchResultItem {
  id: string;
  provider: string;
  photoId: string;
  width: number;
  height: number;
  description?: string;
  color?: string;
  previewUrl: string;
  imageUrl: string;
  sourceUrl: string;
  photographerName: string;
  photographerUrl?: string;
  license: string;
  usagePolicy: 'download' | 'hotlink';
}

interface StockQuotaSnapshot {
  provider: string;
  configured: boolean;
  allowed: boolean;
  windowSeconds: number;
  windowLimit: number;
  windowRemaining: number;
  reserve: number;
  resetAt?: number;
  monthlyLimit?: number;
  monthlyRemaining?: number;
}

interface StockSearchState {
  sceneId: string;
  searchId: string;
  query: string;
  orientation?: string;
  cached: boolean;
  results: StockSearchResultItem[];
  quota: StockQuotaSnapshot[];
  diagnostics: Array<{ provider: string; outcome: string; detail?: string }>;
}

const GRAPHIC_TEMPLATES: GraphicTemplateType[] = ['title_card', 'bullet_list', 'statistic', 'quote', 'comparison', 'simple_diagram', 'callout', 'end_card'];
const HTML_STILL_TEMPLATES: HtmlStillTemplateType[] = ['headline', 'stat_card', 'comparison', 'chart', 'timeline', 'location_card', 'route_map', 'product_card', 'product_comparison', 'feature_callouts', 'flow_diagram', 'decision_tree', 'system_diagram'];

function htmlTemplateDataFor(template: HtmlStillTemplateType, previous: Record<string, unknown> = {}): Record<string, unknown> {
  const title = typeof previous.title === 'string' ? previous.title : 'Headline';
  if (template === 'stat_card' || template === 'stat-card') {
    return {
      label: typeof previous.label === 'string' ? previous.label : 'Metric',
      value: typeof previous.value === 'string' ? previous.value : '42%',
      detail: typeof previous.detail === 'string' ? previous.detail : '',
      trend: previous.trend === 'up' || previous.trend === 'down' || previous.trend === 'flat' ? previous.trend : 'up',
      delta: typeof previous.delta === 'string' ? previous.delta : ''
    };
  }
  if (template === 'comparison' || template === 'comparison_card') {
    return {
      title: title === 'Headline' ? 'Comparison' : title,
      items: [
        { name: 'Before', features: [{ label: 'Metric', value: 'Low' }] },
        { name: 'After', features: [{ label: 'Metric', value: 'High' }] }
      ]
    };
  }
  if (template === 'chart') {
    return {
      title: title === 'Headline' ? 'Quarterly ARR' : title,
      kind: previous.kind === 'line' ? 'line' : 'bar',
      unit: typeof previous.unit === 'string' ? previous.unit : 'M',
      points: Array.isArray(previous.points) && previous.points.length > 0
        ? previous.points
        : [
            { label: 'Q1', value: 12 },
            { label: 'Q2', value: 18 },
            { label: 'Q3', value: 15 },
            { label: 'Q4', value: 24 }
          ]
    };
  }
  if (template === 'timeline') {
    return {
      title: title === 'Headline' ? 'Roadmap' : title,
      events: Array.isArray(previous.events) && previous.events.length > 0
        ? previous.events
        : [
            { date: 'Jan', label: 'Kickoff', detail: 'Scope locked' },
            { date: 'Mar', label: 'Beta', detail: 'First customer' },
            { date: 'Jun', label: 'GA', detail: 'Public launch' }
          ]
    };
  }
  if (template === 'location_card') {
    return {
      place: typeof previous.place === 'string' ? previous.place : 'Helsinki',
      region: typeof previous.region === 'string' ? previous.region : 'Finland',
      detail: typeof previous.detail === 'string' ? previous.detail : 'Studio origin'
    };
  }
  if (template === 'route_map') {
    return {
      title: title === 'Headline' ? 'Route' : title,
      locations: Array.isArray(previous.locations) && previous.locations.length > 0
        ? previous.locations
        : [
            { id: 'hel', label: 'Helsinki' },
            { id: 'sto', label: 'Stockholm' },
            { id: 'osl', label: 'Oslo' }
          ],
      links: Array.isArray(previous.links) && previous.links.length > 0
        ? previous.links
        : [
            { from: 'hel', to: 'sto' },
            { from: 'sto', to: 'osl' }
          ]
    };
  }
  if (template === 'product_card') {
    return {
      name: typeof previous.name === 'string' ? previous.name : 'Northwind Hub',
      subtitle: typeof previous.subtitle === 'string' ? previous.subtitle : 'Studio kit',
      description: typeof previous.description === 'string' ? previous.description : '',
      features: Array.isArray(previous.features) && previous.features.length > 0
        ? previous.features
        : [{ label: 'Weight', value: '1.2 kg' }],
      ...(typeof previous.imageAssetId === 'string' && previous.imageAssetId ? { imageAssetId: previous.imageAssetId } : {})
    };
  }
  if (template === 'product_comparison') {
    return {
      title: title === 'Headline' ? 'Product compare' : title,
      products: Array.isArray(previous.products) && previous.products.length > 0
        ? previous.products
        : [
            { name: 'Air', features: [{ label: 'Weight', value: '0.9 kg' }] },
            { name: 'Pro', features: [{ label: 'Weight', value: '1.4 kg' }] }
          ]
    };
  }
  if (template === 'feature_callouts') {
    return {
      name: typeof previous.name === 'string' ? previous.name : 'Northwind Hub',
      callouts: Array.isArray(previous.callouts) && previous.callouts.length > 0
        ? previous.callouts
        : [
            { label: 'Lens', detail: 'Wide capture', side: 'left' },
            { label: 'Mic', detail: 'Studio voice', side: 'right' }
          ],
      ...(typeof previous.imageAssetId === 'string' && previous.imageAssetId ? { imageAssetId: previous.imageAssetId } : {})
    };
  }
  if (template === 'flow_diagram') {
    return {
      title: title === 'Headline' ? 'Studio flow' : title,
      steps: Array.isArray(previous.steps) && previous.steps.length > 0
        ? previous.steps
        : [
            { id: 'brief', label: 'Brief', detail: 'Lock scope' },
            { id: 'render', label: 'Render', detail: 'HTML still' },
            { id: 'compose', label: 'Compose', detail: 'Studio MP4' }
          ],
      links: Array.isArray(previous.links) && previous.links.length > 0
        ? previous.links
        : [
            { from: 'brief', to: 'render' },
            { from: 'render', to: 'compose' }
          ]
    };
  }
  if (template === 'decision_tree') {
    return {
      title: title === 'Headline' ? 'Go or wait' : title,
      nodes: Array.isArray(previous.nodes) && previous.nodes.length > 0
        ? previous.nodes
        : [
            { id: 'ready', kind: 'question', label: 'Ready?' },
            { id: 'go', kind: 'outcome', label: 'Ship' },
            { id: 'hold', kind: 'outcome', label: 'Hold' }
          ],
      branches: Array.isArray(previous.branches) && previous.branches.length > 0
        ? previous.branches
        : [
            { from: 'ready', to: 'go', label: 'Ja' },
            { from: 'ready', to: 'hold', label: 'Nee' }
          ]
    };
  }
  if (template === 'system_diagram') {
    return {
      title: title === 'Headline' ? 'Studio stack' : title,
      components: Array.isArray(previous.components) && previous.components.length > 0
        ? previous.components
        : [
            { id: 'author', label: 'Authoring', role: 'Input' },
            { id: 'still', label: 'HTML still', role: 'PNG' },
            { id: 'studio', label: 'Studio', role: 'MP4' }
          ],
      links: Array.isArray(previous.links) && previous.links.length > 0
        ? previous.links
        : [
            { from: 'author', to: 'still', label: 'render' },
            { from: 'still', to: 'studio', label: 'bind' }
          ]
    };
  }
  return {
    title,
    subtitle: typeof previous.subtitle === 'string' ? previous.subtitle : '',
    source: typeof previous.source === 'string' ? previous.source : '',
    kicker: typeof previous.kicker === 'string' ? previous.kicker : '',
    ...(typeof previous.imageAssetId === 'string' && previous.imageAssetId ? { imageAssetId: previous.imageAssetId } : {})
  };
}

function cloneProject(projectValue: Project): Project {
  return JSON.parse(JSON.stringify(projectValue)) as Project;
}

function defaultScene(order: number): Scene {
  const now = new Date().toISOString();
  return {
    id: createId('scene'),
    order,
    duration: 5,
    type: 'image',
    narration: { text: '' },
    visual: {
      kind: 'generated_image',
      generation: {
        id: createId('generation'),
        kind: 'image',
        status: 'planned',
        provider: 'local',
        prompt: '',
        referenceIds: [],
        aspectRatio: '16:9',
        createdAt: now
      }
    },
    render: {
      motion: { preset: 'zoom_in' },
      transition: { type: 'fade' }
    },
    overlay: { type: 'none' },
    referenceIds: [],
    notes: ''
  };
}

function visualModeOf(scene: Scene): VisualMode {
  return scene.visual?.kind ?? 'blank';
}

function ensureVisualForMode(scene: Scene, mode: VisualMode): VisualSpec {
  const now = new Date().toISOString();
  switch (mode) {
    case 'asset':
      return { kind: 'asset' };
    case 'stock_image':
      return { kind: 'stock_image', query: '' };
    case 'generated_image':
      return {
        kind: 'generated_image',
        generation: {
          id: createId('generation'),
          kind: 'image',
          status: 'planned',
          provider: 'local',
          prompt: '',
          referenceIds: scene.referenceIds,
          aspectRatio: '16:9',
          createdAt: now
        }
      };
    case 'generated_video':
      return {
        kind: 'generated_video',
        generation: {
          id: createId('generation'),
          kind: 'video',
          status: 'planned',
          provider: 'local',
          prompt: '',
          referenceIds: scene.referenceIds,
          aspectRatio: '16:9',
          duration: scene.duration,
          createdAt: now
        }
      };
    case 'graphic':
      return { kind: 'graphic', template: 'simple_diagram', templateData: {} };
    case 'html':
      return { kind: 'html', template: 'headline', templateData: { title: 'Headline', subtitle: '', source: '' }, width: 1920, height: 1080, background: 'opaque' };
    case 'text':
      return { kind: 'text', text: scene.overlay?.text ?? scene.narration?.text ?? '' };
    case 'blank':
    default:
      return { kind: 'blank' };
  }
}

function assetTypeGroup(type: string): 'images' | 'video' | 'audio' | 'other' {
  if (type === 'image' || type === 'graphic') {
    return 'images';
  }
  if (type === 'video') {
    return 'video';
  }
  if (type === 'audio' || type === 'music' || type === 'voice') {
    return 'audio';
  }
  return 'other';
}

function formatSize(value?: number): string {
  if (!value || value <= 0) {
    return 'Unknown size';
  }

  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(value?: number): string {
  if (!value || value <= 0) {
    return 'No duration';
  }
  return `${value.toFixed(1)} sec`;
}

function formatRunEventTime(iso: string): string {
  const value = new Date(iso);
  return value.toLocaleTimeString([], { hour12: false });
}

function actionTypeLabel(type: ProductionPlannedAction['type']): string {
  switch (type) {
    case 'image_generate':
      return 'Image';
    case 'stock_select':
      return 'Stock';
    case 'html_render':
      return 'HTML still';
    case 'video_submit':
      return 'Video';
    case 'video_poll':
      return 'Video Poll';
    case 'narration_generate':
      return 'Narration';
    case 'presenter_submit':
      return 'Presenter';
    case 'presenter_poll':
      return 'Presenter Poll';
    case 'scene_render':
      return 'Render';
    case 'final_compose':
      return 'Compose';
    default:
      return type;
  }
}

function actionStatusIcon(status: ProductionPlannedAction['status']): string {
  switch (status) {
    case 'current':
      return '✓';
    case 'ready':
      return '•';
    case 'running':
      return '⟳';
    case 'failed':
      return '⚠';
    case 'waiting_dependency':
      return '⏸';
    case 'blocked':
      return '⛔';
    case 'skipped':
      return '↷';
    default:
      return '•';
  }
}

function runStatusLabel(status: 'idle' | 'running' | ProductionRunnerResultStatus): string {
  switch (status) {
    case 'running':
      return 'Production running';
    case 'completed':
      return 'Production finished';
    case 'partial':
      return 'Production finished (partial)';
    case 'failed':
      return 'Production finished (failed)';
    case 'unresolved':
      return 'Production stopped (unresolved)';
    case 'idle':
    default:
      return 'Production idle';
  }
}

const COMPOSITION_PRESENTER_MODES: SceneCompositionPresenterMode[] = ['full_canvas', 'pip'];
const COMPOSITION_PIP_PRESETS: Array<SceneCompositionPipPresetName | 'custom'> = ['intro', 'news', 'custom'];
const LOGO_MODE_OPTIONS = ['inherit', 'custom', 'off'] as const;
type LogoMode = (typeof LOGO_MODE_OPTIONS)[number];

function presenterLayerOf(scene: Scene): SceneCompositionPresenterLayer | undefined {
  return scene.composition?.layers.find((layer): layer is SceneCompositionPresenterLayer => layer.type === 'presenter');
}

function presenterModeOf(scene: Scene): SceneCompositionPresenterMode {
  return presenterLayerOf(scene)?.mode ?? 'full_canvas';
}

function presenterPipPresetOf(scene: Scene): SceneCompositionPipPresetName | 'custom' {
  const layer = presenterLayerOf(scene);
  if (layer?.mode !== 'pip') {
    return 'intro';
  }
  return layer.pipPreset ?? 'custom';
}

function ensureStudioComposition(scene: Scene): NonNullable<Scene['composition']> {
  if (scene.composition?.preset === 'studio') {
    return {
      ...scene.composition,
      layers: scene.composition.layers.slice()
    };
  }
  return createStudioComposition({
    presenterMode: 'full_canvas',
    overlayEnabled: false
  });
}

function withPresenterLayer(scene: Scene, updater: (layer: SceneCompositionPresenterLayer, canvas: SceneCompositionCanvas) => SceneCompositionPresenterLayer): Scene {
  const composition = ensureStudioComposition(scene);
  const canvas = composition.canvas ?? STUDIO_COMPOSITION_CANVAS;
  const existing = composition.layers.find((layer): layer is SceneCompositionPresenterLayer => layer.type === 'presenter');
  const current: SceneCompositionPresenterLayer = existing ?? {
    id: STUDIO_LAYER_IDS.presenter,
    type: 'presenter',
    enabled: true,
    zIndex: 20,
    mode: 'full_canvas',
    rect: { x: 0, y: 0, width: canvas.width, height: canvas.height },
    fit: 'contain'
  };
  const next = updater(current, canvas);
  const index = composition.layers.findIndex((layer) => layer.id === next.id || layer.type === 'presenter');
  const layers = composition.layers.slice();
  if (index >= 0) {
    layers[index] = next;
  } else {
    layers.push(next);
  }
  return { ...scene, composition: { ...composition, layers } };
}

function logoModeOf(scene: Scene): LogoMode {
  if (scene.logo === null) {
    return 'off';
  }
  if (scene.logo) {
    return 'custom';
  }
  return 'inherit';
}

function defaultLogoSpec(assetId = ''): LogoOverlaySpec {
  return { assetId, position: 'bottom_right', scale: 0.15 };
}

function animationDestinationOf(asset: { metadata?: { animationDestination?: string | number | boolean | null } }): AnimationDestination | undefined {
  return asset.metadata?.animationDestination === 'overlay' || asset.metadata?.animationDestination === 'bigscreen'
    ? asset.metadata.animationDestination
    : undefined;
}

function attachedAnimationLayer(scene: Scene): { destination: AnimationDestination; assetId?: string } | null {
  const overlay = scene.composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.overlay && layer.type === 'overlay' && layer.enabled !== false);
  if (overlay && 'assetId' in overlay && overlay.assetId) {
    return { destination: 'overlay', assetId: overlay.assetId };
  }
  const image = scene.composition?.layers.find((layer) => layer.id === STUDIO_LAYER_IDS.image && layer.type === 'image' && layer.enabled !== false);
  if (image && 'assetId' in image && image.assetId) {
    return { destination: 'bigscreen', assetId: image.assetId };
  }
  return null;
}

export function ProjectWorkspace({ project }: ProjectWorkspaceProps) {
  const [draft, setDraft] = useState<Project>(() => cloneProject(project));
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('story');
  const [selectedSceneId, setSelectedSceneId] = useState(project.scenes[0]?.id ?? '');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [selectedReferenceId, setSelectedReferenceId] = useState('');
  const [storyFocusArea, setStoryFocusArea] = useState<StoryFocusArea | null>(null);
  const [storyFocusRequestId, setStoryFocusRequestId] = useState(0);
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('all');
  const [assetQuery, setAssetQuery] = useState('');
  const [referenceQuery, setReferenceQuery] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [renderMessage, setRenderMessage] = useState('');
  const [renderingSceneId, setRenderingSceneId] = useState<string | null>(null);
  const [lastRender, setLastRender] = useState<{ renderId: string; outputPath: string } | null>(null);
  const [compositionMessage, setCompositionMessage] = useState('');
  const [composingProject, setComposingProject] = useState(false);
  const [compositionFailed, setCompositionFailed] = useState(false);
  const [lastComposition, setLastComposition] = useState<{ compositionId: string; outputPath: string } | null>(null);
  const [assetMessage, setAssetMessage] = useState('');
  const [referenceMessage, setReferenceMessage] = useState('');
  const [generationMessage, setGenerationMessage] = useState('');
  const [narrationMessage, setNarrationMessage] = useState('');
  const [narratingSceneId, setNarratingSceneId] = useState<string | null>(null);
  const [generatingSceneId, setGeneratingSceneId] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchSummary, setBatchSummary] = useState<{ running: number; completed: number; failed: number; waiting: number }>({ running: 0, completed: 0, failed: 0, waiting: 0 });
  const [batchOutcome, setBatchOutcome] = useState<'idle' | 'running' | ProductionRunnerResultStatus>('idle');
  const [batchMessage, setBatchMessage] = useState('');
  const [batchFailedActionIds, setBatchFailedActionIds] = useState<string[]>([]);
  const [batchEvents, setBatchEvents] = useState<ProductionRunnerEvent[]>([]);
  const [batchLogOpen, setBatchLogOpen] = useState(false);
  const [batchCopyState, setBatchCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [providerStatus, setProviderStatus] = useState<{ defaultProvider: string } | null>(null);
  const [stockSearching, setStockSearching] = useState(false);
  const [stockSelectingId, setStockSelectingId] = useState<string | null>(null);
  const [stockMessage, setStockMessage] = useState('');
  const [stockSearch, setStockSearch] = useState<StockSearchState | null>(null);
  const [animationTemplates, setAnimationTemplates] = useState<AnimationTemplateSummary[]>([]);
  const [animationTemplateId, setAnimationTemplateId] = useState<(typeof ANIMATION_TEMPLATE_IDS)[number]>('northwind_arr_chart');
  const [animationAssetId, setAnimationAssetId] = useState('');
  const [animationDestination, setAnimationDestination] = useState<AnimationDestination>('bigscreen');
  const [animationBusy, setAnimationBusy] = useState(false);
  const [animationMessage, setAnimationMessage] = useState('');
  const isVideoPollingRef = useRef(false);
  const batchCopyResetTimerRef = useRef<number | null>(null);
  const produceFollowActiveRef = useRef(false);
  const produceTrackerRef = useRef<ProductionRunTracker | null>(null);

  const [newReferenceName, setNewReferenceName] = useState('Main Character');
  const [newReferenceDescription, setNewReferenceDescription] = useState('');
  const [newReferenceTags, setNewReferenceTags] = useState('');

  const sceneAssetFileInput = useRef<HTMLInputElement | null>(null);
  const libraryAssetFileInput = useRef<HTMLInputElement | null>(null);

  const selectedScene = useMemo(
    () => draft.scenes.find((scene) => scene.id === selectedSceneId) ?? draft.scenes[0] ?? null,
    [draft.scenes, selectedSceneId]
  );

  const selectedAsset = useMemo(() => draft.assets.find((asset) => asset.id === selectedAssetId) ?? null, [draft.assets, selectedAssetId]);
  const selectedReference = useMemo(() => draft.references.find((reference) => reference.id === selectedReferenceId) ?? null, [draft.references, selectedReferenceId]);

  const validation = validateProject(draft);
  const renderPlan = resolveRenderPlan(draft);
  const generationTasks = deriveGenerationTasks(draft);
  const compositionReadiness = useMemo(() => deriveCompositionReadiness(draft, renderPlan, renderingSceneId ? [renderingSceneId] : []), [draft, renderPlan, renderingSceneId]);
  const finalCompositionStatus = useMemo(() => deriveCompositionArtifactStatus(draft, renderPlan), [draft, renderPlan]);
  const workflow = useMemo(() => deriveWorkflowStatus(draft, {
    generatingSceneIds: generatingSceneId ? [generatingSceneId] : [],
    narratingSceneIds: narratingSceneId ? [narratingSceneId] : [],
    renderingSceneIds: renderingSceneId ? [renderingSceneId] : [],
    composing: composingProject,
    compositionFailed
  }), [draft, generatingSceneId, narratingSceneId, renderingSceneId, composingProject, compositionFailed]);
  const productionPlan = useMemo(() => deriveProductionPlan(draft, {
    failedActionIds: batchFailedActionIds,
    runtime: {
      runningGenerationSceneIds: generatingSceneId ? [generatingSceneId] : [],
      runningNarrationSceneIds: narratingSceneId ? [narratingSceneId] : [],
      runningRenderSceneIds: renderingSceneId ? [renderingSceneId] : [],
      composing: composingProject
    }
  }), [draft, batchFailedActionIds, generatingSceneId, narratingSceneId, renderingSceneId, composingProject]);
  const productionSceneGroups = useMemo(() => groupProductionActionsByScene(productionPlan), [productionPlan]);
  const liveActivityRows = useMemo(() => {
    return productionSceneGroups
      .flatMap((group) => group.actions.map((action) => ({
        id: action.id,
        text: `Scene ${group.sceneOrder} · ${actionTypeLabel(action.type)}`,
        status: action.status,
        reason: action.reason
      })))
      .filter((entry) => entry.status !== 'ready')
      .slice(0, 10);
  }, [productionSceneGroups]);
  const recentRunnerEvents = useMemo(() => {
    return batchEvents
      .filter((event) => event.code !== 'plan_created')
      .slice(-10)
      .reverse();
  }, [batchEvents]);
  const activeWorkflowStepId = useMemo(() => deriveActiveWorkflowStepId(workflow, activeTab), [workflow, activeTab]);
  const videoModelHints = useMemo(
    () =>
      selectedScene?.visual &&
      (selectedScene.visual.kind === 'generated_video' || selectedScene.visual.kind === 'generated_image')
        ? resolveVideoModelAuthoringHints(selectedScene.visual.generation.provider)
        : resolveVideoModelAuthoringHints(undefined),
    [selectedScene]
  );
  const selectedSceneRenderStatus = useMemo(() => selectedScene ? deriveSceneRenderStatus(draft, selectedScene, renderPlan, { isRendering: renderingSceneId === selectedScene.id }) : null, [draft, selectedScene, renderPlan, renderingSceneId]);
  const activeVideoAttemptIds = useMemo(() => {
    return draft.scenes
      .flatMap((scene) => {
        if (!scene.visual || scene.visual.kind !== 'generated_video') {
          return [];
        }

        const status = scene.visual.generation.status;
        if (status !== 'queued' && status !== 'generating') {
          return [];
        }

        return [scene.visual.generation.id];
      });
  }, [draft.scenes]);

  useEffect(() => {
    void (async () => {
      const response = await fetch('/api/image-generation/status');
      const body = (await response.json().catch(() => null)) as { defaultProvider: string } | null;
      if (response.ok && body) {
        setProviderStatus(body);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const response = await fetch('/api/animation-templates');
      const body = (await response.json().catch(() => null)) as { templates?: AnimationTemplateSummary[] } | null;
      if (response.ok && body?.templates) {
        setAnimationTemplates(body.templates);
      }
    })();
  }, []);

  useEffect(() => {
    const latest = (draft.compositions ?? [])[0];
    if (latest) {
      setLastComposition({ compositionId: latest.compositionId, outputPath: latest.outputPath });
    }
  }, [draft.compositions]);

  useEffect(() => {
    const latest = selectedScene ? (selectedScene.renders ?? []).find((entry) => entry.status === 'completed') : undefined;
    if (latest) {
      setLastRender({ renderId: latest.renderId, outputPath: latest.outputPath });
    }
  }, [selectedScene]);

  useEffect(() => {
    return () => {
      produceFollowActiveRef.current = false;
      produceTrackerRef.current?.invalidate();
      if (batchCopyResetTimerRef.current) {
        window.clearTimeout(batchCopyResetTimerRef.current);
      }
    };
  }, []);

  const filteredAssets = useMemo(() => {
    return draft.assets.filter((asset) => {
      const byText = asset.filename.toLowerCase().includes(assetQuery.toLowerCase().trim());
      if (!byText) {
        return false;
      }
      switch (assetFilter) {
        case 'images':
          return assetTypeGroup(asset.type) === 'images';
        case 'video':
          return assetTypeGroup(asset.type) === 'video';
        case 'audio':
          return assetTypeGroup(asset.type) === 'audio';
        case 'generated':
          return asset.provenance === 'generated';
        case 'imported':
          return asset.provenance === 'imported';
        case 'all':
        default:
          return true;
      }
    });
  }, [draft.assets, assetFilter, assetQuery]);

  const filteredReferences = useMemo(() => {
    const query = referenceQuery.toLowerCase().trim();
    if (!query) {
      return draft.references;
    }
    return draft.references.filter((reference) => {
      return (
        reference.name.toLowerCase().includes(query) ||
        reference.description.toLowerCase().includes(query) ||
        reference.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    });
  }, [draft.references, referenceQuery]);

  const audioAssets = useMemo(() => {
    return draft.assets.filter((asset) => asset.type === 'audio' || asset.type === 'music' || asset.type === 'voice');
  }, [draft.assets]);

  const logoAssets = useMemo(() => {
    return draft.assets.filter((asset) => asset.type === 'image' || asset.type === 'graphic');
  }, [draft.assets]);

  const animationAssets = useMemo(() => {
    return draft.assets.filter((asset) => Boolean(animationDestinationOf(asset)));
  }, [draft.assets]);

  const animationTemplateOptions = useMemo(
    () => (animationTemplates.length > 0 ? animationTemplates.map((template) => template.id) : [...ANIMATION_TEMPLATE_IDS]),
    [animationTemplates]
  );

  const animationTemplateLabels = useMemo(() => {
    const labels: Record<string, string> = {
      northwind_arr_chart: 'Northwind ARR chart',
      nix_overlay: 'Nix overlay'
    };
    for (const template of animationTemplates) {
      labels[template.id] = template.title;
    }
    return labels;
  }, [animationTemplates]);

  const hasNarrationAudioInProject = useMemo(() => {
    return draft.scenes.some((scene) => Boolean(scene.narration?.audioAssetId));
  }, [draft.scenes]);

  function updateProject(nextProject: Project): void {
    setDraft({ ...nextProject, updatedAt: new Date().toISOString() });
    setSaveMessage('');
  }

  function requestStoryFocus(area: StoryFocusArea): void {
    setStoryFocusArea(area);
    setStoryFocusRequestId((current) => current + 1);
  }

  function navigateFromWorkflow(target: WorkflowNavigationTarget, stepId?: WorkflowStepId): void {
    setActiveTab(target);

    if (!stepId) {
      return;
    }

    if (stepId === 'brief') {
      requestStoryFocus('brief');
      return;
    }

    if (stepId === 'story') {
      requestStoryFocus('story');
      return;
    }

    if (stepId === 'scene_plan') {
      requestStoryFocus('scene_plan');
    }
  }

  function updateScene(sceneId: string, updater: (scene: Scene) => Scene): void {
    updateProject({
      ...draft,
      scenes: draft.scenes.map((scene) => (scene.id === sceneId ? updater(scene) : scene))
    });
  }

  // The generation service prefers `generation.referenceIds` (a per-attempt
  // snapshot) and only falls back to `scene.referenceIds`. The inspector edits the
  // scene-level list, so this keeps both in sync and drops any start/end frame
  // designation whose reference has been removed (which would otherwise be
  // rejected later as `frameInvalid`).
  function setSceneReferences(sceneId: string, nextReferenceIds: string[]): void {
    updateScene(sceneId, (scene) => {
      const visual = scene.visual;
      let nextVisual = visual;
      if (visual && (visual.kind === 'generated_image' || visual.kind === 'generated_video')) {
        const generation = visual.generation;
        const startFrameReferenceId = generation.startFrameReferenceId;
        const endFrameReferenceId = generation.endFrameReferenceId;
        nextVisual = {
          ...visual,
          generation: {
            ...generation,
            referenceIds: nextReferenceIds,
            startFrameReferenceId: startFrameReferenceId && nextReferenceIds.includes(startFrameReferenceId) ? startFrameReferenceId : undefined,
            endFrameReferenceId: endFrameReferenceId && nextReferenceIds.includes(endFrameReferenceId) ? endFrameReferenceId : undefined
          }
        };
      }
      return { ...scene, referenceIds: nextReferenceIds, visual: nextVisual };
    });
  }

  function setSceneFrame(sceneId: string, role: 'start' | 'end', referenceId: string): void {
    updateScene(sceneId, (scene) => {
      if (!scene.visual || scene.visual.kind !== 'generated_video') {
        return scene;
      }
      const generation = scene.visual.generation;
      // `scene.referenceIds` is the canonical, user-visible selection. The
      // generation snapshot can be stale, so it must never be used as the base
      // here: doing so could drop references (and the frames that use them). This
      // only ever adds the chosen reference and otherwise mirrors the scene list.
      const base = scene.referenceIds;
      const nextReferenceIds = referenceId && !base.includes(referenceId) ? [...base, referenceId] : base;
      return {
        ...scene,
        referenceIds: nextReferenceIds,
        visual: {
          ...scene.visual,
          generation: {
            ...generation,
            referenceIds: nextReferenceIds,
            startFrameReferenceId: role === 'start' ? referenceId || undefined : generation.startFrameReferenceId,
            endFrameReferenceId: role === 'end' ? referenceId || undefined : generation.endFrameReferenceId
          }
        }
      };
    });
  }

  function referenceName(referenceId: string): string {
    return draft.references.find((entry) => entry.id === referenceId)?.name ?? referenceId;
  }

  function updateOverlay(sceneId: string, updater: (overlay: OverlaySpec) => OverlaySpec): void {
    updateScene(sceneId, (scene) => ({ ...scene, overlay: updater(scene.overlay ?? { type: 'none' }) }));
  }

  function updatePresenterMode(sceneId: string, mode: SceneCompositionPresenterMode): void {
    updateScene(sceneId, (scene) => withPresenterLayer(scene, (layer, canvas) => {
      if (mode === 'full_canvas') {
        return {
          id: layer.id,
          type: 'presenter',
          enabled: true,
          zIndex: layer.zIndex,
          mode: 'full_canvas',
          rect: { x: 0, y: 0, width: canvas.width, height: canvas.height },
          fit: layer.fit ?? 'contain'
        };
      }
      const pipPreset = layer.pipPreset ?? 'intro';
      return {
        id: layer.id,
        type: 'presenter',
        enabled: true,
        zIndex: layer.zIndex,
        mode: 'pip',
        pipPreset,
        rect: resolveStudioPipRect(canvas, pipPreset),
        fit: layer.fit ?? 'contain'
      };
    }));
  }

  function updatePresenterPipPreset(sceneId: string, preset: SceneCompositionPipPresetName | 'custom'): void {
    updateScene(sceneId, (scene) => withPresenterLayer(scene, (layer, canvas) => {
      if (preset === 'custom') {
        const scale = layer.scale ?? STUDIO_PRESENTER_PIP_SCALE;
        const offsetX = layer.offsetX ?? STUDIO_PRESENTER_PIP_OFFSET_X;
        const offsetY = layer.offsetY ?? STUDIO_PRESENTER_PIP_OFFSET_Y;
        return {
          id: layer.id,
          type: 'presenter',
          enabled: true,
          zIndex: layer.zIndex,
          mode: 'pip',
          scale,
          offsetX,
          offsetY,
          rect: resolveStudioPresenterRect(canvas, { scale, offsetX, offsetY }),
          fit: layer.fit ?? 'contain'
        };
      }
      return {
        id: layer.id,
        type: 'presenter',
        enabled: true,
        zIndex: layer.zIndex,
        mode: 'pip',
        pipPreset: preset,
        rect: resolveStudioPipRect(canvas, preset),
        fit: layer.fit ?? 'contain'
      };
    }));
  }

  function updateLogo(sceneId: string, updater: (logo: LogoOverlaySpec | null | undefined) => LogoOverlaySpec | null | undefined): void {
    updateScene(sceneId, (scene) => ({ ...scene, logo: updater(scene.logo) }));
  }

  async function renderMotionCanvasTemplate(): Promise<void> {
    if (animationBusy) {
      return;
    }
    setAnimationBusy(true);
    setAnimationMessage('Rendering Motion Canvas template...');
    const saved = await saveProject();
    if (!saved) {
      setAnimationBusy(false);
      setAnimationMessage('Could not save project before animation render.');
      return;
    }
    const response = await fetch(`/api/projects/${draft.id}/animations/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: animationTemplateId })
    });
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      assetId?: string;
      destination?: AnimationDestination;
      templateId?: string;
    };
    if (!response.ok) {
      setAnimationBusy(false);
      setAnimationMessage(body.message || 'Could not render animation template.');
      return;
    }
    if (body.assetId) {
      setAnimationAssetId(body.assetId);
    }
    if (body.destination) {
      setAnimationDestination(body.destination);
    }
    await refreshProject();
    setAnimationBusy(false);
    setAnimationMessage(`Rendered ${body.templateId ?? animationTemplateId}. Attach it to this scene next.`);
  }

  async function attachMotionCanvasAnimation(sceneId: string): Promise<void> {
    if (animationBusy) {
      return;
    }
    if (!animationAssetId) {
      setAnimationMessage('Select a rendered animation asset before attaching.');
      return;
    }
    setAnimationBusy(true);
    setAnimationMessage('Attaching animation to scene...');
    const saved = await saveProject();
    if (!saved) {
      setAnimationBusy(false);
      setAnimationMessage('Could not save project before animation attach.');
      return;
    }
    const response = await fetch(`/api/projects/${draft.id}/scenes/${sceneId}/animations/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: animationAssetId,
        destination: animationDestination
      })
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string; destination?: AnimationDestination };
    if (!response.ok) {
      setAnimationBusy(false);
      setAnimationMessage(body.message || 'Could not attach animation to scene.');
      await refreshProject();
      return;
    }
    await refreshProject();
    setAnimationBusy(false);
    setAnimationMessage(`Attached as ${body.destination ?? animationDestination}.`);
  }

  function addScene(): void {
    updateProject({
      ...draft,
      scenes: [...draft.scenes, defaultScene(draft.scenes.length + 1)]
    });
  }

  function setVisualMode(scene: Scene, mode: VisualMode): void {
    updateScene(scene.id, (current) => {
      const visual = ensureVisualForMode(current, mode);
      const type = mode === 'generated_video' ? 'video' : mode === 'graphic' ? 'graphic' : mode === 'html' ? 'html' : mode === 'text' ? 'text' : mode === 'blank' ? 'blank' : 'image';
      return {
        ...current,
        type,
        visual
      };
    });
  }

  function setAssetForScene(scene: Scene, assetId: string): void {
    updateScene(scene.id, (current) => {
      if (!current.visual) {
        return { ...current, visual: { kind: 'asset', assetId } };
      }

      if (current.visual.kind === 'asset') {
        return { ...current, visual: { ...current.visual, assetId: assetId || undefined } };
      }

      if (current.visual.kind === 'generated_image' || current.visual.kind === 'generated_video') {
        return {
          ...current,
          visual: {
            ...current.visual,
            assetId: assetId || undefined,
            generation: {
              ...current.visual.generation,
              assetId: assetId || undefined
            }
          }
        };
      }

      return current;
    });
  }

  async function saveProject(): Promise<boolean> {
    const response = await fetch(`/api/projects/${draft.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft)
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string; project?: Project };
    if (!response.ok) {
      setSaveMessage(body.message || 'Could not save project.');
      return false;
    }

    if (body.project) {
      setDraft(body.project);
    }
    setSaveMessage('Project saved locally.');
    return true;
  }

  async function refreshProject(): Promise<Project | null> {
    const response = await fetch(`/api/projects/${draft.id}`);
    const body = (await response.json().catch(() => ({}))) as { project?: Project; message?: string };
    if (!response.ok || !body.project) {
      setGenerationMessage(body.message || 'Could not refresh project state.');
      return null;
    }

    setDraft(body.project);
    return body.project;
  }

  async function runProduceReady(): Promise<void> {
    if (batchRunning) {
      return;
    }

    produceFollowActiveRef.current = true;
    setBatchRunning(true);
    setBatchOutcome('running');
    setBatchFailedActionIds([]);
    setBatchMessage('Saving project before production run...');
    setBatchSummary({ running: 0, completed: 0, failed: 0, waiting: 0 });
    setBatchEvents([]);

    try {
      const started = await startServerRunFlow({
        projectId: draft.id,
        ensureSaved: saveProject
      });

      if (!started.ok) {
        if (started.blockedBySave) {
          setBatchOutcome('failed');
          setBatchMessage('Could not save project before production run.');
          return;
        }

        setBatchOutcome('failed');
        setBatchMessage(started.error?.message || 'Could not start production run.');
        return;
      }

      const tracker = new ProductionRunTracker();
      produceTrackerRef.current = tracker;
      setBatchMessage(started.result.data.reused ? 'Reused active server run.' : 'Started production run...');

      const followed = await followServerRunFlow({
        run: started.result.data.run,
        tracker,
        shouldContinue: () => produceFollowActiveRef.current,
        onProgress: async (state) => {
          const run = state.run;
          if (run) {
            setBatchSummary({
              running: run.summary.running,
              completed: run.summary.completed,
              failed: run.summary.failed,
              waiting: run.summary.waiting
            });
            setBatchFailedActionIds(run.failedActionIds);
            setBatchOutcome(run.status === 'queued' || run.status === 'running' ? 'running' : run.status);
          }
          setBatchEvents(state.logItems.map((item) => item.event));
        }
      });

      const run = followed.state.run;
      if (run) {
        setBatchSummary({
          running: run.summary.running,
          completed: run.summary.completed,
          failed: run.summary.failed,
          waiting: run.summary.waiting
        });
        setBatchFailedActionIds(run.failedActionIds);
        setBatchOutcome(run.status === 'queued' || run.status === 'running' ? 'running' : run.status);
      }
      setBatchEvents(followed.state.logItems.map((item) => item.event));

      if (!followed.ok) {
        if (followed.kind === 'restart_lost') {
          setBatchOutcome('failed');
          setBatchMessage(followed.error?.message || 'Tracked server run was lost after a restart or memory expiry.');
        } else if (produceFollowActiveRef.current) {
          setBatchOutcome('failed');
          setBatchMessage(followed.error?.message || 'Production run stopped before completion.');
        }
      } else if (run?.status === 'completed') {
        setBatchMessage('Production finished successfully.');
      } else if (run?.status === 'partial') {
        setBatchMessage('Production finished with partial completion.');
      } else if (run?.status === 'failed') {
        setBatchMessage(`Production finished with failures (${run.failedActionIds.length}).`);
      } else if (run) {
        setBatchMessage(`Production stopped with unresolved actions (${run.unresolvedActions.length}).`);
      }

      await refreshProject();
    } catch (error) {
      setBatchOutcome('failed');
      setBatchMessage(error instanceof Error ? error.message : 'Production run failed unexpectedly.');
    } finally {
      produceFollowActiveRef.current = false;
      produceTrackerRef.current?.invalidate();
      produceTrackerRef.current = null;
      setBatchRunning(false);
    }
  }

  async function copyProductionLog(): Promise<void> {
    const text = formatProductionLogAsText({
      runStatus: batchOutcome,
      events: batchEvents,
      summary: {
        completed: batchSummary.completed,
        failed: batchSummary.failed,
        running: batchSummary.running,
        waiting: batchSummary.waiting
      }
    });

    try {
      await navigator.clipboard.writeText(text);
      setBatchCopyState('copied');
    } catch {
      setBatchCopyState('failed');
    }

    if (batchCopyResetTimerRef.current) {
      window.clearTimeout(batchCopyResetTimerRef.current);
    }

    batchCopyResetTimerRef.current = window.setTimeout(() => {
      setBatchCopyState('idle');
      batchCopyResetTimerRef.current = null;
    }, 1600);
  }

  async function runStockSearch(scene: Scene): Promise<void> {
    const visual = scene.visual;
    if (!visual || visual.kind !== 'stock_image') {
      return;
    }
    const query = visual.query.trim();
    if (!query) {
      setStockMessage('Enter a search term first.');
      return;
    }

    setStockSearching(true);
    setStockMessage('Searching stock providers...');

    const params = new URLSearchParams({ query });
    if (visual.orientation) {
      params.set('orientation', visual.orientation);
    }
    if (visual.preferredProviders && visual.preferredProviders.length > 0) {
      params.set('providers', visual.preferredProviders.join(','));
    }

    try {
      const response = await fetch(`/api/projects/${draft.id}/stock/search?${params.toString()}`);
      const body = (await response.json().catch(() => ({}))) as (StockSearchState & { message?: string });
      if (!response.ok) {
        setStockSearch(null);
        setStockMessage(body.message || 'Stock search failed.');
        return;
      }
      setStockSearch({
        sceneId: scene.id,
        searchId: body.searchId,
        query: body.query,
        orientation: body.orientation,
        cached: Boolean(body.cached),
        results: body.results ?? [],
        quota: body.quota ?? [],
        diagnostics: body.diagnostics ?? []
      });
      setStockMessage(
        body.results && body.results.length > 0
          ? `Found ${body.results.length} photo(s)${body.cached ? ' (cached)' : ''}.`
          : 'No matching stock photos.'
      );
    } catch {
      setStockSearch(null);
      setStockMessage('Stock search failed unexpectedly.');
    } finally {
      setStockSearching(false);
    }
  }

  async function chooseStockPhoto(scene: Scene, item: StockSearchResultItem): Promise<void> {
    if (!stockSearch) {
      return;
    }
    setStockSelectingId(item.id);
    setStockMessage(`Applying ${item.provider} photo...`);
    try {
      const response = await fetch(`/api/projects/${draft.id}/scenes/${scene.id}/select-stock-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'choose',
          searchId: stockSearch.searchId,
          photoId: item.id,
          query: stockSearch.query,
          orientation: stockSearch.orientation
        })
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string; provider?: string };
      if (!response.ok) {
        setStockMessage(body.message || 'Stock selection failed.');
        return;
      }
      setStockMessage(`Stock photo selected (${body.provider ?? item.provider}).`);
      setStockSearch(null);
      await refreshProject();
    } catch {
      setStockMessage('Stock selection failed unexpectedly.');
    } finally {
      setStockSelectingId(null);
    }
  }

  async function autoSelectStock(scene: Scene): Promise<void> {
    setStockMessage('Selecting best match...');
    try {
      const response = await fetch(`/api/projects/${draft.id}/scenes/${scene.id}/select-stock-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auto' })
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string; provider?: string };
      if (!response.ok) {
        setStockMessage(body.message || 'Stock selection failed.');
        return;
      }
      setStockMessage(`Stock photo selected (${body.provider ?? 'provider'}).`);
      setStockSearch(null);
      await refreshProject();
    } catch {
      setStockMessage('Stock selection failed unexpectedly.');
    }
  }

  async function runImageGeneration(sceneId: string, regenerate: boolean): Promise<void> {
    setGeneratingSceneId(sceneId);
    setGenerationMessage(regenerate ? 'Regenerating image...' : 'Generating image...');

    const response = await fetch(`/api/projects/${draft.id}/scenes/${sceneId}/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate })
    });

    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      sceneId?: string;
      status?: string;
      assetId?: string;
      generationAttemptId?: string;
      provider?: string;
      model?: string;
    };

    if (!response.ok) {
      setGenerationMessage(body.message || 'Image generation failed.');
      setGeneratingSceneId(null);
      await refreshProject();
      return;
    }

    setGenerationMessage(`Generation completed (${body.provider ?? 'provider'}${body.model ? ` / ${body.model}` : ''}).`);
    if (body.assetId) {
      setSelectedAssetId(body.assetId);
    }
    await refreshProject();
    setGeneratingSceneId(null);
  }

  async function runHtmlStill(sceneId: string, regenerate: boolean): Promise<void> {
    setGeneratingSceneId(sceneId);
    setGenerationMessage(regenerate ? 'Re-rendering HTML still...' : 'Rendering HTML still...');

    const response = await fetch(`/api/projects/${draft.id}/scenes/${sceneId}/render-html-still`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate })
    });

    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      assetId?: string;
    };

    if (!response.ok) {
      setGenerationMessage(body.message || 'HTML still render failed.');
      setGeneratingSceneId(null);
      await refreshProject();
      return;
    }

    setGenerationMessage(body.message || 'HTML still PNG rendered.');
    if (body.assetId) {
      setSelectedAssetId(body.assetId);
    }
    await refreshProject();
    setGeneratingSceneId(null);
  }

  async function runVideoGeneration(sceneId: string, regenerate: boolean): Promise<void> {
    setGeneratingSceneId(sceneId);
    setGenerationMessage(regenerate ? 'Submitting video regeneration job...' : 'Submitting video generation job...');

    // Forward the selection explicitly so a stored `fal`/`openai` provider is not
    // ignored. The mock sentinel `local` (and any other non-real value) is left
    // unset so the server keeps its existing mode-aware default (mock -> local,
    // real -> a real provider). This preserves the behaviour of pre-existing
    // scenes whose stored provider is the default `local` while still honouring an
    // explicit real selection and never silently downgrading a real provider.
    const scene = draft.scenes.find((entry) => entry.id === sceneId);
    const videoGeneration = scene?.visual && scene.visual.kind === 'generated_video' ? scene.visual.generation : undefined;
    const { provider, model } = resolveVideoProviderForwarding(videoGeneration);

    const response = await fetch(`/api/projects/${draft.id}/scenes/${sceneId}/generate-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate, provider, model })
    });

    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      code?: string;
      sceneId?: string;
      status?: string;
      generationAttemptId?: string;
      provider?: string;
      model?: string;
      providerJobId?: string;
      providerStatus?: string;
    };

    if (!response.ok) {
      console.error('Video generation submit failed', {
        httpStatus: response.status,
        code: body.code,
        message: body.message,
        sceneId,
        url: `/api/projects/${draft.id}/scenes/${sceneId}/generate-video`,
        at: new Date().toISOString()
      });
      setGenerationMessage(`Video generation failed [${response.status}]${body.code ? ` (${body.code})` : ''}: ${body.message || 'Unknown error'}`);
      setGeneratingSceneId(null);
      await refreshProject();
      return;
    }

    setGenerationMessage(`Video job submitted (${body.provider ?? 'provider'}${body.model ? ` / ${body.model}` : ''}) • ${body.status ?? 'queued'}.`);
    await refreshProject();
    setGeneratingSceneId(null);
  }

  async function cancelVideoGeneration(sceneId: string): Promise<void> {
    setGeneratingSceneId(sceneId);
    setGenerationMessage('Cancelling video generation job...');

    const response = await fetch(`/api/projects/${draft.id}/scenes/${sceneId}/cancel-video`, {
      method: 'POST'
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string; providerStatus?: string };

    if (!response.ok) {
      console.error('Video generation cancel failed', {
        httpStatus: response.status,
        code: body.code,
        message: body.message,
        sceneId,
        url: `/api/projects/${draft.id}/scenes/${sceneId}/cancel-video`,
        at: new Date().toISOString()
      });
      setGenerationMessage(`Cancel failed [${response.status}]${body.code ? ` (${body.code})` : ''}: ${body.message || 'Unknown error'}`);
      setGeneratingSceneId(null);
      await refreshProject();
      return;
    }

    setGenerationMessage(body.message || 'Video generation cancelled.');
    await refreshProject();
    setGeneratingSceneId(null);
  }

  async function runNarrationGeneration(scene: Scene, mode: 'generate' | 'regenerate' | 'retry'): Promise<void> {
    setNarratingSceneId(scene.id);
    setNarrationMessage(mode === 'generate' ? 'Generating narration...' : mode === 'regenerate' ? 'Regenerating narration...' : 'Retrying narration generation...');

    const result = await createSceneNarrationRequest(draft.id, scene.id, {
      text: scene.narration?.text,
      voiceId: scene.narration?.voiceId,
      model: scene.narration?.model,
      format: scene.narration?.format ?? 'mp3',
      regenerate: mode === 'regenerate',
      retry: mode === 'retry'
    });

    setNarrationMessage(result.message);
    if (result.narration?.assetId) {
      setSelectedAssetId(result.narration.assetId);
    }
    await refreshProject();
    setNarratingSceneId(null);
  }

  const pollVideoGenerationAttempt = useCallback(async (attemptId: string): Promise<void> => {
    const response = await fetch(`/api/projects/${draft.id}/generation-jobs/${attemptId}`);
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      code?: string;
      status?: string;
      providerStatus?: string;
      generationAttemptId?: string;
    };

    if (!response.ok) {
      console.error('Video generation poll failed', {
        httpStatus: response.status,
        code: body.code,
        message: body.message,
        attemptId,
        url: `/api/projects/${draft.id}/generation-jobs/${attemptId}`,
        at: new Date().toISOString()
      });
      setGenerationMessage(`Video poll failed [${response.status}]${body.code ? ` (${body.code})` : ''}: ${body.message || 'Unknown error'}`);
      return;
    }

    if (body.status) {
      setGenerationMessage(`Video job ${body.generationAttemptId ?? attemptId}: ${body.status}${body.providerStatus ? ` (${body.providerStatus})` : ''}.`);
    }
  }, [draft.id]);

  useEffect(() => {
    if (activeVideoAttemptIds.length === 0) {
      return;
    }

    const poll = () => {
      if (isVideoPollingRef.current) {
        return;
      }
      isVideoPollingRef.current = true;

      void (async () => {
        try {
          await Promise.all(activeVideoAttemptIds.map((attemptId) => pollVideoGenerationAttempt(attemptId)));

          const response = await fetch(`/api/projects/${draft.id}`);
          const body = (await response.json().catch(() => ({}))) as { project?: Project; message?: string };
          if (response.ok && body.project) {
            setDraft(body.project);
          } else if (!response.ok) {
            setGenerationMessage(body.message || 'Could not refresh project state.');
          }
        } finally {
          isVideoPollingRef.current = false;
        }
      })();
    };

    let timer: number | null = null;
    const startPolling = () => {
      if (timer !== null) {
        return;
      }
      poll();
      timer = window.setInterval(poll, 5000);
    };
    const stopPolling = () => {
      if (timer === null) {
        return;
      }
      window.clearInterval(timer);
      timer = null;
    };

    if (!isHidden(typeof document !== 'undefined' ? document.visibilityState : undefined)) {
      startPolling();
    }

    const unsubscribe = subscribeToVisibility((hidden) => {
      if (hidden) {
        stopPolling();
      } else {
        startPolling();
      }
    });

    return () => {
      stopPolling();
      unsubscribe();
    };
  }, [activeVideoAttemptIds, draft.id, pollVideoGenerationAttempt]);

  async function renderProject(): Promise<void> {
    const saved = await saveProject();
    if (!saved) {
      setRenderMessage('Could not save project before rendering.');
      return;
    }

    const scene = selectedScene ?? draft.scenes[0];
    if (!scene) {
      setRenderMessage('No scene available to render.');
      return;
    }

    setRenderingSceneId(scene.id);
    setRenderMessage('Rendering scene...');
    const result = await createSceneRenderRequest(draft.id, scene.id);
    if (!result.ok) {
      console.error('Scene render failed', {
        code: result.code,
        details: result.details,
        sceneId: scene.id,
        url: `/api/projects/${draft.id}/scenes/${scene.id}/render`,
        at: new Date().toISOString()
      });
      setRenderMessage(`${result.message}${result.code ? ` (${result.code})` : ''}`);
      await refreshProject();
      setRenderingSceneId(null);
      return;
    }

    setRenderMessage(result.message);
    if (result.render) {
      setLastRender(result.render);
    }
    await refreshProject();
    setRenderingSceneId(null);
  }

  async function composeProjectVideo(): Promise<void> {
    const saved = await saveProject();
    if (!saved) {
      setCompositionMessage('Could not save project before composition.');
      return;
    }

    if (!compositionReadiness.canCompose) {
      const blockingScene = draft.scenes.find((scene) => compositionReadiness.blockingSceneIds.includes(scene.id));
      setCompositionMessage(blockingScene ? `Scene ${blockingScene.order} has blocking issues. Open the scene to fix it first.` : 'Project is not ready for composition.');
      return;
    }

    setComposingProject(true);
    setCompositionFailed(false);
    const pendingRenders = compositionReadiness.needsSceneRenderIds.length + compositionReadiness.staleSceneIds.length;
    setCompositionMessage(pendingRenders > 0 ? `Rendering ${pendingRenders} scene${pendingRenders === 1 ? '' : 's'} and composing final video...` : 'Composing project video...');

    const result = await createProjectCompositionRequest(draft.id);
    if (!result.ok) {
      console.error('Project composition failed', {
        code: result.code,
        details: result.details,
        url: `/api/projects/${draft.id}/compose`,
        at: new Date().toISOString()
      });
      setCompositionMessage(`${result.message}${result.code ? ` (${result.code})` : ''}`);
      setCompositionFailed(true);
      await refreshProject();
      setComposingProject(false);
      return;
    }

    setCompositionMessage(result.message);
    setCompositionFailed(false);
    if (result.composition) {
      setLastComposition(result.composition);
    }

    await refreshProject();
    setComposingProject(false);
  }

  async function importAsset(file: File, assignToScene = false): Promise<void> {
    const formData = new FormData();
    formData.set('file', file);

    const response = await fetch(`/api/projects/${draft.id}/assets`, {
      method: 'POST',
      body: formData
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string; asset?: Project['assets'][number] };
    if (!response.ok || !body.asset) {
      setAssetMessage(body.message || 'Could not import asset.');
      return;
    }

    updateProject({
      ...draft,
      assets: [...draft.assets, body.asset]
    });
    setSelectedAssetId(body.asset.id);
    setAssetMessage(`Imported ${body.asset.filename}.`);

    if (assignToScene && selectedScene) {
      setAssetForScene(selectedScene, body.asset.id);
    }
  }

  function setHtmlStillSlotImage(sceneId: string, assetId: string | undefined, productIndex?: number): void {
    updateScene(sceneId, (scene) => {
      if (!scene.visual || scene.visual.kind !== 'html') {
        return scene;
      }
      return {
        ...scene,
        visual: {
          ...scene.visual,
          templateData: applyHtmlStillSlotImage(scene.visual.templateData, assetId, productIndex)
        }
      };
    });
  }

  async function importHtmlStillSlotImage(sceneId: string, file: File, productIndex?: number): Promise<void> {
    const formData = new FormData();
    formData.set('file', file);

    const response = await fetch(`/api/projects/${draft.id}/assets`, {
      method: 'POST',
      body: formData
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string; asset?: Project['assets'][number] };
    if (!response.ok || !body.asset) {
      setAssetMessage(body.message || 'Could not import asset.');
      return;
    }

    const nextAssets = [...draft.assets, body.asset];
    setSelectedAssetId(body.asset.id);
    if (!isHtmlStillSlotImageAsset(body.asset)) {
      setAssetMessage('Imported file is not a PNG, JPEG, or WebP image.');
      updateProject({ ...draft, assets: nextAssets });
      return;
    }
    setAssetMessage(`Imported ${body.asset.filename}.`);
    updateProject({
      ...draft,
      assets: nextAssets,
      scenes: draft.scenes.map((scene) => {
        if (scene.id !== sceneId || scene.visual?.kind !== 'html') {
          return scene;
        }
        return {
          ...scene,
          visual: {
            ...scene.visual,
            templateData: applyHtmlStillSlotImage(scene.visual.templateData, body.asset!.id, productIndex)
          }
        };
      })
    });
  }

  async function deleteSelectedAsset(): Promise<void> {
    if (!selectedAsset) {
      return;
    }
    const response = await fetch(`/api/projects/${draft.id}/assets/${selectedAsset.id}`, { method: 'DELETE' });
    const body = (await response.json().catch(() => ({}))) as { message?: string; usageSceneIds?: string[] };
    if (!response.ok) {
      setAssetMessage(body.message || 'Could not delete asset.');
      return;
    }

    updateProject({
      ...draft,
      assets: draft.assets.filter((asset) => asset.id !== selectedAsset.id)
    });
    setSelectedAssetId('');
    setAssetMessage('Asset deleted.');
  }

  async function importReference(file: File): Promise<void> {
    const formData = new FormData();
    formData.set('file', file);
    formData.set('name', newReferenceName);
    formData.set('description', newReferenceDescription);
    formData.set('tags', newReferenceTags);

    const response = await fetch(`/api/projects/${draft.id}/references`, {
      method: 'POST',
      body: formData
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string; reference?: ReferenceImage };
    if (!response.ok || !body.reference) {
      setReferenceMessage(body.message || 'Could not import reference.');
      return;
    }

    updateProject({
      ...draft,
      references: [...draft.references, body.reference]
    });
    setSelectedReferenceId(body.reference.id);
    setReferenceMessage(`Imported reference ${body.reference.name}.`);
  }

  async function saveReferenceDetails(reference: ReferenceImage, fields: { name: string; description: string; tags: string[] }): Promise<void> {
    const response = await fetch(`/api/projects/${draft.id}/references/${reference.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields)
    });

    const body = (await response.json().catch(() => ({}))) as { message?: string; reference?: ReferenceImage };
    if (!response.ok || !body.reference) {
      setReferenceMessage(body.message || 'Could not update reference.');
      return;
    }

    updateProject({
      ...draft,
      references: draft.references.map((entry) => (entry.id === reference.id ? body.reference as ReferenceImage : entry))
    });
    setReferenceMessage('Reference updated.');
  }

  async function deleteSelectedReference(): Promise<void> {
    if (!selectedReference) {
      return;
    }

    const response = await fetch(`/api/projects/${draft.id}/references/${selectedReference.id}`, { method: 'DELETE' });
    const body = (await response.json().catch(() => ({}))) as { message?: string; usageSceneIds?: string[] };
    if (!response.ok) {
      setReferenceMessage(body.message || 'Could not delete reference.');
      return;
    }

    updateProject({
      ...draft,
      references: draft.references.filter((entry) => entry.id !== selectedReference.id)
    });
    setSelectedReferenceId('');
    setReferenceMessage('Reference deleted.');
  }

  return (
    <div className="space-y-6">
      <header className="studio-panel rounded-[28px] p-4 shadow-panel">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-slate-500">Project editor</p>
            <input
              value={draft.title}
              onChange={(event) => updateProject({ ...draft, title: event.target.value })}
              className="w-full rounded-2xl border border-slate-700/70 bg-slate-950/35 px-4 py-3 text-3xl font-semibold text-white outline-none ring-0 transition focus:border-amber-300/50"
            />
            <textarea
              value={draft.description}
              onChange={(event) => updateProject({ ...draft, description: event.target.value })}
              className="min-h-24 w-full rounded-2xl border border-slate-700/70 bg-slate-950/35 px-4 py-3 text-sm text-slate-200 outline-none transition focus:border-amber-300/50"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3 xl:w-[420px]">
            <Field label="Target duration" value={draft.durationTarget} onChange={(value) => updateProject({ ...draft, durationTarget: Number(value) })} type="number" />
            <Field label="FPS" value={draft.fps} onChange={(value) => updateProject({ ...draft, fps: Number(value) })} type="number" />
            <SelectField label="Aspect ratio" value={draft.aspectRatio} onChange={(value) => updateProject({ ...draft, aspectRatio: value as Project['aspectRatio'] })} options={ASPECT_RATIOS} />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" onClick={addScene} className="rounded-2xl border border-slate-700 bg-slate-950/50 px-4 py-2 text-sm text-slate-200">Add scene</button>
          <button type="button" onClick={() => void saveProject()} className="rounded-2xl bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950">Save project</button>
          <button type="button" disabled={Boolean(renderingSceneId && selectedScene?.id === renderingSceneId)} onClick={() => void renderProject()} className="rounded-2xl border border-amber-300/40 bg-amber-200/10 px-4 py-2 text-sm text-amber-100 disabled:opacity-60">{renderingSceneId && selectedScene?.id === renderingSceneId ? 'Rendering Scene...' : 'Render Scene'}</button>
          <button
            type="button"
            disabled={composingProject || !compositionReadiness.canCompose}
            onClick={() => void composeProjectVideo()}
            className="rounded-2xl border border-emerald-400/40 bg-emerald-300/10 px-4 py-2 text-sm text-emerald-100 disabled:opacity-60"
          >
            {composingProject ? 'Rendering / Composing...' : `Render / Compose Video (${compositionReadiness.totalScenes})`}
          </button>
          {lastRender ? (
            <button
              type="button"
              onClick={() => {
                window.open(`/api/projects/${draft.id}/renders/${lastRender.renderId}/file`, '_blank');
              }}
              className="rounded-2xl border border-slate-700 bg-slate-950/50 px-4 py-2 text-sm text-slate-200"
            >
              Open Render
            </button>
          ) : null}
          {lastComposition ? (
            <button
              type="button"
              onClick={() => {
                window.open(`/api/projects/${draft.id}/compositions/${lastComposition.compositionId}/file`, '_blank');
              }}
              className="rounded-2xl border border-slate-700 bg-slate-950/50 px-4 py-2 text-sm text-slate-200"
            >
              Open Final Video
            </button>
          ) : null}
          {saveMessage ? <span className="self-center text-sm text-emerald-300">{saveMessage}</span> : null}
          {renderMessage ? <span className="self-center text-sm text-slate-300">{renderMessage}</span> : null}
          {narrationMessage ? <span className="self-center text-sm text-slate-300">{narrationMessage}</span> : null}
          <span className="self-center text-sm text-slate-300">{hasNarrationAudioInProject ? 'Composition includes narration audio where available.' : 'Composition will be silent unless scene narration audio is linked.'}</span>
          {compositionReadiness.blockingSceneIds.length > 0 ? <span className="self-center text-sm text-amber-200">{compositionReadiness.blockingSceneIds.length} scene(s) have blocking validation issues.</span> : null}
          {compositionReadiness.needsSceneRenderIds.length > 0 ? <span className="self-center text-sm text-slate-300">{compositionReadiness.needsSceneRenderIds.length} scene(s) still need a first render.</span> : null}
          {compositionReadiness.staleSceneIds.length > 0 ? <span className="self-center text-sm text-amber-200">{compositionReadiness.staleSceneIds.length} scene render(s) are stale and will be re-rendered before compose.</span> : null}
          {compositionMessage ? <span className="self-center text-sm text-emerald-200">{compositionMessage}</span> : null}
        </div>
        {lastComposition ? (
          <div className="mt-4 rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Final composition preview</p>
            <p className="mt-1 text-sm text-slate-300">Status: {finalCompositionStatus.status === 'current' ? 'Current' : 'Stale'}</p>
            {finalCompositionStatus.artifact ? <p className="text-sm text-slate-300">Duration: {formatDuration(finalCompositionStatus.artifact.duration)} • {formatSize(finalCompositionStatus.artifact.filesize)}</p> : null}
            {finalCompositionStatus.status === 'stale' ? <p className="mt-1 text-xs text-amber-200">{finalCompositionStatus.reasons[0]}</p> : null}
            <video controls className="mt-2 w-full rounded-xl border border-slate-700/70" src={`/api/projects/${draft.id}/compositions/${lastComposition.compositionId}/file`} />
          </div>
        ) : null}
        <div className="mt-4 rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Render readiness</p>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <InfoMiniCard label="Scenes" value={String(compositionReadiness.totalScenes)} />
            <InfoMiniCard label="Narration audio" value={String(compositionReadiness.scenesWithNarrationAudio)} />
            <InfoMiniCard label="Needs render" value={String(compositionReadiness.needsSceneRenderIds.length + compositionReadiness.staleSceneIds.length)} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {compositionReadiness.blockingSceneIds.slice(0, 3).map((sceneId) => {
              const scene = draft.scenes.find((entry) => entry.id === sceneId);
              if (!scene) return null;
              return (
                <button key={sceneId} type="button" onClick={() => { setSelectedSceneId(sceneId); setActiveTab('scenes'); }} className="rounded-2xl border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
                  Open Scene {scene.order}
                </button>
              );
            })}
            {[...compositionReadiness.needsSceneRenderIds, ...compositionReadiness.staleSceneIds].slice(0, 3).map((sceneId) => {
              const scene = draft.scenes.find((entry) => entry.id === sceneId);
              if (!scene) return null;
              return (
                <button key={sceneId} type="button" onClick={() => { setSelectedSceneId(sceneId); setActiveTab('scenes'); }} className="rounded-2xl border border-amber-300/40 bg-amber-200/10 px-3 py-2 text-xs text-amber-100">
                  Render Scene {scene.order}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <ProductionWorkflow
        workflow={workflow}
        activeStepId={activeWorkflowStepId}
        onNavigate={(target, stepId) => {
          if (target === 'story' || target === 'scenes' || target === 'assets' || target === 'references' || target === 'generation') {
            navigateFromWorkflow(target, stepId);
          }
        }}
      />

      <section className="studio-panel rounded-[24px] p-4 shadow-panel">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Production</p>
            <p className="mt-1 text-sm text-slate-200">{runStatusLabel(batchOutcome)}</p>
            <p className="text-xs text-slate-400">{productionPlan.summary.ready} actions ready</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={batchEvents.length === 0}
              onClick={() => {
                setBatchCopyState('idle');
                setBatchLogOpen(true);
              }}
              className="rounded-2xl border border-slate-700 bg-slate-950/50 px-4 py-2 text-sm text-slate-200 disabled:opacity-60"
            >
              View log
            </button>
            <button
              type="button"
              disabled={batchRunning || productionPlan.summary.ready === 0}
              onClick={() => void runProduceReady()}
              className="rounded-2xl bg-emerald-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
            >
              {batchRunning ? 'Producing...' : `Produce ${productionPlan.summary.ready}`}
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-300">
          <span>Completed: {batchSummary.completed}</span>
          <span>Running: {batchSummary.running}</span>
          <span>Failed: {batchSummary.failed}</span>
          <span>Waiting: {batchSummary.waiting}</span>
        </div>
        {batchMessage ? <p className="mt-2 text-xs text-slate-300">{batchMessage}</p> : null}

        <div className="mt-4">
          <ServerRunPanel projectId={draft.id} onEnsureSaved={saveProject} />
        </div>

        <div className="mt-4 rounded-2xl border border-slate-700/70 bg-slate-950/25 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Live activity</p>
          <div className="mt-2 grid gap-1 text-sm text-slate-200">
            {liveActivityRows.length === 0 ? <p className="text-xs text-slate-400">No active production activity yet.</p> : null}
            {liveActivityRows.map((entry) => (
              <div key={entry.id} className="flex items-start gap-2">
                <span className="font-mono text-xs text-slate-300">{actionStatusIcon(entry.status)}</span>
                <div>
                  <p>{entry.text}</p>
                  {entry.reason ? <p className="text-xs text-slate-400">{entry.reason}</p> : null}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 border-t border-slate-700/70 pt-3">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Recent runner events</p>
            <div className="mt-2 grid gap-1 text-xs text-slate-300">
              {recentRunnerEvents.length === 0 ? <p className="text-slate-400">No runner events yet.</p> : null}
              {recentRunnerEvents.map((event) => (
                <p key={`${event.timestamp}-${event.code}-${event.actionId ?? 'run'}`}>
                  {formatRunEventTime(event.timestamp)} {event.message}
                </p>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3">
          {productionSceneGroups.map((group) => (
            <div key={group.sceneId} className="rounded-2xl border border-slate-700/70 bg-slate-950/25 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Scene {String(group.sceneOrder).padStart(2, '0')}</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {group.actions.map((action) => (
                  <div key={action.id} className="rounded-xl border border-slate-700/70 bg-slate-950/35 px-3 py-2">
                    <p className="text-xs font-semibold text-white">{action.type.replace('_', ' ')}</p>
                    <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-slate-300">{action.status}</p>
                    {action.reason ? <p className="mt-1 text-xs text-slate-400">{action.reason}</p> : null}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {productionPlan.actions.some((action) => action.type === 'final_compose') ? (
            <div className="rounded-2xl border border-slate-700/70 bg-slate-950/25 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Final composition</p>
              {productionPlan.actions.filter((action) => action.type === 'final_compose').map((action) => (
                <div key={action.id} className="mt-2 rounded-xl border border-slate-700/70 bg-slate-950/35 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-slate-300">{action.status}</p>
                  {action.reason ? <p className="mt-1 text-xs text-slate-400">{action.reason}</p> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      {batchLogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4">
          <div className="studio-panel max-h-[80vh] w-full max-w-5xl overflow-hidden rounded-[24px] border border-slate-700/80 bg-slate-900/95 shadow-panel">
            <div className="flex items-center justify-between border-b border-slate-700/80 px-4 py-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Production log</p>
                <p className="text-xs text-slate-300">Transient run diagnostics for current workspace session.</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void copyProductionLog()}
                  className="rounded-xl border border-slate-700 px-3 py-1 text-xs text-slate-200"
                >
                  {batchCopyState === 'copied' ? '✓ Copied' : batchCopyState === 'failed' ? 'Copy failed' : 'Copy log'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBatchCopyState('idle');
                    setBatchLogOpen(false);
                  }}
                  className="rounded-xl border border-slate-700 px-3 py-1 text-xs text-slate-200"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="max-h-[64vh] overflow-auto px-4 py-3 studio-scrollbar">
              <div className="grid gap-2">
                {batchEvents.map((event) => (
                  <div key={`${event.timestamp}-${event.code}-${event.actionId ?? 'run'}`} className="rounded-xl border border-slate-700/70 bg-slate-950/35 p-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <span className="font-mono text-slate-400">{formatRunEventTime(event.timestamp)}</span>
                      <span className="font-mono uppercase tracking-[0.18em] text-slate-400">{event.code}</span>
                      <span className="font-semibold text-slate-100">{event.actionType ? actionTypeLabel(event.actionType) : 'Run'}</span>
                      {event.sceneId ? <span className="text-slate-300">Scene {event.sceneId}</span> : null}
                      <span className="text-slate-300">{event.status}</span>
                    </div>
                    <p className="mt-1 text-sm text-slate-100">{event.message}</p>
                    {event.error ? (
                      <div className="mt-2 rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-xs text-rose-100">
                        <p>Error: {event.error.message}</p>
                        {event.error.code ? <p>Code: {event.error.code}</p> : null}
                        {event.error.httpStatus ? <p>HTTP: {event.error.httpStatus}</p> : null}
                        {event.error.providerStatus ? <p>Provider status: {event.error.providerStatus}</p> : null}
                        {event.error.endpoint ? <p>Endpoint: {event.error.endpoint}</p> : null}
                        {event.error.attemptId ? <p>Attempt: {event.error.attemptId}</p> : null}
                        {event.error.details ? <p>Details: {event.error.details}</p> : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <TabButton active={activeTab === 'story'} onClick={() => setActiveTab('story')}>Story</TabButton>
        <TabButton active={activeTab === 'scenes'} onClick={() => setActiveTab('scenes')}>Scenes</TabButton>
        <TabButton active={activeTab === 'assets'} onClick={() => setActiveTab('assets')}>Assets</TabButton>
        <TabButton active={activeTab === 'references'} onClick={() => setActiveTab('references')}>References</TabButton>
        <TabButton active={activeTab === 'generation'} onClick={() => setActiveTab('generation')}>Generation Tasks</TabButton>
      </div>

      {activeTab === 'story' ? (
        <ExplainerStoryWorkspace
          project={draft}
          onProjectChange={updateProject}
          onNavigateToTab={(tab) => setActiveTab(tab)}
          focusArea={storyFocusArea}
          focusRequestId={storyFocusRequestId}
          onOpenScene={(sceneId) => {
            setSelectedSceneId(sceneId);
            setActiveTab('scenes');
          }}
        />
      ) : null}

      {activeTab === 'scenes' ? (
        <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)_400px]">
          <aside className="studio-panel rounded-[28px] p-4 shadow-panel xl:sticky xl:top-6 xl:h-[calc(100vh-3rem)] xl:overflow-auto studio-scrollbar">
            <div className="space-y-2">
              {draft.scenes
                .slice()
                .sort((a, b) => a.order - b.order)
                .map((scene) => {
                  const sceneStatus = deriveSceneRenderStatus(draft, scene, renderPlan, { isRendering: renderingSceneId === scene.id });
                  return (
                  <button
                    key={scene.id}
                    type="button"
                    onClick={() => setSelectedSceneId(scene.id)}
                    className={`w-full rounded-3xl border px-4 py-3 text-left transition ${selectedScene?.id === scene.id ? 'border-amber-300/50 bg-amber-200/10' : 'border-slate-700/70 bg-slate-950/30 hover:border-slate-500/80 hover:bg-slate-900/60'}`}
                  >
                    <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Scene {String(scene.order).padStart(2, '0')}</p>
                    <h3 className="mt-1 text-sm font-semibold text-white">{scene.type.toUpperCase()}</h3>
                    <p className="mt-1 text-xs text-slate-400">{scene.render.motion.preset}</p>
                    <p className="mt-1 text-xs text-slate-300">{formatRenderStatusLabel(sceneStatus.status)}</p>
                  </button>
                  );
                })}
            </div>
          </aside>

          <section className="studio-panel rounded-[28px] p-4 shadow-panel xl:min-h-[calc(100vh-3rem)]">
            {selectedScene ? <ScenePreview project={draft} scene={selectedScene} renderPlan={renderPlan} isRendering={renderingSceneId === selectedScene.id} /> : <EmptyPanel message="No scene selected." />}
          </section>

          <aside className="studio-panel rounded-[28px] p-4 shadow-panel xl:sticky xl:top-6 xl:h-[calc(100vh-3rem)] xl:overflow-auto studio-scrollbar">
            {selectedScene ? (
              <div className="space-y-4">
                <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Scene inspector</p>
                {selectedSceneRenderStatus ? (
                  <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3 space-y-2">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Render lifecycle</p>
                    <p className="text-sm text-white">{formatRenderStatusLabel(selectedSceneRenderStatus.status)}</p>
                    {selectedSceneRenderStatus.problems.map((problem, index) => (
                      <p key={`${problem.message}-${index}`} className={`text-xs ${problem.severity === 'blocking' ? 'text-rose-300' : problem.severity === 'warning' ? 'text-amber-200' : 'text-slate-300'}`}>
                        {problem.message}
                      </p>
                    ))}
                  </div>
                ) : null}
                <Field label="Duration" value={selectedScene.duration} onChange={(value) => updateScene(selectedScene.id, (scene) => ({ ...scene, duration: Number(value) }))} type="number" step="0.1" />
                <SelectField label="Type" value={selectedScene.type} onChange={(value) => updateScene(selectedScene.id, (scene) => ({ ...scene, type: value as Scene['type'] }))} options={SCENE_TYPES} />
                <SelectField label="Visual source" value={visualModeOf(selectedScene)} onChange={(value) => setVisualMode(selectedScene, value as VisualMode)} options={['asset', 'generated_image', 'generated_video', 'stock_image', 'graphic', 'html', 'text', 'blank']} />
                <SelectField label="Motion" value={selectedScene.render.motion.preset} onChange={(value) => updateScene(selectedScene.id, (scene) => ({ ...scene, render: { ...scene.render, motion: { ...scene.render.motion, preset: value as Scene['render']['motion']['preset'] } } }))} options={MOTION_PRESETS} />
                <SelectField label="Transition" value={selectedScene.render.transition.type} onChange={(value) => updateScene(selectedScene.id, (scene) => ({ ...scene, render: { ...scene.render, transition: { ...scene.render.transition, type: value as Scene['render']['transition']['type'] } } }))} options={TRANSITION_PRESETS} />
                <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Overlay</p>
                    <label className="flex items-center gap-2 text-xs text-slate-300">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-amber-300"
                        checked={(selectedScene.overlay?.type ?? 'none') !== 'none'}
                        onChange={(event) => updateOverlay(selectedScene.id, (overlay) => ({
                          ...overlay,
                          type: event.target.checked ? (overlay.type && overlay.type !== 'none' ? overlay.type : 'text') : 'none'
                        }))}
                      />
                      Enabled
                    </label>
                  </div>
                  <SelectField label="Overlay type" value={selectedScene.overlay?.type ?? 'none'} onChange={(value) => updateOverlay(selectedScene.id, (overlay) => ({ ...overlay, type: value as OverlaySpec['type'] }))} options={OVERLAY_TYPES} />
                  {(selectedScene.overlay?.type ?? 'none') !== 'none' ? (
                    <>
                      <Field label="Overlay text" value={selectedScene.overlay?.text ?? ''} onChange={(value) => updateOverlay(selectedScene.id, (overlay) => ({ ...overlay, text: String(value) }))} asTextArea />
                      <SelectField label="Overlay position" value={selectedScene.overlay?.position ?? defaultPositionForType(selectedScene.overlay?.type ?? 'text')} onChange={(value) => updateOverlay(selectedScene.id, (overlay) => ({ ...overlay, position: value as OverlaySpec['position'] }))} options={OVERLAY_POSITIONS} />
                      <Field label="Overlay color (hex or name)" value={selectedScene.overlay?.style?.color ?? ''} onChange={(value) => updateOverlay(selectedScene.id, (overlay) => ({ ...overlay, style: { ...(overlay.style ?? {}), color: String(value).trim() || undefined } }))} />
                      <Field
                        label={`Overlay font size (${OVERLAY_STYLE_LIMITS.MIN_FONT_SIZE}-${OVERLAY_STYLE_LIMITS.MAX_FONT_SIZE})`}
                        value={selectedScene.overlay?.style?.fontSize ?? ''}
                        type="number"
                        step="1"
                        onChange={(value) => {
                          const next = Number(value);
                          updateOverlay(selectedScene.id, (overlay) => ({ ...overlay, style: { ...(overlay.style ?? {}), fontSize: Number.isFinite(next) && next > 0 ? next : undefined } }));
                        }}
                      />
                      <Field
                        label={`Overlay margin (${OVERLAY_STYLE_LIMITS.MIN_MARGIN}-${OVERLAY_STYLE_LIMITS.MAX_MARGIN})`}
                        value={selectedScene.overlay?.style?.margin ?? ''}
                        type="number"
                        step="1"
                        onChange={(value) => {
                          const next = Number(value);
                          updateOverlay(selectedScene.id, (overlay) => ({ ...overlay, style: { ...(overlay.style ?? {}), margin: Number.isFinite(next) && next > 0 ? next : undefined } }));
                        }}
                      />
                      <label className="flex items-center gap-2 text-xs text-slate-300">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-amber-300"
                          checked={selectedScene.overlay?.style?.box ?? defaultBoxForType(selectedScene.overlay?.type ?? 'text')}
                          onChange={(event) => updateOverlay(selectedScene.id, (overlay) => ({ ...overlay, style: { ...(overlay.style ?? {}), box: event.target.checked } }))}
                        />
                        Overlay background box
                      </label>
                      <Field
                        label="Overlay fade in (seconds)"
                        value={selectedScene.overlay?.timing?.fadeInSeconds ?? ''}
                        type="number"
                        step="0.1"
                        onChange={(value) => {
                          const next = Number(value);
                          updateOverlay(selectedScene.id, (overlay) => ({ ...overlay, timing: { ...(overlay.timing ?? {}), fadeInSeconds: Number.isFinite(next) && next >= 0 ? next : undefined } }));
                        }}
                      />
                      <Field
                        label="Overlay fade out (seconds)"
                        value={selectedScene.overlay?.timing?.fadeOutSeconds ?? ''}
                        type="number"
                        step="0.1"
                        onChange={(value) => {
                          const next = Number(value);
                          updateOverlay(selectedScene.id, (overlay) => ({ ...overlay, timing: { ...(overlay.timing ?? {}), fadeOutSeconds: Number.isFinite(next) && next >= 0 ? next : undefined } }));
                        }}
                      />
                    </>
                  ) : null}
                </div>
                <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3 space-y-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Presenter layout</p>
                  <SelectField
                    label="Presenter mode"
                    value={presenterModeOf(selectedScene)}
                    onChange={(value) => updatePresenterMode(selectedScene.id, value as SceneCompositionPresenterMode)}
                    options={COMPOSITION_PRESENTER_MODES}
                  />
                  {presenterModeOf(selectedScene) === 'pip' ? (
                    <SelectField
                      label="PiP preset"
                      value={presenterPipPresetOf(selectedScene)}
                      onChange={(value) => updatePresenterPipPreset(selectedScene.id, value as SceneCompositionPipPresetName | 'custom')}
                      options={COMPOSITION_PIP_PRESETS}
                    />
                  ) : null}
                  <p className="text-xs text-slate-400">
                    Scene composition presenter mode (`full_canvas` / `pip`), not the project presenter layout field.
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3 space-y-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Logo</p>
                  <SelectField
                    label="Logo mode"
                    value={logoModeOf(selectedScene)}
                    onChange={(value) => {
                      const mode = value as LogoMode;
                      if (mode === 'off') {
                        updateLogo(selectedScene.id, () => null);
                        return;
                      }
                      if (mode === 'inherit') {
                        updateScene(selectedScene.id, (scene) => {
                          const next = { ...scene };
                          delete next.logo;
                          return next;
                        });
                        return;
                      }
                      updateLogo(selectedScene.id, (logo) => logo && typeof logo === 'object' ? logo : defaultLogoSpec());
                    }}
                    options={LOGO_MODE_OPTIONS}
                  />
                  {logoModeOf(selectedScene) === 'custom' ? (
                    <>
                      <div>
                        <label className="mb-1 block text-xs uppercase tracking-[0.2em] text-slate-500">Logo asset</label>
                        <select
                          value={selectedScene.logo?.assetId ?? ''}
                          onChange={(event) => updateLogo(selectedScene.id, (logo) => ({
                            ...(logo && typeof logo === 'object' ? logo : defaultLogoSpec()),
                            assetId: event.target.value
                          }))}
                          className="w-full rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100"
                        >
                          <option value="">No logo asset selected</option>
                          {logoAssets.map((asset) => (
                            <option key={asset.id} value={asset.id}>
                              {asset.filename} ({asset.type}{asset.localPath ? '' : ', no path'})
                            </option>
                          ))}
                          {selectedScene.logo?.assetId && !logoAssets.some((asset) => asset.id === selectedScene.logo?.assetId) ? (
                            <option value={selectedScene.logo.assetId}>{selectedScene.logo.assetId} (invalid or missing)</option>
                          ) : null}
                        </select>
                      </div>
                      <SelectField
                        label="Logo position"
                        value={selectedScene.logo?.position ?? 'bottom_right'}
                        onChange={(value) => updateLogo(selectedScene.id, (logo) => ({
                          ...(logo && typeof logo === 'object' ? logo : defaultLogoSpec()),
                          position: value as LogoOverlaySpec['position']
                        }))}
                        options={LOGO_OVERLAY_POSITIONS}
                      />
                      <Field
                        label={`Logo scale (${LOGO_OVERLAY_LIMITS.MIN_SCALE}-${LOGO_OVERLAY_LIMITS.MAX_SCALE})`}
                        value={selectedScene.logo?.scale ?? ''}
                        type="number"
                        step="0.01"
                        onChange={(value) => {
                          const next = Number(value);
                          updateLogo(selectedScene.id, (logo) => ({
                            ...(logo && typeof logo === 'object' ? logo : defaultLogoSpec()),
                            scale: Number.isFinite(next) && next > 0 ? next : undefined
                          }));
                        }}
                      />
                      <Field
                        label={`Logo max width (${LOGO_OVERLAY_LIMITS.MIN_MAX_WIDTH}-${LOGO_OVERLAY_LIMITS.MAX_MAX_WIDTH})`}
                        value={selectedScene.logo?.maxWidth ?? ''}
                        type="number"
                        step="1"
                        onChange={(value) => {
                          const next = Number(value);
                          updateLogo(selectedScene.id, (logo) => ({
                            ...(logo && typeof logo === 'object' ? logo : defaultLogoSpec()),
                            maxWidth: Number.isFinite(next) && next > 0 ? next : undefined
                          }));
                        }}
                      />
                      <Field
                        label={`Logo margin (${LOGO_OVERLAY_LIMITS.MIN_MARGIN}-${LOGO_OVERLAY_LIMITS.MAX_MARGIN})`}
                        value={selectedScene.logo?.margin ?? ''}
                        type="number"
                        step="1"
                        onChange={(value) => {
                          const next = Number(value);
                          updateLogo(selectedScene.id, (logo) => ({
                            ...(logo && typeof logo === 'object' ? logo : defaultLogoSpec()),
                            margin: Number.isFinite(next) && next >= 0 ? next : undefined
                          }));
                        }}
                      />
                      <Field
                        label={`Logo opacity (${LOGO_OVERLAY_LIMITS.MIN_OPACITY}-${LOGO_OVERLAY_LIMITS.MAX_OPACITY})`}
                        value={selectedScene.logo?.opacity ?? ''}
                        type="number"
                        step="0.05"
                        onChange={(value) => {
                          const next = Number(value);
                          updateLogo(selectedScene.id, (logo) => ({
                            ...(logo && typeof logo === 'object' ? logo : defaultLogoSpec()),
                            opacity: Number.isFinite(next) ? next : undefined
                          }));
                        }}
                      />
                    </>
                  ) : null}
                  {logoModeOf(selectedScene) === 'inherit' ? (
                    <p className="text-xs text-slate-400">
                      {draft.renderSettings.logo?.assetId ? `Inherits project logo ${draft.renderSettings.logo.assetId}.` : 'No project default logo. Scene renders without a logo.'}
                    </p>
                  ) : null}
                  {logoModeOf(selectedScene) === 'off' ? (
                    <p className="text-xs text-slate-400">Explicit opt-out. Project default logo is not applied.</p>
                  ) : null}
                </div>
                <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3 space-y-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Motion Canvas</p>
                  <SelectField
                    label="Template"
                    value={animationTemplateId}
                    onChange={(value) => setAnimationTemplateId(value as (typeof ANIMATION_TEMPLATE_IDS)[number])}
                    options={animationTemplateOptions}
                    labels={animationTemplateLabels}
                  />
                  <button
                    type="button"
                    disabled={animationBusy}
                    onClick={() => void renderMotionCanvasTemplate()}
                    className="rounded-2xl border border-slate-700 px-3 py-2 text-xs text-slate-200 disabled:opacity-60"
                  >
                    {animationBusy ? 'Working...' : 'Render template'}
                  </button>
                  <div>
                    <label className="mb-1 block text-xs uppercase tracking-[0.2em] text-slate-500">Animation asset</label>
                    <select
                      value={animationAssetId}
                      onChange={(event) => {
                        const nextId = event.target.value;
                        setAnimationAssetId(nextId);
                        const asset = draft.assets.find((entry) => entry.id === nextId);
                        const destination = asset ? animationDestinationOf(asset) : undefined;
                        if (destination) {
                          setAnimationDestination(destination);
                        }
                      }}
                      className="w-full rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100"
                    >
                      <option value="">No animation asset selected</option>
                      {animationAssets.map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.filename} ({animationDestinationOf(asset) ?? asset.type})
                        </option>
                      ))}
                    </select>
                  </div>
                  <SelectField
                    label="Destination"
                    value={animationDestination}
                    onChange={(value) => setAnimationDestination(value as AnimationDestination)}
                    options={['bigscreen', 'overlay']}
                  />
                  <button
                    type="button"
                    disabled={animationBusy || !animationAssetId}
                    onClick={() => void attachMotionCanvasAnimation(selectedScene.id)}
                    className="rounded-2xl border border-slate-700 px-3 py-2 text-xs text-slate-200 disabled:opacity-60"
                  >
                    Attach to scene
                  </button>
                  {(() => {
                    const attached = attachedAnimationLayer(selectedScene);
                    return attached ? (
                      <p className="text-xs text-slate-300">Attached: {attached.assetId} as {attached.destination}</p>
                    ) : (
                      <p className="text-xs text-slate-400">No Motion Canvas layer attached to this scene.</p>
                    );
                  })()}
                  {animationMessage ? <p className="text-xs text-slate-300">{animationMessage}</p> : null}
                </div>
                <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3 space-y-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Narration</p>
                  <Field
                    label="Narration text"
                    value={selectedScene.narration?.text ?? ''}
                    onChange={(value) => updateScene(selectedScene.id, (scene) => ({
                      ...scene,
                      narration: {
                        ...(scene.narration ?? { text: '' }),
                        text: String(value),
                        status: scene.narration?.status ?? 'planned'
                      }
                    }))}
                    asTextArea
                  />
                  <Field
                    label="Voice ID"
                    value={selectedScene.narration?.voiceId ?? ''}
                    onChange={(value) => updateScene(selectedScene.id, (scene) => ({
                      ...scene,
                      narration: {
                        ...(scene.narration ?? { text: '' }),
                        text: scene.narration?.text ?? '',
                        voiceId: String(value)
                      }
                    }))}
                  />
                  <Field
                    label="Model"
                    value={selectedScene.narration?.model ?? ''}
                    onChange={(value) => updateScene(selectedScene.id, (scene) => ({
                      ...scene,
                      narration: {
                        ...(scene.narration ?? { text: '' }),
                        text: scene.narration?.text ?? '',
                        model: String(value)
                      }
                    }))}
                  />
                  <SelectField
                    label="Output format"
                    value={selectedScene.narration?.format ?? 'mp3'}
                    onChange={(value) => updateScene(selectedScene.id, (scene) => ({
                      ...scene,
                      narration: {
                        ...(scene.narration ?? { text: '' }),
                        text: scene.narration?.text ?? '',
                        format: value as 'mp3' | 'wav' | 'm4a'
                      }
                    }))}
                    options={['mp3', 'wav', 'm4a']}
                  />
                  <div>
                    <label className="mb-1 block text-xs uppercase tracking-[0.2em] text-slate-500">Linked audio asset</label>
                    <select
                      value={selectedScene.narration?.audioAssetId ?? ''}
                      onChange={(event) => updateScene(selectedScene.id, (scene) => ({
                        ...scene,
                        narration: {
                          ...(scene.narration ?? { text: '' }),
                          text: scene.narration?.text ?? '',
                          audioAssetId: event.target.value || undefined,
                          status: event.target.value ? 'generated' : (scene.narration?.status ?? 'planned')
                        }
                      }))}
                      className="w-full rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100"
                    >
                      <option value="">No audio asset linked</option>
                      {audioAssets.map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.filename} ({formatDuration(asset.duration)})
                        </option>
                      ))}
                    </select>
                  </div>
                  {(() => {
                    const audioAsset = selectedScene.narration?.audioAssetId
                      ? draft.assets.find((asset) => asset.id === selectedScene.narration?.audioAssetId)
                      : undefined;
                    return (
                      <>
                        <p className="text-xs text-slate-300">Status: {selectedScene.narration?.status ?? 'planned'}</p>
                        <p className="text-xs text-slate-300">Audio duration: {formatDuration(selectedScene.narration?.duration ?? audioAsset?.duration)}</p>
                        {audioAsset && typeof audioAsset.duration === 'number' && audioAsset.duration > selectedScene.duration + 0.01 ? (
                          <p className="text-xs text-amber-200">
                            Warning: narration audio ({audioAsset.duration.toFixed(2)}s) is longer than the authored scene duration ({selectedScene.duration.toFixed(2)}s). The scene will be extended during rendering; speech is not trimmed.
                          </p>
                        ) : null}
                        {selectedScene.narration?.error ? <p className="text-xs text-rose-300">{selectedScene.narration.error}</p> : null}
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={narratingSceneId === selectedScene.id}
                            onClick={() => {
                              const status = selectedScene.narration?.status;
                              if (status === 'generated' && selectedScene.narration?.audioAssetId) {
                                void runNarrationGeneration(selectedScene, 'regenerate');
                                return;
                              }
                              if (status === 'failed') {
                                void runNarrationGeneration(selectedScene, 'retry');
                                return;
                              }
                              void runNarrationGeneration(selectedScene, 'generate');
                            }}
                            className="rounded-2xl bg-amber-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-60"
                          >
                            {narratingSceneId === selectedScene.id
                              ? 'Generating...'
                              : selectedScene.narration?.status === 'generated' && selectedScene.narration?.audioAssetId
                                ? 'Regenerate Narration'
                                : selectedScene.narration?.status === 'failed'
                                  ? 'Retry Narration'
                                  : 'Generate Narration'}
                          </button>
                          {selectedScene.narration?.audioAssetId ? (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedAssetId(selectedScene.narration!.audioAssetId!);
                                setActiveTab('assets');
                              }}
                              className="rounded-2xl border border-slate-700 px-3 py-2 text-xs text-slate-200"
                            >
                              Open Audio Asset
                            </button>
                          ) : null}
                        </div>
                        {audioAsset?.id ? (
                          <audio controls className="w-full" src={`/api/projects/${draft.id}/assets/${audioAsset.id}/file`} />
                        ) : null}
                      </>
                    );
                  })()}
                </div>

                {(selectedScene.visual?.kind === 'asset' || selectedScene.visual?.kind === 'generated_image' || selectedScene.visual?.kind === 'generated_video') ? (
                  <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3 space-y-2">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Scene asset</p>
                    <select
                      value={selectedScene.visual.kind === 'asset' ? selectedScene.visual.assetId ?? '' : selectedScene.visual.kind === 'generated_image' || selectedScene.visual.kind === 'generated_video' ? selectedScene.visual.assetId ?? selectedScene.visual.generation.assetId ?? '' : ''}
                      onChange={(event) => setAssetForScene(selectedScene, event.target.value)}
                      className="w-full rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100"
                    >
                      <option value="">No asset selected</option>
                      {draft.assets.map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.filename} ({asset.type})
                        </option>
                      ))}
                    </select>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => sceneAssetFileInput.current?.click()} className="rounded-2xl border border-slate-700 px-3 py-2 text-xs text-slate-200">Import new asset</button>
                      <button type="button" onClick={() => setAssetForScene(selectedScene, '')} className="rounded-2xl border border-slate-700 px-3 py-2 text-xs text-slate-200">Clear asset</button>
                    </div>
                    <input
                      ref={sceneAssetFileInput}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/mp4,.mov,.m4a"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.currentTarget.value = '';
                        if (file) {
                          void importAsset(file, true);
                        }
                      }}
                    />
                  </div>
                ) : null}

                {selectedScene.visual?.kind === 'stock_image' ? (
                  <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3 space-y-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Stock image</p>
                    <Field
                      label="Search query"
                      value={selectedScene.visual.query}
                      onChange={(value) =>
                        updateScene(selectedScene.id, (scene) =>
                          scene.visual?.kind === 'stock_image'
                            ? { ...scene, visual: { ...scene.visual, query: String(value) } }
                            : scene
                        )
                      }
                    />
                    <SelectField
                      label="Orientation"
                      value={selectedScene.visual.orientation ?? ''}
                      onChange={(value) =>
                        updateScene(selectedScene.id, (scene) =>
                          scene.visual?.kind === 'stock_image'
                            ? { ...scene, visual: { ...scene.visual, orientation: value ? (value as StockOrientation) : undefined } }
                            : scene
                        )
                      }
                      options={['', 'landscape', 'portrait', 'squarish']}
                      labels={{ '': 'Any' }}
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={stockSearching}
                        onClick={() => void runStockSearch(selectedScene)}
                        className="rounded-2xl border border-amber-300/50 bg-amber-200/10 px-3 py-2 text-xs text-amber-100 disabled:opacity-50"
                      >
                        {stockSearching ? 'Searching...' : 'Search stock'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void autoSelectStock(selectedScene)}
                        className="rounded-2xl border border-slate-700 px-3 py-2 text-xs text-slate-200"
                      >
                        Auto-select best match
                      </button>
                    </div>
                    {stockMessage ? <p className="text-xs text-slate-300">{stockMessage}</p> : null}

                    {selectedScene.visual.selection ? (
                      <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-2 space-y-1">
                        <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                          Current selection{selectedScene.visual.selection.origin === 'manual' ? ' · pinned' : ''}
                        </p>
                        <p className="text-xs text-slate-200">
                          {selectedScene.visual.selection.provider} · {selectedScene.visual.selection.photoId}
                        </p>
                        <p className="text-xs text-slate-400">Photographer: {selectedScene.visual.selection.attribution.photographerName}</p>
                        <a
                          href={selectedScene.visual.selection.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-amber-200 underline"
                        >
                          {selectedScene.visual.selection.attribution.providerName} source
                        </a>
                        <p className="text-[11px] text-slate-500">
                          {selectedScene.visual.selection.attribution.license} · {selectedScene.visual.selection.usagePolicy}
                        </p>
                        {selectedScene.visual.assetId ? (
                          <Image
                            src={`/api/projects/${draft.id}/assets/${selectedScene.visual.assetId}/file`}
                            alt="Selected stock photo"
                            width={320}
                            height={180}
                            unoptimized
                            className="mt-1 w-full rounded-xl border border-slate-800 object-cover"
                          />
                        ) : null}
                      </div>
                    ) : null}

                    {stockSearch && stockSearch.sceneId === selectedScene.id && stockSearch.results.length > 0 ? (
                      <div className="grid grid-cols-2 gap-2">
                        {stockSearch.results.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            disabled={stockSelectingId === item.id}
                            onClick={() => void chooseStockPhoto(selectedScene, item)}
                            className="overflow-hidden rounded-xl border border-slate-700/70 bg-slate-950/40 text-left disabled:opacity-50"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={item.previewUrl} alt={item.description ?? item.photoId} className="h-24 w-full object-cover" />
                            <span className="block px-2 py-1 text-[10px] text-slate-300">
                              {item.provider} · {item.photographerName}
                            </span>
                            <span className="block px-2 pb-1 text-[10px] text-amber-200 underline">
                              {stockSelectingId === item.id ? 'Applying...' : 'Use photo'}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null}

                    {stockSearch && stockSearch.sceneId === selectedScene.id && stockSearch.quota.length > 0 ? (
                      <div className="space-y-1">
                        {stockSearch.quota.map((entry) => (
                          <p key={entry.provider} className={`text-[11px] ${entry.allowed ? 'text-slate-400' : 'text-amber-200'}`}>
                            {entry.provider}:{' '}
                            {entry.configured ? `${entry.windowRemaining}/${entry.windowLimit} left` : 'not configured'}
                            {entry.monthlyRemaining !== undefined ? ` · ${entry.monthlyRemaining} monthly` : ''}
                            {entry.allowed ? '' : ' (quota guard)'}
                          </p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {(selectedScene.visual?.kind === 'generated_image' || selectedScene.visual?.kind === 'generated_video') ? (
                  <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3 space-y-2">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Generation settings</p>
                    <SelectField
                      label="Provider"
                      value={selectedScene.visual.generation.provider ?? 'local'}
                      onChange={(value) =>
                        updateScene(selectedScene.id, (scene) => {
                          if (!scene.visual || (scene.visual.kind !== 'generated_image' && scene.visual.kind !== 'generated_video')) {
                            return scene;
                          }
                          return {
                            ...scene,
                            visual: {
                              ...scene.visual,
                              generation: { ...scene.visual.generation, provider: value as GenerationProvider }
                            }
                          };
                        })
                      }
                      options={selectedScene.visual.kind === 'generated_video' ? VIDEO_GENERATION_PROVIDERS : GENERATION_PROVIDERS}
                    />
                    <SelectField
                      label="Status"
                      value={selectedScene.visual.generation.status}
                      onChange={(value) =>
                        updateScene(selectedScene.id, (scene) => {
                          if (!scene.visual || (scene.visual.kind !== 'generated_image' && scene.visual.kind !== 'generated_video')) {
                            return scene;
                          }
                          return {
                            ...scene,
                            visual: {
                              ...scene.visual,
                              generation: { ...scene.visual.generation, status: value as GenerationStatus }
                            }
                          };
                        })
                      }
                      options={GENERATION_STATUSES}
                    />
                    <Field
                      label="Prompt"
                      value={selectedScene.visual.generation.prompt}
                      onChange={(value) =>
                        updateScene(selectedScene.id, (scene) => {
                          if (!scene.visual || (scene.visual.kind !== 'generated_image' && scene.visual.kind !== 'generated_video')) {
                            return scene;
                          }
                          return {
                            ...scene,
                            visual: {
                              ...scene.visual,
                              generation: { ...scene.visual.generation, prompt: String(value) }
                            }
                          };
                        })
                      }
                      asTextArea
                    />

                    {selectedScene.visual.kind === 'generated_video' ? (
                      <>
                        <Field
                          label="Model"
                          value={selectedScene.visual.generation.model ?? ''}
                          placeholder={videoModelHints.placeholder}
                          suggestions={videoModelHints.suggestions}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'generated_video') {
                                return scene;
                              }
                              const trimmed = String(value).trim();
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  generation: { ...scene.visual.generation, model: trimmed ? trimmed : undefined }
                                }
                              };
                            })
                          }
                        />
                        {(() => {
                          const visual = selectedScene.visual;
                          if (!visual || visual.kind !== 'generated_video') {
                            return null;
                          }
                          const generation = visual.generation;
                          // Use the canonical scene reference list so frame choices
                          // match what the inspector shows; keep any already-stored
                          // frame ids visible even if the snapshot had drifted.
                          const referenceIds = selectedScene.referenceIds;
                          const storedFrameIds = [generation.startFrameReferenceId, generation.endFrameReferenceId].filter(
                            (id): id is string => Boolean(id)
                          );
                          const effective = [...referenceIds, ...storedFrameIds.filter((id) => !referenceIds.includes(id))];
                          const frameLabels: Record<string, string> = { '': 'None (prompt only)' };
                          for (const id of effective) {
                            frameLabels[id] = referenceName(id);
                          }
                          const startOptions = ['', ...effective.filter((id) => id !== generation.endFrameReferenceId)];
                          const endOptions = ['', ...effective.filter((id) => id !== generation.startFrameReferenceId)];
                          return (
                            <div className="rounded-2xl border border-slate-700/70 bg-slate-950/25 p-3 space-y-2">
                              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Keyframes (image-to-video)</p>
                              {referenceIds.length === 0 ? (
                                <p className="text-xs text-slate-400">Select at least one reference below, then choose it as a start frame.</p>
                              ) : null}
                              <SelectField
                                label="Start frame"
                                value={generation.startFrameReferenceId ?? ''}
                                onChange={(value) => setSceneFrame(selectedScene.id, 'start', value)}
                                options={startOptions}
                                labels={frameLabels}
                              />
                              <SelectField
                                label="End frame (optional)"
                                value={generation.endFrameReferenceId ?? ''}
                                onChange={(value) => setSceneFrame(selectedScene.id, 'end', value)}
                                options={endOptions}
                                labels={frameLabels}
                              />
                            </div>
                          );
                        })()}
                      </>
                    ) : null}

                    {selectedScene.visual.kind === 'generated_image' ? (
                      <div className="rounded-2xl border border-slate-700/70 bg-slate-950/25 p-3 space-y-2">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">AI image</p>
                        <p className="text-xs text-slate-300">Status: {selectedScene.visual.generation.status}</p>
                        <p className="text-xs text-slate-300">Provider: {selectedScene.visual.generation.provider ?? 'openai'}</p>
                        <p className="text-xs text-slate-300">References: {selectedScene.visual.generation.referenceIds?.length ?? selectedScene.referenceIds.length}</p>
                        {selectedScene.visual.generation.error ? <p className="text-xs text-rose-300">Reason: {selectedScene.visual.generation.error}</p> : null}
                        <div className="flex gap-2">
                          {(() => {
                            const currentGeneratedAssetId = selectedScene.visual?.kind === 'generated_image'
                              ? selectedScene.visual.assetId || selectedScene.visual.generation.assetId
                              : undefined;
                            return (
                              <>
                          <button
                            type="button"
                            disabled={generatingSceneId === selectedScene.id}
                            onClick={() => void runImageGeneration(selectedScene.id, Boolean(currentGeneratedAssetId))}
                            className="rounded-2xl bg-amber-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-60"
                          >
                            {generatingSceneId === selectedScene.id ? 'Generating...' : currentGeneratedAssetId ? 'Regenerate Image' : 'Generate Image'}
                          </button>
                          {currentGeneratedAssetId ? (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedAssetId(currentGeneratedAssetId);
                                setActiveTab('assets');
                              }}
                              className="rounded-2xl border border-slate-700 px-3 py-2 text-xs text-slate-200"
                            >
                              Open Asset
                            </button>
                          ) : null}
                              </>
                            );
                          })()}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {(selectedScene.visual.generation.referenceIds ?? selectedScene.referenceIds).map((referenceId) => {
                            const reference = draft.references.find((entry) => entry.id === referenceId);
                            if (!reference) {
                              return null;
                            }
                            return (
                              <button
                                key={reference.id}
                                type="button"
                                onClick={() => {
                                  setSelectedReferenceId(reference.id);
                                  setActiveTab('references');
                                }}
                                className="relative h-12 w-12 overflow-hidden rounded-lg border border-slate-700"
                                title={reference.name}
                              >
                                {reference.filePath ? <Image src={joinProjectReferenceUrl(draft.id, reference.id)} alt={reference.name} fill unoptimized sizes="48px" className="object-cover" /> : null}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}

                    {selectedScene.visual.kind === 'generated_video' ? (
                      <div className="rounded-2xl border border-slate-700/70 bg-slate-950/25 p-3 space-y-2">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">AI video</p>
                        <p className="text-xs text-slate-300">Status: {selectedScene.visual.generation.status}</p>
                        <p className="text-xs text-slate-300">Provider: {selectedScene.visual.generation.provider ?? 'openai'}</p>
                        <p className="text-xs text-slate-300">Provider Job: {selectedScene.visual.generation.providerJobId ?? 'none'}</p>
                        <p className="text-xs text-slate-300">Provider Status: {selectedScene.visual.generation.providerStatus ?? 'n/a'}</p>
                        <p className="text-xs text-slate-300">References: {selectedScene.visual.generation.referenceIds?.length ?? selectedScene.referenceIds.length}</p>
                        {selectedScene.visual.generation.error ? <p className="text-xs text-rose-300">Reason: {selectedScene.visual.generation.error}</p> : null}
                        <div className="flex gap-2">
                          {(() => {
                            const currentGeneratedAssetId = selectedScene.visual?.kind === 'generated_video'
                              ? selectedScene.visual.assetId || selectedScene.visual.generation.assetId
                              : undefined;
                            const currentAttemptId = selectedScene.visual?.kind === 'generated_video' ? selectedScene.visual.generation.id : undefined;
                            const inProgress = selectedScene.visual.generation.status === 'queued' || selectedScene.visual.generation.status === 'generating';
                            const actionLabel = inProgress
                              ? 'Poll Video Status'
                              : currentGeneratedAssetId
                                ? 'Regenerate Video'
                                : selectedScene.visual.generation.status === 'failed' || selectedScene.visual.generation.status === 'rejected'
                                  ? 'Retry Video'
                                  : 'Generate Video';

                            return (
                              <>
                                <button
                                  type="button"
                                  disabled={generatingSceneId === selectedScene.id}
                                  onClick={() => {
                                    if (inProgress) {
                                      if (currentAttemptId) {
                                        void pollVideoGenerationAttempt(currentAttemptId).then(() => refreshProject());
                                      }
                                      return;
                                    }

                                    void runVideoGeneration(selectedScene.id, Boolean(currentGeneratedAssetId));
                                  }}
                                  className="rounded-2xl bg-amber-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-60"
                                >
                                  {generatingSceneId === selectedScene.id ? 'Submitting...' : actionLabel}
                                </button>

                                {currentGeneratedAssetId ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedAssetId(currentGeneratedAssetId);
                                      setActiveTab('assets');
                                    }}
                                    className="rounded-2xl border border-slate-700 px-3 py-2 text-xs text-slate-200"
                                  >
                                    Open Asset
                                  </button>
                                ) : null}

                                {inProgress ? (
                                  <button
                                    type="button"
                                    disabled={generatingSceneId === selectedScene.id}
                                    onClick={() => {
                                      void cancelVideoGeneration(selectedScene.id);
                                    }}
                                    className="rounded-2xl border border-rose-500/60 px-3 py-2 text-xs font-semibold text-rose-200 disabled:opacity-60"
                                  >
                                    Cancel Video
                                  </button>
                                ) : null}
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {selectedScene.visual?.kind === 'graphic' ? (
                  <SelectField
                    label="Graphic template"
                    value={selectedScene.visual.template ?? 'simple_diagram'}
                    onChange={(value) =>
                      updateScene(selectedScene.id, (scene) => {
                        if (!scene.visual || scene.visual.kind !== 'graphic') {
                          return scene;
                        }
                        return {
                          ...scene,
                          visual: {
                            ...scene.visual,
                            template: value as GraphicTemplateType
                          }
                        };
                      })
                    }
                    options={GRAPHIC_TEMPLATES}
                  />
                ) : null}

                {selectedScene.visual?.kind === 'html' ? (
                  <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3 space-y-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">HTML still</p>
                    <SelectField
                      label="Template"
                      value={selectedScene.visual.template === 'headline_card'
                        ? 'headline'
                        : selectedScene.visual.template === 'comparison_card'
                          ? 'comparison'
                          : selectedScene.visual.template === 'stat-card'
                            ? 'stat_card'
                            : selectedScene.visual.template ?? 'headline'}
                      onChange={(value) =>
                        updateScene(selectedScene.id, (scene) => {
                          if (!scene.visual || scene.visual.kind !== 'html') {
                            return scene;
                          }
                          const template = value as HtmlStillTemplateType;
                          return {
                            ...scene,
                            visual: {
                              ...scene.visual,
                              template,
                              templateData: htmlTemplateDataFor(template, scene.visual.templateData ?? {})
                            }
                          };
                        })
                      }
                      options={HTML_STILL_TEMPLATES}
                    />
                    {((selectedScene.visual.template ?? 'headline') === 'headline' || selectedScene.visual.template === 'headline_card') ? (
                      <>
                        <Field
                          label="Title"
                          value={typeof selectedScene.visual.templateData?.title === 'string' ? selectedScene.visual.templateData.title : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), title: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Subtitle"
                          value={typeof selectedScene.visual.templateData?.subtitle === 'string' ? selectedScene.visual.templateData.subtitle : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), subtitle: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Source"
                          value={typeof selectedScene.visual.templateData?.source === 'string' ? selectedScene.visual.templateData.source : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), source: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Kicker"
                          value={typeof selectedScene.visual.templateData?.kicker === 'string' ? selectedScene.visual.templateData.kicker : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), kicker: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <HtmlStillSlotImagePicker
                          projectId={draft.id}
                          assets={draft.assets}
                          excludeAssetIds={selectedScene.visual.assetId ? [selectedScene.visual.assetId] : []}
                          value={typeof selectedScene.visual.templateData?.imageAssetId === 'string' ? selectedScene.visual.templateData.imageAssetId : undefined}
                          label="Image"
                          onSelect={(assetId) => setHtmlStillSlotImage(selectedScene.id, assetId)}
                          onImport={(file) => void importHtmlStillSlotImage(selectedScene.id, file)}
                        />
                      </>
                    ) : null}
                    {(selectedScene.visual.template === 'stat_card' || selectedScene.visual.template === 'stat-card') ? (
                      <>
                        <Field
                          label="Label"
                          value={typeof selectedScene.visual.templateData?.label === 'string' ? selectedScene.visual.templateData.label : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), label: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Value"
                          value={typeof selectedScene.visual.templateData?.value === 'string' ? selectedScene.visual.templateData.value : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), value: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Detail"
                          value={typeof selectedScene.visual.templateData?.detail === 'string' ? selectedScene.visual.templateData.detail : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), detail: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <SelectField
                          label="Trend"
                          value={typeof selectedScene.visual.templateData?.trend === 'string' ? selectedScene.visual.templateData.trend : 'up'}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), trend: value }
                                }
                              };
                            })
                          }
                          options={['up', 'down', 'flat']}
                        />
                        <Field
                          label="Delta"
                          value={typeof selectedScene.visual.templateData?.delta === 'string' ? selectedScene.visual.templateData.delta : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), delta: String(value) }
                                }
                              };
                            })
                          }
                        />
                      </>
                    ) : null}
                    {(selectedScene.visual.template === 'comparison' || selectedScene.visual.template === 'comparison_card') ? (
                      <>
                        <Field
                          label="Title"
                          value={typeof selectedScene.visual.templateData?.title === 'string' ? selectedScene.visual.templateData.title : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), title: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Items (name | feature:value; feature:value)"
                          value={Array.isArray(selectedScene.visual.templateData?.items)
                            ? (selectedScene.visual.templateData.items as Array<{ name?: string; features?: Array<{ label?: string; value?: string }> }>)
                              .map((item) => `${item.name ?? ''} | ${(item.features ?? []).map((feature) => `${feature.label ?? ''}:${feature.value ?? ''}`).join('; ')}`)
                              .join('\n')
                            : Array.isArray(selectedScene.visual.templateData?.rows)
                              ? (selectedScene.visual.templateData.rows as Array<{ label?: string; left?: string; right?: string }>)
                                .map((row) => `${row.label ?? ''} | ${row.left ?? ''} | ${row.right ?? ''}`)
                                .join('\n')
                              : ''}
                          asTextArea
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const items = String(value)
                                .split('\n')
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0)
                                .map((line) => {
                                  const [namePart, featurePart = ''] = line.split('|').map((part) => part.trim());
                                  const features = featurePart
                                    .split(';')
                                    .map((entry) => entry.trim())
                                    .filter(Boolean)
                                    .map((entry) => {
                                      const [label, ...rest] = entry.split(':');
                                      return { label: (label ?? '').trim(), value: rest.join(':').trim() };
                                    });
                                  return { name: namePart ?? '', features };
                                });
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), items }
                                }
                              };
                            })
                          }
                        />
                      </>
                    ) : null}
                    {selectedScene.visual.template === 'chart' ? (
                      <>
                        <Field
                          label="Title"
                          value={typeof selectedScene.visual.templateData?.title === 'string' ? selectedScene.visual.templateData.title : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), title: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <SelectField
                          label="Kind"
                          value={selectedScene.visual.templateData?.kind === 'line' ? 'line' : 'bar'}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), kind: value }
                                }
                              };
                            })
                          }
                          options={['bar', 'line']}
                        />
                        <Field
                          label="Unit"
                          value={typeof selectedScene.visual.templateData?.unit === 'string' ? selectedScene.visual.templateData.unit : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), unit: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Points (label | value)"
                          value={Array.isArray(selectedScene.visual.templateData?.points)
                            ? (selectedScene.visual.templateData.points as Array<{ label?: string; value?: number }>)
                              .map((point) => `${point.label ?? ''} | ${point.value ?? ''}`)
                              .join('\n')
                            : ''}
                          asTextArea
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const points = String(value)
                                .split('\n')
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0)
                                .map((line) => {
                                  const [labelPart, valuePart = ''] = line.split('|').map((part) => part.trim());
                                  const numeric = Number(valuePart);
                                  return { label: labelPart ?? '', value: Number.isFinite(numeric) ? numeric : 0 };
                                });
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), points }
                                }
                              };
                            })
                          }
                        />
                      </>
                    ) : null}
                    {selectedScene.visual.template === 'timeline' ? (
                      <>
                        <Field
                          label="Title"
                          value={typeof selectedScene.visual.templateData?.title === 'string' ? selectedScene.visual.templateData.title : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), title: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Events (date | label | detail)"
                          value={Array.isArray(selectedScene.visual.templateData?.events)
                            ? (selectedScene.visual.templateData.events as Array<{ date?: string; label?: string; detail?: string }>)
                              .map((event) => `${event.date ?? ''} | ${event.label ?? ''} | ${event.detail ?? ''}`)
                              .join('\n')
                            : ''}
                          asTextArea
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const events = String(value)
                                .split('\n')
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0)
                                .map((line) => {
                                  const parts = line.split('|').map((part) => part.trim());
                                  if (parts.length === 1) {
                                    return { label: parts[0] ?? '', detail: '' };
                                  }
                                  if (parts.length === 2) {
                                    return { label: parts[0] ?? '', detail: parts[1] ?? '' };
                                  }
                                  return { date: parts[0] || undefined, label: parts[1] ?? '', detail: parts.slice(2).join(' | ') };
                                });
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), events }
                                }
                              };
                            })
                          }
                        />
                      </>
                    ) : null}
                    {selectedScene.visual.template === 'location_card' ? (
                      <>
                        <Field
                          label="Place"
                          value={typeof selectedScene.visual.templateData?.place === 'string' ? selectedScene.visual.templateData.place : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), place: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Region"
                          value={typeof selectedScene.visual.templateData?.region === 'string' ? selectedScene.visual.templateData.region : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), region: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Detail"
                          value={typeof selectedScene.visual.templateData?.detail === 'string' ? selectedScene.visual.templateData.detail : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), detail: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Latitude"
                          value={typeof selectedScene.visual.templateData?.lat === 'number' ? String(selectedScene.visual.templateData.lat) : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const trimmed = String(value).trim();
                              const numeric = Number(trimmed);
                              const next = { ...(scene.visual.templateData ?? {}) };
                              if (!trimmed) {
                                delete next.lat;
                              } else {
                                next.lat = Number.isFinite(numeric) ? numeric : trimmed;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: next
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Longitude"
                          value={typeof selectedScene.visual.templateData?.lon === 'number' ? String(selectedScene.visual.templateData.lon) : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const trimmed = String(value).trim();
                              const numeric = Number(trimmed);
                              const next = { ...(scene.visual.templateData ?? {}) };
                              if (!trimmed) {
                                delete next.lon;
                              } else {
                                next.lon = Number.isFinite(numeric) ? numeric : trimmed;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: next
                                }
                              };
                            })
                          }
                        />
                      </>
                    ) : null}
                    {selectedScene.visual.template === 'route_map' ? (
                      <>
                        <Field
                          label="Title"
                          value={typeof selectedScene.visual.templateData?.title === 'string' ? selectedScene.visual.templateData.title : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), title: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Locations (id | label | lat | lon)"
                          value={Array.isArray(selectedScene.visual.templateData?.locations)
                            ? (selectedScene.visual.templateData.locations as Array<{ id?: string; label?: string; lat?: number; lon?: number }>)
                              .map((location) => [location.id ?? '', location.label ?? '', location.lat ?? '', location.lon ?? ''].join(' | '))
                              .join('\n')
                            : ''}
                          asTextArea
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const locations = String(value)
                                .split('\n')
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0)
                                .map((line) => {
                                  const parts = line.split('|').map((part) => part.trim());
                                  const location: { id: string; label: string; lat?: number; lon?: number } = {
                                    id: parts[0] ?? '',
                                    label: parts[1] ?? parts[0] ?? ''
                                  };
                                  if (parts[2]) {
                                    const lat = Number(parts[2]);
                                    if (Number.isFinite(lat)) {
                                      location.lat = lat;
                                    }
                                  }
                                  if (parts[3]) {
                                    const lon = Number(parts[3]);
                                    if (Number.isFinite(lon)) {
                                      location.lon = lon;
                                    }
                                  }
                                  return location;
                                });
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), locations }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Links (from | to)"
                          value={Array.isArray(selectedScene.visual.templateData?.links)
                            ? (selectedScene.visual.templateData.links as Array<{ from?: string; to?: string }>)
                              .map((link) => `${link.from ?? ''} | ${link.to ?? ''}`)
                              .join('\n')
                            : ''}
                          asTextArea
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const links = String(value)
                                .split('\n')
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0)
                                .map((line) => {
                                  const [from = '', to = ''] = line.split('|').map((part) => part.trim());
                                  return { from, to };
                                });
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), links }
                                }
                              };
                            })
                          }
                        />
                      </>
                    ) : null}
                    {selectedScene.visual.template === 'product_card' ? (
                      <>
                        <Field
                          label="Name"
                          value={typeof selectedScene.visual.templateData?.name === 'string' ? selectedScene.visual.templateData.name : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), name: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Subtitle"
                          value={typeof selectedScene.visual.templateData?.subtitle === 'string' ? selectedScene.visual.templateData.subtitle : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), subtitle: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Description"
                          value={typeof selectedScene.visual.templateData?.description === 'string' ? selectedScene.visual.templateData.description : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), description: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Price"
                          value={typeof selectedScene.visual.templateData?.price === 'number' ? String(selectedScene.visual.templateData.price) : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const trimmed = String(value).trim();
                              const numeric = Number(trimmed);
                              const next = { ...(scene.visual.templateData ?? {}) };
                              if (!trimmed) {
                                delete next.price;
                              } else {
                                next.price = Number.isFinite(numeric) ? numeric : trimmed;
                              }
                              return { ...scene, visual: { ...scene.visual, templateData: next } };
                            })
                          }
                        />
                        <Field
                          label="Currency"
                          value={typeof selectedScene.visual.templateData?.currency === 'string' ? selectedScene.visual.templateData.currency : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), currency: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <HtmlStillSlotImagePicker
                          projectId={draft.id}
                          assets={draft.assets}
                          excludeAssetIds={selectedScene.visual.assetId ? [selectedScene.visual.assetId] : []}
                          value={typeof selectedScene.visual.templateData?.imageAssetId === 'string' ? selectedScene.visual.templateData.imageAssetId : undefined}
                          label="Image"
                          onSelect={(assetId) => setHtmlStillSlotImage(selectedScene.id, assetId)}
                          onImport={(file) => void importHtmlStillSlotImage(selectedScene.id, file)}
                        />
                        <Field
                          label="Features (label | value)"
                          value={Array.isArray(selectedScene.visual.templateData?.features)
                            ? (selectedScene.visual.templateData.features as Array<{ label?: string; value?: string }>)
                              .map((feature) => `${feature.label ?? ''} | ${feature.value ?? ''}`)
                              .join('\n')
                            : ''}
                          asTextArea
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const features = String(value)
                                .split('\n')
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0)
                                .map((line) => {
                                  const [label = '', ...rest] = line.split('|').map((part) => part.trim());
                                  return { label, value: rest.join(' | ') };
                                });
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), features }
                                }
                              };
                            })
                          }
                        />
                      </>
                    ) : null}
                    {selectedScene.visual.template === 'product_comparison' ? (
                      <>
                        <Field
                          label="Title"
                          value={typeof selectedScene.visual.templateData?.title === 'string' ? selectedScene.visual.templateData.title : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), title: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Products (name | feature:value; feature:value)"
                          value={Array.isArray(selectedScene.visual.templateData?.products)
                            ? (selectedScene.visual.templateData.products as Array<{ name?: string; features?: Array<{ label?: string; value?: string }> }>)
                              .map((product) => `${product.name ?? ''} | ${(product.features ?? []).map((feature) => `${feature.label ?? ''}:${feature.value ?? ''}`).join('; ')}`)
                              .join('\n')
                            : ''}
                          asTextArea
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const existing = Array.isArray(scene.visual.templateData?.products)
                                ? (scene.visual.templateData.products as Array<{ imageAssetId?: string }>)
                                : [];
                              const products = String(value)
                                .split('\n')
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0)
                                .map((line, index) => {
                                  const parts = line.split('|').map((part) => part.trim());
                                  const featurePart = parts.slice(1).join('|');
                                  const features = featurePart
                                    .split(';')
                                    .map((entry) => entry.trim())
                                    .filter(Boolean)
                                    .map((entry) => {
                                      const [label, ...rest] = entry.split(':');
                                      return { label: (label ?? '').trim(), value: rest.join(':').trim() };
                                    });
                                  const product: { name: string; imageAssetId?: string; features: Array<{ label: string; value: string }> } = {
                                    name: parts[0] ?? '',
                                    features
                                  };
                                  if (existing[index]?.imageAssetId) {
                                    product.imageAssetId = existing[index].imageAssetId;
                                  }
                                  return product;
                                });
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), products }
                                }
                              };
                            })
                          }
                        />
                        {(Array.isArray(selectedScene.visual.templateData?.products)
                          ? (selectedScene.visual.templateData.products as Array<{ name?: string; imageAssetId?: string }>)
                          : []
                        ).map((product, index) => (
                          <HtmlStillSlotImagePicker
                            key={`product-image-${index}`}
                            projectId={draft.id}
                            assets={draft.assets}
                            excludeAssetIds={selectedScene.visual?.kind === 'html' && selectedScene.visual.assetId ? [selectedScene.visual.assetId] : []}
                            value={typeof product.imageAssetId === 'string' ? product.imageAssetId : undefined}
                            label={`${product.name?.trim() || `Product ${index + 1}`} image`}
                            onSelect={(assetId) => setHtmlStillSlotImage(selectedScene.id, assetId, index)}
                            onImport={(file) => void importHtmlStillSlotImage(selectedScene.id, file, index)}
                          />
                        ))}
                      </>
                    ) : null}
                    {selectedScene.visual.template === 'feature_callouts' ? (
                      <>
                        <Field
                          label="Name"
                          value={typeof selectedScene.visual.templateData?.name === 'string' ? selectedScene.visual.templateData.name : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), name: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <HtmlStillSlotImagePicker
                          projectId={draft.id}
                          assets={draft.assets}
                          excludeAssetIds={selectedScene.visual.assetId ? [selectedScene.visual.assetId] : []}
                          value={typeof selectedScene.visual.templateData?.imageAssetId === 'string' ? selectedScene.visual.templateData.imageAssetId : undefined}
                          label="Image"
                          onSelect={(assetId) => setHtmlStillSlotImage(selectedScene.id, assetId)}
                          onImport={(file) => void importHtmlStillSlotImage(selectedScene.id, file)}
                        />
                        <Field
                          label="Callouts (side | label | detail)"
                          value={Array.isArray(selectedScene.visual.templateData?.callouts)
                            ? (selectedScene.visual.templateData.callouts as Array<{ side?: string; label?: string; detail?: string }>)
                              .map((callout) => `${callout.side ?? ''} | ${callout.label ?? ''} | ${callout.detail ?? ''}`)
                              .join('\n')
                            : ''}
                          asTextArea
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const callouts = String(value)
                                .split('\n')
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0)
                                .map((line) => {
                                  const parts = line.split('|').map((part) => part.trim());
                                  if (parts[0] === 'left' || parts[0] === 'right') {
                                    return { side: parts[0], label: parts[1] ?? '', detail: parts.slice(2).join(' | ') };
                                  }
                                  return { label: parts[0] ?? '', detail: parts.slice(1).join(' | ') };
                                });
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), callouts }
                                }
                              };
                            })
                          }
                        />
                      </>
                    ) : null}
                    {selectedScene.visual.template === 'flow_diagram' ? (
                      <>
                        <Field
                          label="Title"
                          value={typeof selectedScene.visual.templateData?.title === 'string' ? selectedScene.visual.templateData.title : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), title: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Steps (id | label | detail)"
                          value={Array.isArray(selectedScene.visual.templateData?.steps)
                            ? (selectedScene.visual.templateData.steps as Array<{ id?: string; label?: string; detail?: string }>)
                              .map((step) => `${step.id ?? ''} | ${step.label ?? ''} | ${step.detail ?? ''}`)
                              .join('\n')
                            : ''}
                          asTextArea
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const steps = String(value)
                                .split('\n')
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0)
                                .map((line) => {
                                  const parts = line.split('|').map((part) => part.trim());
                                  const step: { id: string; label: string; detail?: string } = {
                                    id: parts[0] ?? '',
                                    label: parts[1] ?? ''
                                  };
                                  if (parts[2]) {
                                    step.detail = parts.slice(2).join(' | ');
                                  }
                                  return step;
                                });
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), steps }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Links (from | to)"
                          value={Array.isArray(selectedScene.visual.templateData?.links)
                            ? (selectedScene.visual.templateData.links as Array<{ from?: string; to?: string }>)
                              .map((link) => `${link.from ?? ''} | ${link.to ?? ''}`)
                              .join('\n')
                            : ''}
                          asTextArea
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const links = String(value)
                                .split('\n')
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0)
                                .map((line) => {
                                  const parts = line.split('|').map((part) => part.trim());
                                  return { from: parts[0] ?? '', to: parts[1] ?? '' };
                                });
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), links }
                                }
                              };
                            })
                          }
                        />
                      </>
                    ) : null}
                    {selectedScene.visual.template === 'decision_tree' ? (
                      <>
                        <Field
                          label="Title"
                          value={typeof selectedScene.visual.templateData?.title === 'string' ? selectedScene.visual.templateData.title : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), title: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Nodes (id | kind | label)"
                          value={Array.isArray(selectedScene.visual.templateData?.nodes)
                            ? (selectedScene.visual.templateData.nodes as Array<{ id?: string; kind?: string; label?: string }>)
                              .map((node) => `${node.id ?? ''} | ${node.kind ?? ''} | ${node.label ?? ''}`)
                              .join('\n')
                            : ''}
                          asTextArea
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const nodes = String(value)
                                .split('\n')
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0)
                                .map((line) => {
                                  const parts = line.split('|').map((part) => part.trim());
                                  return { id: parts[0] ?? '', kind: parts[1] ?? '', label: parts.slice(2).join(' | ') };
                                });
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), nodes }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Branches (from | to | label)"
                          value={Array.isArray(selectedScene.visual.templateData?.branches)
                            ? (selectedScene.visual.templateData.branches as Array<{ from?: string; to?: string; label?: string }>)
                              .map((branch) => `${branch.from ?? ''} | ${branch.to ?? ''} | ${branch.label ?? ''}`)
                              .join('\n')
                            : ''}
                          asTextArea
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const branches = String(value)
                                .split('\n')
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0)
                                .map((line) => {
                                  const parts = line.split('|').map((part) => part.trim());
                                  const branch: { from: string; to: string; label?: string } = {
                                    from: parts[0] ?? '',
                                    to: parts[1] ?? ''
                                  };
                                  if (parts[2]) {
                                    branch.label = parts.slice(2).join(' | ');
                                  }
                                  return branch;
                                });
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), branches }
                                }
                              };
                            })
                          }
                        />
                      </>
                    ) : null}
                    {selectedScene.visual.template === 'system_diagram' ? (
                      <>
                        <Field
                          label="Title"
                          value={typeof selectedScene.visual.templateData?.title === 'string' ? selectedScene.visual.templateData.title : ''}
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), title: String(value) }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Components (id | label | role)"
                          value={Array.isArray(selectedScene.visual.templateData?.components)
                            ? (selectedScene.visual.templateData.components as Array<{ id?: string; label?: string; role?: string }>)
                              .map((component) => `${component.id ?? ''} | ${component.label ?? ''} | ${component.role ?? ''}`)
                              .join('\n')
                            : ''}
                          asTextArea
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const components = String(value)
                                .split('\n')
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0)
                                .map((line) => {
                                  const parts = line.split('|').map((part) => part.trim());
                                  const component: { id: string; label: string; role?: string } = {
                                    id: parts[0] ?? '',
                                    label: parts[1] ?? ''
                                  };
                                  if (parts[2]) {
                                    component.role = parts.slice(2).join(' | ');
                                  }
                                  return component;
                                });
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), components }
                                }
                              };
                            })
                          }
                        />
                        <Field
                          label="Links (from | to | label)"
                          value={Array.isArray(selectedScene.visual.templateData?.links)
                            ? (selectedScene.visual.templateData.links as Array<{ from?: string; to?: string; label?: string }>)
                              .map((link) => `${link.from ?? ''} | ${link.to ?? ''} | ${link.label ?? ''}`)
                              .join('\n')
                            : ''}
                          asTextArea
                          onChange={(value) =>
                            updateScene(selectedScene.id, (scene) => {
                              if (!scene.visual || scene.visual.kind !== 'html') {
                                return scene;
                              }
                              const links = String(value)
                                .split('\n')
                                .map((line) => line.trim())
                                .filter((line) => line.length > 0)
                                .map((line) => {
                                  const parts = line.split('|').map((part) => part.trim());
                                  const link: { from: string; to: string; label?: string } = {
                                    from: parts[0] ?? '',
                                    to: parts[1] ?? ''
                                  };
                                  if (parts[2]) {
                                    link.label = parts.slice(2).join(' | ');
                                  }
                                  return link;
                                });
                              return {
                                ...scene,
                                visual: {
                                  ...scene.visual,
                                  templateData: { ...(scene.visual.templateData ?? {}), links }
                                }
                              };
                            })
                          }
                        />
                      </>
                    ) : null}
                    <SelectField
                      label="Background"
                      value={selectedScene.visual.background ?? 'opaque'}
                      onChange={(value) =>
                        updateScene(selectedScene.id, (scene) => {
                          if (!scene.visual || scene.visual.kind !== 'html') {
                            return scene;
                          }
                          return {
                            ...scene,
                            visual: {
                              ...scene.visual,
                              background: value === 'transparent' ? 'transparent' : 'opaque'
                            }
                          };
                        })
                      }
                      options={['opaque', 'transparent']}
                    />
                    <p className="text-xs text-slate-300">
                      {selectedScene.visual.assetId ? `PNG asset: ${selectedScene.visual.assetId}` : 'PNG not rendered yet'}
                    </p>
                    <button
                      type="button"
                      disabled={generatingSceneId === selectedScene.id}
                      onClick={() => void runHtmlStill(selectedScene.id, Boolean(selectedScene.visual && selectedScene.visual.kind === 'html' && selectedScene.visual.assetId))}
                      className="rounded-2xl bg-amber-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-60"
                    >
                      {generatingSceneId === selectedScene.id ? 'Rendering...' : selectedScene.visual.assetId ? 'Re-render HTML still' : 'Render HTML still'}
                    </button>
                  </div>
                ) : null}

                <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">References</p>
                  <div className="mt-2 space-y-2">
                    {draft.references.map((reference) => {
                      const selected = selectedScene.referenceIds.includes(reference.id);
                      return (
                        <button
                          key={reference.id}
                          type="button"
                          onClick={() =>
                            setSceneReferences(
                              selectedScene.id,
                              selected ? selectedScene.referenceIds.filter((entry) => entry !== reference.id) : [...selectedScene.referenceIds, reference.id]
                            )
                          }
                          className={`w-full rounded-2xl border px-3 py-2 text-left text-sm ${selected ? 'border-amber-300/50 bg-amber-200/10 text-amber-50' : 'border-slate-700/70 bg-slate-950/30 text-slate-200'}`}
                        >
                          {reference.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {assetMessage ? <p className="text-xs text-slate-300">{assetMessage}</p> : null}
                {generationMessage ? <p className="text-xs text-slate-300">{generationMessage}</p> : null}
              </div>
            ) : (
              <EmptyPanel message="Select a scene to edit its properties." />
            )}
          </aside>
        </div>
      ) : null}

      {activeTab === 'assets' ? (
        <div className="space-y-6">
          <BackgroundMusicPanel project={draft} onRefresh={refreshProject} />
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="studio-panel rounded-[28px] p-4 shadow-panel">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-700/70 pb-4">
              <button type="button" onClick={() => libraryAssetFileInput.current?.click()} className="rounded-2xl bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950">Import asset</button>
              <input
                ref={libraryAssetFileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/mp4,.mov,.m4a"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = '';
                  if (file) {
                    void importAsset(file);
                  }
                }}
              />
              <input value={assetQuery} onChange={(event) => setAssetQuery(event.target.value)} placeholder="Filter by filename" className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100" />
              <select value={assetFilter} onChange={(event) => setAssetFilter(event.target.value as AssetFilter)} className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100">
                <option value="all">All</option>
                <option value="images">Images</option>
                <option value="video">Video</option>
                <option value="audio">Audio</option>
                <option value="generated">Generated</option>
                <option value="imported">Imported</option>
              </select>
              {assetMessage ? <span className="text-xs text-slate-300">{assetMessage}</span> : null}
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filteredAssets.map((asset) => {
                const usage = getAssetUsage(draft, asset.id);
                return (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => setSelectedAssetId(asset.id)}
                    className={`rounded-2xl border p-3 text-left ${selectedAssetId === asset.id ? 'border-amber-300/50 bg-amber-200/10' : 'border-slate-700/70 bg-slate-950/30'}`}
                  >
                    <div className="relative aspect-video overflow-hidden rounded-xl border border-slate-700/70 bg-slate-900">
                      {assetTypeGroup(asset.type) === 'images' ? (
                        <Image src={joinProjectAssetUrl(draft.id, asset.id)} alt={asset.filename} fill unoptimized sizes="240px" className="object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs text-slate-400">{asset.type.toUpperCase()}</div>
                      )}
                    </div>
                    <p className="mt-2 truncate text-sm font-semibold text-white">{asset.filename}</p>
                    <p className="text-xs text-slate-400">{asset.width && asset.height ? `${asset.width}x${asset.height}` : 'No dimensions'} • {formatDuration(asset.duration)}</p>
                    <p className="text-xs text-slate-400">{asset.provenance} • {asset.status} • used by {usage.length}</p>
                  </button>
                );
              })}
            </div>
          </section>

          <aside className="studio-panel rounded-[28px] p-4 shadow-panel">
            {selectedAsset ? (
              <div className="space-y-3">
                <h3 className="text-lg font-semibold text-white">Asset details</h3>
                <p className="text-sm text-slate-300">Filename: {selectedAsset.filename}</p>
                <p className="text-sm text-slate-300">Type: {selectedAsset.type}</p>
                <p className="text-sm text-slate-300">MIME: {selectedAsset.mimeType ?? 'Unknown'}</p>
                <p className="text-sm text-slate-300">Dimensions: {selectedAsset.width && selectedAsset.height ? `${selectedAsset.width}x${selectedAsset.height}` : 'Unknown'}</p>
                <p className="text-sm text-slate-300">Duration: {formatDuration(selectedAsset.duration)}</p>
                <p className="text-sm text-slate-300">File size: {formatSize(selectedAsset.filesize)}</p>
                <p className="text-sm text-slate-300">Provenance: {selectedAsset.provenance}</p>
                <p className="text-sm text-slate-300">Status: {selectedAsset.status}</p>
                <p className="text-sm text-slate-300">Created: {selectedAsset.createdAt}</p>
                <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Used by scenes</p>
                  <div className="mt-2 space-y-2">
                    {getAssetUsage(draft, selectedAsset.id).map((sceneId) => {
                      const scene = draft.scenes.find((entry) => entry.id === sceneId);
                      if (!scene) return null;
                      return (
                        <button
                          key={sceneId}
                          type="button"
                          onClick={() => {
                            setSelectedSceneId(sceneId);
                            setActiveTab('scenes');
                          }}
                          className="w-full rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-2 text-left text-sm text-slate-200"
                        >
                          Scene {String(scene.order).padStart(2, '0')}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <button type="button" onClick={() => void deleteSelectedAsset()} className="rounded-2xl border border-rose-400/60 bg-rose-400/10 px-4 py-2 text-sm text-rose-100">Delete asset</button>
              </div>
            ) : (
              <EmptyPanel message="Select an asset to inspect metadata and usage." />
            )}
          </aside>
          </div>
        </div>
      ) : null}

      {activeTab === 'references' ? (
        <ReferencesPanel
          project={draft}
          references={filteredReferences}
          referenceQuery={referenceQuery}
          onReferenceQueryChange={setReferenceQuery}
          selectedReferenceId={selectedReferenceId}
          onSelectReference={setSelectedReferenceId}
          onNavigateScene={(sceneId) => {
            setSelectedSceneId(sceneId);
            setActiveTab('scenes');
          }}
          newReferenceName={newReferenceName}
          newReferenceDescription={newReferenceDescription}
          newReferenceTags={newReferenceTags}
          onNewReferenceNameChange={setNewReferenceName}
          onNewReferenceDescriptionChange={setNewReferenceDescription}
          onNewReferenceTagsChange={setNewReferenceTags}
          onImportReference={(file) => void importReference(file)}
          onSaveReferenceDetails={(reference, fields) => void saveReferenceDetails(reference, fields)}
          onDeleteReference={() => void deleteSelectedReference()}
          referenceMessage={referenceMessage}
        />
      ) : null}

      {activeTab === 'generation' ? (
        <section className="studio-panel rounded-[28px] p-4 shadow-panel">
          <h2 className="text-xl font-semibold text-white">Generation Tasks</h2>
          <p className="mt-1 text-sm text-slate-400">Generate AI images and videos from scene specs. Video jobs run async and are resumed from persisted state.</p>
          <p className="mt-2 text-xs text-slate-300">
            AI Image Generation: {providerStatus ? `Default provider ${providerStatus.defaultProvider}` : 'Checking configuration...'}
          </p>
          <div className="mt-4 grid gap-3">
            {generationTasks.length === 0 ? (
              <EmptyPanel message="No generated_image or generated_video scenes found." />
            ) : (
              generationTasks.map((task) => {
                const scene = draft.scenes.find((entry) => entry.id === task.sceneId);
                const isImageTask = scene?.visual?.kind === 'generated_image';
                const currentAssetId = scene?.visual && (scene.visual.kind === 'generated_image' || scene.visual.kind === 'generated_video') ? scene.visual.assetId || scene.visual.generation.assetId : undefined;
                return (
                <div key={task.generation.id} className="rounded-2xl border border-slate-700/70 bg-slate-950/30 p-4 text-left">
                  <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">Scene {String(task.sceneOrder).padStart(2, '0')}</p>
                  <p className="mt-1 text-sm font-semibold text-white">{task.generation.kind.toUpperCase()}</p>
                  <p className="text-sm text-slate-300">Status: {task.generation.status}</p>
                  <p className="text-sm text-slate-300">Provider: {task.generation.provider ?? 'not set'}</p>
                  <p className="text-sm text-slate-300">Model: {task.generation.model ?? 'default'}</p>
                  <p className="text-sm text-slate-300">References: {task.generation.referenceIds?.length ?? 0}</p>
                  <p className="mt-2 text-sm text-slate-200">{task.generation.prompt || 'No prompt yet.'}</p>
                  <p className="mt-2 text-xs text-slate-400">Readiness: {task.readiness}</p>

                  {task.generation.error ? <p className="mt-2 text-xs text-rose-300">Reason: {task.generation.error}</p> : null}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSceneId(task.sceneId);
                        setActiveTab('scenes');
                      }}
                      className="rounded-2xl border border-slate-700 px-3 py-2 text-xs text-slate-200"
                    >
                      Open Scene
                    </button>

                    {currentAssetId ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedAssetId(currentAssetId);
                          setActiveTab('assets');
                        }}
                        className="rounded-2xl border border-slate-700 px-3 py-2 text-xs text-slate-200"
                      >
                        View Asset
                      </button>
                    ) : null}

                    {isImageTask ? (
                      <button
                        type="button"
                        disabled={generatingSceneId === task.sceneId}
                        onClick={() => void runImageGeneration(task.sceneId, task.generation.status === 'generated')}
                        className="rounded-2xl bg-amber-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-60"
                      >
                        {generatingSceneId === task.sceneId ? 'Generating...' : task.generation.status === 'generated' ? 'Regenerate' : task.generation.status === 'failed' ? 'Retry' : 'Generate Image'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={generatingSceneId === task.sceneId}
                        onClick={() => {
                          if (task.generation.status === 'queued' || task.generation.status === 'generating') {
                            void pollVideoGenerationAttempt(task.generation.id).then(() => refreshProject());
                            return;
                          }
                          void runVideoGeneration(task.sceneId, task.generation.status === 'generated');
                        }}
                        className="rounded-2xl bg-amber-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-60"
                      >
                        {generatingSceneId === task.sceneId
                          ? 'Submitting...'
                          : task.generation.status === 'queued' || task.generation.status === 'generating'
                            ? 'Poll Video Status'
                            : task.generation.status === 'generated'
                              ? 'Regenerate Video'
                              : task.generation.status === 'failed' || task.generation.status === 'rejected'
                                ? 'Retry Video'
                                : 'Generate Video'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
            )}
          </div>
          {generationMessage ? <p className="mt-3 text-xs text-slate-300">{generationMessage}</p> : null}
        </section>
      ) : null}

      <section className="studio-panel rounded-[24px] p-4 shadow-panel">
        <ValidationPanel validation={validation} />
      </section>
    </div>
  );
}

