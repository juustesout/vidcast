'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ASPECT_RATIOS, GENERATION_PROVIDERS, GENERATION_STATUSES, MOTION_PRESETS, OVERLAY_TYPES, SCENE_TYPES, TRANSITION_PRESETS } from '@/lib/constants';
import { ExplainerStoryWorkspace } from '@/components/project/explainer-story-workspace';
import { ProductionWorkflow } from '@/components/project/production-workflow';
import { ServerRunPanel } from '@/components/project/server-run-panel';
import { ScenePreview } from '@/components/preview/scene-preview';
import { ValidationPanel } from '@/components/project/validation-panel';
import { createProjectCompositionRequest, createSceneNarrationRequest, createSceneRenderRequest } from '@/lib/client/render-client';
import { deriveGenerationTasks } from '@/lib/projects/generation-tasks';
import { deriveCompositionArtifactStatus, deriveCompositionReadiness, deriveSceneRenderStatus, formatRenderStatusLabel } from '@/lib/render/render-status';
import { getAssetUsage, getReferenceUsage } from '@/lib/projects/usage';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { createId } from '@/lib/utils/ids';
import { joinProjectAssetUrl, joinProjectReferenceUrl } from '@/lib/utils/project-files';
import { deriveActiveWorkflowStepId } from '@/lib/workflow/workflow-navigation';
import { deriveWorkflowStatus } from '@/lib/workflow/workflow-status';
import { deriveProductionPlan, groupProductionActionsByScene, type ProductionPlannedAction } from '@/lib/production/production-planner';
import { createProductionRunnerError, runProductionBatch, type ProductionActionExecutionOutcome, type ProductionRunnerEvent, type ProductionRunnerResultStatus } from '@/lib/production/production-runner';
import { formatProductionLogAsText } from '@/lib/production/production-log-export';
import type { WorkflowNavigationTarget, WorkflowStepId } from '@/lib/workflow/workflow-status';
import type { GenerationProvider, GenerationStatus } from '@/lib/types/generation';
import type { Project } from '@/lib/types/render';
import type { ReferenceImage } from '@/lib/types/reference';
import type { GraphicTemplateType, OverlaySpec, Scene, VisualSpec } from '@/lib/types/scene';
import { validateProject } from '@/lib/validation/project-validation';

interface ProjectWorkspaceProps {
  project: Project;
}

type VisualMode = 'asset' | 'generated_image' | 'generated_video' | 'graphic' | 'text' | 'blank';
type WorkspaceTab = 'story' | 'scenes' | 'assets' | 'references' | 'generation';
type AssetFilter = 'all' | 'images' | 'video' | 'audio' | 'generated' | 'imported';
type StoryFocusArea = 'brief' | 'story' | 'scene_plan';

const GRAPHIC_TEMPLATES: GraphicTemplateType[] = ['title_card', 'bullet_list', 'statistic', 'quote', 'comparison', 'simple_diagram', 'callout', 'end_card'];

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
    case 'video_submit':
      return 'Video';
    case 'video_poll':
      return 'Video Poll';
    case 'narration_generate':
      return 'Narration';
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
  const [providerStatus, setProviderStatus] = useState<{ openaiConfigured: boolean; defaultProvider: string } | null>(null);
  const isVideoPollingRef = useRef(false);
  const batchCopyResetTimerRef = useRef<number | null>(null);

  const [newReferenceName, setNewReferenceName] = useState('Main Character');
  const [newReferenceDescription, setNewReferenceDescription] = useState('');
  const [newReferenceTags, setNewReferenceTags] = useState('');

  const sceneAssetFileInput = useRef<HTMLInputElement | null>(null);
  const libraryAssetFileInput = useRef<HTMLInputElement | null>(null);
  const referenceFileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void fetch('/api/auth/session', {
      method: 'POST'
    }).catch(() => {
      // Protected API calls surface errors if session bootstrap fails.
    });
  }, []);

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
      const body = (await response.json().catch(() => null)) as { openaiConfigured: boolean; defaultProvider: string } | null;
      if (response.ok && body) {
        setProviderStatus(body);
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

  function addScene(): void {
    updateProject({
      ...draft,
      scenes: [...draft.scenes, defaultScene(draft.scenes.length + 1)]
    });
  }

  function setVisualMode(scene: Scene, mode: VisualMode): void {
    updateScene(scene.id, (current) => {
      const visual = ensureVisualForMode(current, mode);
      const type = mode === 'generated_video' ? 'video' : mode === 'graphic' ? 'graphic' : mode === 'text' ? 'text' : mode === 'blank' ? 'blank' : 'image';
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

  async function executeProductionAction(action: ProductionPlannedAction): Promise<ProductionActionExecutionOutcome | void> {
    if (!action.execute) {
      return;
    }

    if (action.type === 'image_generate' && action.sceneId) {
      const regenerate = Boolean(action.payload?.regenerate);
      setGeneratingSceneId(action.sceneId);
      const endpoint = `/api/projects/${draft.id}/scenes/${action.sceneId}/generate-image`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerate })
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
        status?: string;
        providerStatus?: string;
        generationAttemptId?: string;
      };
      setGeneratingSceneId(null);
      if (!response.ok) {
        throw createProductionRunnerError(body.message || 'Image generation failed.', {
          message: body.message || 'Image generation failed.',
          code: body.code,
          endpoint,
          httpStatus: response.status,
          providerStatus: body.providerStatus,
          sceneId: action.sceneId,
          attemptId: body.generationAttemptId
        });
      }
      return {
        message: body.message || body.status || 'Image generation completed.',
        endpoint,
        providerStatus: body.providerStatus,
        sceneId: action.sceneId,
        attemptId: body.generationAttemptId
      };
    }

    if (action.type === 'video_submit' && action.sceneId) {
      const regenerate = Boolean(action.payload?.regenerate);
      setGeneratingSceneId(action.sceneId);
      const endpoint = `/api/projects/${draft.id}/scenes/${action.sceneId}/generate-video`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerate })
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string; status?: string; providerStatus?: string; generationAttemptId?: string };
      setGeneratingSceneId(null);
      if (!response.ok) {
        throw createProductionRunnerError(body.message || 'Video submit failed.', {
          message: body.message || 'Video submit failed.',
          code: body.code,
          endpoint,
          httpStatus: response.status,
          providerStatus: body.providerStatus,
          sceneId: action.sceneId,
          attemptId: body.generationAttemptId
        });
      }
      return {
        message: body.message || body.status || 'Video generation submitted.',
        endpoint,
        providerStatus: body.providerStatus,
        sceneId: action.sceneId,
        attemptId: body.generationAttemptId
      };
    }

    if (action.type === 'video_poll') {
      const attemptId = String(action.payload?.attemptId ?? '');
      if (!attemptId) {
        throw createProductionRunnerError('Missing video attempt id for polling.', {
          endpoint: `/api/projects/${draft.id}/generation-jobs/:attemptId`,
          message: 'Missing video attempt id for polling.'
        });
      }
      const endpoint = `/api/projects/${draft.id}/generation-jobs/${attemptId}`;
      const response = await fetch(endpoint);
      const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string; status?: string; providerStatus?: string };
      if (!response.ok) {
        throw createProductionRunnerError(body.message || 'Video poll failed.', {
          message: body.message || 'Video poll failed.',
          code: body.code,
          endpoint,
          httpStatus: response.status,
          providerStatus: body.providerStatus,
          sceneId: action.sceneId,
          attemptId
        });
      }
      return {
        message: body.message || body.status || 'Video poll completed.',
        endpoint,
        providerStatus: body.providerStatus,
        sceneId: action.sceneId,
        attemptId
      };
    }

    if (action.type === 'narration_generate' && action.sceneId) {
      const scene = draft.scenes.find((entry) => entry.id === action.sceneId);
      if (!scene) {
        throw createProductionRunnerError(`Scene ${action.sceneId} not found for narration.`, {
          endpoint: `/api/projects/${draft.id}/scenes/${action.sceneId}/generate-narration`,
          sceneId: action.sceneId
        });
      }

      const mode = String(action.payload?.mode ?? 'generate');
      setNarratingSceneId(action.sceneId);
      const result = await createSceneNarrationRequest(draft.id, action.sceneId, {
        text: scene.narration?.text,
        voiceId: scene.narration?.voiceId,
        model: scene.narration?.model,
        format: scene.narration?.format ?? 'mp3',
        regenerate: mode === 'regenerate',
        retry: mode === 'retry'
      });
      setNarratingSceneId(null);
      if (!result.ok) {
        throw createProductionRunnerError(result.message || 'Narration generation failed.', {
          message: result.message || 'Narration generation failed.',
          endpoint: `/api/projects/${draft.id}/scenes/${action.sceneId}/generate-narration`,
          sceneId: action.sceneId,
          attemptId: result.narration?.generationAttemptId
        });
      }
      return {
        message: result.message || 'Narration generation completed.',
        endpoint: `/api/projects/${draft.id}/scenes/${action.sceneId}/generate-narration`,
        sceneId: action.sceneId,
        attemptId: result.narration?.generationAttemptId
      };
    }

    if (action.type === 'scene_render' && action.sceneId) {
      setRenderingSceneId(action.sceneId);
      const result = await createSceneRenderRequest(draft.id, action.sceneId);
      setRenderingSceneId(null);
      if (!result.ok) {
        throw createProductionRunnerError(result.message || 'Scene render failed.', {
          message: result.message || 'Scene render failed.',
          code: result.code,
          details: result.details,
          endpoint: `/api/projects/${draft.id}/scenes/${action.sceneId}/render`,
          sceneId: action.sceneId
        });
      }
      return {
        message: result.message || 'Scene render completed.',
        code: result.code,
        details: result.details,
        endpoint: `/api/projects/${draft.id}/scenes/${action.sceneId}/render`,
        sceneId: action.sceneId
      };
    }

    if (action.type === 'final_compose') {
      setComposingProject(true);
      setCompositionFailed(false);
      const result = await createProjectCompositionRequest(draft.id);
      setComposingProject(false);
      if (!result.ok) {
        setCompositionFailed(true);
        throw createProductionRunnerError(result.message || 'Final composition failed.', {
          message: result.message || 'Final composition failed.',
          code: result.code,
          details: result.details,
          endpoint: `/api/projects/${draft.id}/compose`
        });
      }
      setCompositionFailed(false);
      return {
        message: result.message || 'Final composition completed.',
        code: result.code,
        details: result.details,
        endpoint: `/api/projects/${draft.id}/compose`
      };
    }
  }

  async function runProduceReady(): Promise<void> {
    if (batchRunning) {
      return;
    }

    const saved = await saveProject();
    if (!saved) {
      setBatchMessage('Could not save project before production run.');
      return;
    }

    setBatchRunning(true);
    setBatchOutcome('running');
    setBatchFailedActionIds([]);
    setBatchMessage('Starting production run...');
    setBatchSummary({ running: 0, completed: 0, failed: 0, waiting: 0 });
    setBatchEvents([]);

    try {
      const result = await runProductionBatch({
        initialProject: draft,
        derivePlan: (project, options) => deriveProductionPlan(project, {
          ...options,
          runtime: {
            runningGenerationSceneIds: generatingSceneId ? [generatingSceneId] : [],
            runningNarrationSceneIds: narratingSceneId ? [narratingSceneId] : [],
            runningRenderSceneIds: renderingSceneId ? [renderingSceneId] : [],
            composing: composingProject
          }
        }),
        executeAction: async (action) => {
          try {
            await executeProductionAction(action);
          } catch (error) {
            setBatchFailedActionIds((existing) => existing.includes(action.id) ? existing : [...existing, action.id]);
            throw error;
          }
        },
        refreshProject: async () => {
          const refreshed = await refreshProject();
          return refreshed ?? draft;
        },
        onProgress: (progress) => {
          setBatchSummary({
            running: progress.plan.summary.running,
            completed: progress.completedActionIds.length,
            failed: progress.failedActionIds.length,
            waiting: progress.plan.summary.waiting
          });
        },
        onEvent: (event) => {
          setBatchEvents((existing) => [...existing, event]);
        }
      });

      const waitingCount = result.unresolvedActions.filter((action) => action.status === 'waiting_dependency').length;
      const runningCount = result.unresolvedActions.filter((action) => action.status === 'running').length;
      setBatchSummary({
        running: runningCount,
        completed: result.completedActionIds.length,
        failed: result.failedActionIds.length,
        waiting: waitingCount
      });

      setBatchOutcome(result.status);
      if (result.status === 'completed') {
        setBatchMessage('Production finished successfully.');
      } else if (result.status === 'partial') {
        setBatchMessage('Production finished with partial completion.');
      } else if (result.status === 'failed') {
        setBatchMessage(`Production finished with failures (${result.failedActionIds.length}).`);
      } else {
        setBatchMessage(`Production stopped with unresolved actions (${result.unresolvedActions.length}).`);
      }
      await refreshProject();
    } catch (error) {
      setBatchOutcome('failed');
      setBatchMessage(error instanceof Error ? error.message : 'Production run failed unexpectedly.');
    } finally {
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

  async function runVideoGeneration(sceneId: string, regenerate: boolean): Promise<void> {
    setGeneratingSceneId(sceneId);
    setGenerationMessage(regenerate ? 'Submitting video regeneration job...' : 'Submitting video generation job...');

    const response = await fetch(`/api/projects/${draft.id}/scenes/${sceneId}/generate-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate })
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

    poll();
    const timer = window.setInterval(poll, 5000);
    return () => window.clearInterval(timer);
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
                <SelectField label="Visual source" value={visualModeOf(selectedScene)} onChange={(value) => setVisualMode(selectedScene, value as VisualMode)} options={['asset', 'generated_image', 'generated_video', 'graphic', 'text', 'blank']} />
                <SelectField label="Motion" value={selectedScene.render.motion.preset} onChange={(value) => updateScene(selectedScene.id, (scene) => ({ ...scene, render: { ...scene.render, motion: { ...scene.render.motion, preset: value as Scene['render']['motion']['preset'] } } }))} options={MOTION_PRESETS} />
                <SelectField label="Transition" value={selectedScene.render.transition.type} onChange={(value) => updateScene(selectedScene.id, (scene) => ({ ...scene, render: { ...scene.render, transition: { ...scene.render.transition, type: value as Scene['render']['transition']['type'] } } }))} options={TRANSITION_PRESETS} />
                <SelectField label="Overlay type" value={selectedScene.overlay?.type ?? 'none'} onChange={(value) => updateScene(selectedScene.id, (scene) => ({ ...scene, overlay: { ...(scene.overlay ?? {}), type: value as OverlaySpec['type'] } }))} options={OVERLAY_TYPES} />
                <Field label="Overlay text" value={selectedScene.overlay?.text ?? ''} onChange={(value) => updateScene(selectedScene.id, (scene) => ({ ...scene, overlay: { ...(scene.overlay ?? { type: 'text' }), text: String(value) } }))} asTextArea />
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
                            Warning: narration audio ({audioAsset.duration.toFixed(2)}s) is longer than scene duration ({selectedScene.duration.toFixed(2)}s).
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
                      options={GENERATION_PROVIDERS}
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
                            updateScene(selectedScene.id, (scene) => ({
                              ...scene,
                              referenceIds: selected ? scene.referenceIds.filter((entry) => entry !== reference.id) : [...scene.referenceIds, reference.id]
                            }))
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
      ) : null}

      {activeTab === 'references' ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="studio-panel rounded-[28px] p-4 shadow-panel">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-700/70 pb-4">
              <input value={newReferenceName} onChange={(event) => setNewReferenceName(event.target.value)} placeholder="Reference name" className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100" />
              <input value={newReferenceDescription} onChange={(event) => setNewReferenceDescription(event.target.value)} placeholder="Description" className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100" />
              <input value={newReferenceTags} onChange={(event) => setNewReferenceTags(event.target.value)} placeholder="tags,comma,separated" className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100" />
              <button type="button" onClick={() => referenceFileInput.current?.click()} className="rounded-2xl bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950">Import reference</button>
              <input
                ref={referenceFileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = '';
                  if (file) {
                    void importReference(file);
                  }
                }}
              />
              <input value={referenceQuery} onChange={(event) => setReferenceQuery(event.target.value)} placeholder="Filter references" className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100" />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filteredReferences.map((reference) => {
                const usage = getReferenceUsage(draft, reference.id);
                return (
                  <button
                    key={reference.id}
                    type="button"
                    onClick={() => setSelectedReferenceId(reference.id)}
                    className={`rounded-2xl border p-3 text-left ${selectedReferenceId === reference.id ? 'border-amber-300/50 bg-amber-200/10' : 'border-slate-700/70 bg-slate-950/30'}`}
                  >
                    <div className="relative aspect-video overflow-hidden rounded-xl border border-slate-700/70 bg-slate-900">
                      {reference.filePath ? <Image src={joinProjectReferenceUrl(draft.id, reference.id)} alt={reference.name} fill unoptimized sizes="240px" className="object-cover" /> : null}
                    </div>
                    <p className="mt-2 truncate text-sm font-semibold text-white">{reference.name}</p>
                    <p className="text-xs text-slate-400 line-clamp-2">{reference.description}</p>
                    <p className="text-xs text-slate-400">{reference.tags.join(', ') || 'No tags'} • used by {usage.length}</p>
                  </button>
                );
              })}
            </div>
          </section>

          <aside className="studio-panel rounded-[28px] p-4 shadow-panel">
            {selectedReference ? (
              <ReferenceDetailCard
                project={draft}
                reference={selectedReference}
                onNavigateScene={(sceneId) => {
                  setSelectedSceneId(sceneId);
                  setActiveTab('scenes');
                }}
                onSave={(fields) => void saveReferenceDetails(selectedReference, fields)}
                onDelete={() => void deleteSelectedReference()}
              />
            ) : (
              <EmptyPanel message="Select a reference to inspect and edit." />
            )}
            {referenceMessage ? <p className="mt-3 text-xs text-slate-300">{referenceMessage}</p> : null}
          </aside>
        </div>
      ) : null}

      {activeTab === 'generation' ? (
        <section className="studio-panel rounded-[28px] p-4 shadow-panel">
          <h2 className="text-xl font-semibold text-white">Generation Tasks</h2>
          <p className="mt-1 text-sm text-slate-400">Generate AI images and videos from scene specs. Video jobs run async and are resumed from persisted state.</p>
          <p className="mt-2 text-xs text-slate-300">
            AI Image Generation: {providerStatus ? providerStatus.openaiConfigured ? 'OpenAI configured' : 'OpenAI not configured. Set OPENAI_API_KEY on the server.' : 'Checking configuration...'}
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

function TabButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-2xl border px-4 py-2 text-sm ${active ? 'border-amber-300/50 bg-amber-200/10 text-amber-100' : 'border-slate-700/70 bg-slate-950/40 text-slate-200'}`}
    >
      {children}
    </button>
  );
}

function InfoMiniCard({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-3 text-sm">
      <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">{label}</p>
      <p className="mt-1 text-slate-100">{value}</p>
    </div>
  );
}

function ReferenceDetailCard({
  project,
  reference,
  onNavigateScene,
  onSave,
  onDelete
}: {
  project: Project;
  reference: ReferenceImage;
  onNavigateScene: (sceneId: string) => void;
  onSave: (fields: { name: string; description: string; tags: string[] }) => void;
  onDelete: () => void;
}): JSX.Element {
  const [name, setName] = useState(reference.name);
  const [description, setDescription] = useState(reference.description);
  const [tags, setTags] = useState(reference.tags.join(', '));

  const usage = getReferenceUsage(project, reference.id);

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold text-white">Reference details</h3>
      <div className="relative aspect-video overflow-hidden rounded-xl border border-slate-700/70 bg-slate-900">
        {reference.filePath ? <Image src={joinProjectReferenceUrl(project.id, reference.id)} alt={reference.name} fill unoptimized sizes="320px" className="object-cover" /> : null}
      </div>
      <Field label="Name" value={name} onChange={(value) => setName(String(value))} />
      <Field label="Description" value={description} onChange={(value) => setDescription(String(value))} asTextArea />
      <Field label="Tags" value={tags} onChange={(value) => setTags(String(value))} />

      <div className="rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3">
        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Used by scenes</p>
        <div className="mt-2 space-y-2">
          {usage.map((sceneId) => {
            const scene = project.scenes.find((entry) => entry.id === sceneId);
            if (!scene) return null;
            return (
              <button
                key={scene.id}
                type="button"
                onClick={() => onNavigateScene(scene.id)}
                className="w-full rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-2 text-left text-sm text-slate-200"
              >
                Scene {String(scene.order).padStart(2, '0')}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() =>
            onSave({
              name,
              description,
              tags: tags
                .split(',')
                .map((entry: string) => entry.trim())
                .filter(Boolean)
            })
          }
          className="rounded-2xl bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950"
        >
          Save reference
        </button>
        <button type="button" onClick={onDelete} className="rounded-2xl border border-rose-400/60 bg-rose-400/10 px-4 py-2 text-sm text-rose-100">Delete reference</button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  step,
  asTextArea = false
}: {
  label: string;
  value: string | number;
  onChange: (value: string | number) => void;
  type?: 'text' | 'number';
  step?: string;
  asTextArea?: boolean;
}): JSX.Element {
  return (
    <label className="grid gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">{label}</span>
      {asTextArea ? (
        <textarea
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-20 rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-300/50"
        />
      ) : (
        <input
          type={type}
          step={step}
          value={value}
          onChange={(event) => onChange(type === 'number' ? Number(event.target.value) : event.target.value)}
          className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-300/50"
        />
      )}
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
}): JSX.Element {
  return (
    <label className="grid gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-2xl border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-300/50"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function EmptyPanel({ message }: { message: string }) {
  return <div className="rounded-[24px] border border-dashed border-slate-700 p-8 text-center text-slate-400">{message}</div>;
}
