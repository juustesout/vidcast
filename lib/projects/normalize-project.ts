import { DEFAULT_RENDER_SETTINGS } from '@/lib/constants';
import { normalizeExplainer } from '@/lib/projects/explainer-normalization';
import { normalizeAudioMix } from '@/lib/render/audio-mix';
import type { Asset, AssetProvenance } from '@/lib/types/asset';
import type { GenerationRecord, GenerationStatus } from '@/lib/types/generation';
import type { Project } from '@/lib/types/render';
import type { ReferenceImage } from '@/lib/types/reference';
import type { MotionPreset, MotionSpec, NarrationGenerationAttempt, NarrationSpec, OverlaySpec, RenderSpec, Scene, SceneType, TransitionPreset, VisualSpec } from '@/lib/types/scene';

type LegacyScene = {
  id?: string;
  order?: number;
  duration?: number;
  type?: SceneType;
  narration?: string | { text?: string; voiceId?: string; audioAssetId?: string };
  visual?: Record<string, unknown>;
  assetIds?: string[];
  referenceIds?: string[];
  motion?: MotionPreset;
  transition?: TransitionPreset;
  textOverlay?: string;
  notes?: string;
  render?: RenderSpec;
  overlay?: OverlaySpec;
};

function nowIso(): string {
  return new Date().toISOString();
}

function inferAssetProvenance(asset: Partial<Asset>): AssetProvenance {
  if (asset.provenance) {
    return asset.provenance;
  }

  if (asset.status === 'generated') {
    return 'generated';
  }

  return 'imported';
}

function normalizeMotion(motion?: MotionPreset | MotionSpec): MotionSpec {
  if (!motion) {
    return { preset: 'zoom_in' };
  }

  if (typeof motion === 'string') {
    return { preset: motion };
  }

  return {
    preset: motion.preset,
    intensity: motion.intensity,
    startScale: motion.startScale,
    endScale: motion.endScale,
    focalPoint: motion.focalPoint
  };
}

function normalizeTransition(transition?: TransitionPreset | { type: TransitionPreset; duration?: number }) {
  if (!transition) {
    return { type: 'fade' as const };
  }

  if (typeof transition === 'string') {
    return { type: transition };
  }

  return {
    type: transition.type,
    duration: transition.duration
  };
}

function normalizeGenerationStatus(status: unknown): GenerationStatus {
  if (status === 'queued' || status === 'generating' || status === 'generated' || status === 'failed' || status === 'rejected' || status === 'planned') {
    return status;
  }

  return 'planned';
}

function normalizeAttempts(attempts: Partial<GenerationRecord>[] | undefined, kind: 'image' | 'video', fallback: GenerationRecord): GenerationRecord[] | undefined {
  if (!attempts || attempts.length === 0) {
    return undefined;
  }

  return attempts.map((attempt, index) => ({
    ...fallback,
    ...attempt,
    id: attempt.id ?? `${fallback.id}_attempt_${index + 1}`,
    kind,
    status: normalizeGenerationStatus(attempt.status),
    prompt: attempt.prompt ?? fallback.prompt,
    createdAt: attempt.createdAt ?? fallback.createdAt
  }));
}

function normalizeLegacyVisual(scene: LegacyScene, project: Partial<Project>): VisualSpec {
  const legacyVisual = scene.visual as {
    assetStatus?: 'planned' | 'imported' | 'generated';
    visualPrompt?: string;
    negativePrompt?: string;
    template?: Scene['visual'] extends { template?: infer T } ? T : never;
    templateData?: Record<string, unknown>;
    kind?: string;
    assetId?: string;
    generation?: Partial<GenerationRecord>;
    attempts?: Partial<GenerationRecord>[];
    text?: string;
  } | undefined;
  const assetId = legacyVisual?.assetId ?? scene.assetIds?.[0];
  const referenceIds = scene.referenceIds ?? [];
  const prompt = legacyVisual?.visualPrompt ?? legacyVisual?.generation?.prompt ?? '';
  const negativePrompt = legacyVisual?.negativePrompt ?? legacyVisual?.generation?.negativePrompt;
  const aspectRatio = project.aspectRatio ?? DEFAULT_RENDER_SETTINGS.aspectRatio;

  if (legacyVisual?.kind === 'asset' || (assetId && legacyVisual?.kind !== 'generated_image' && legacyVisual?.kind !== 'generated_video')) {
    return {
      kind: 'asset',
      assetId
    };
  }

  if (legacyVisual?.kind === 'generated_image' || (scene.type === 'image' && (legacyVisual?.assetStatus === 'planned' || legacyVisual?.assetStatus === 'generated') && !assetId)) {
    const normalizedGeneration: GenerationRecord = {
      id: legacyVisual?.generation?.id ?? `generation_${scene.id ?? 'scene'}`,
      kind: 'image',
      status: normalizeGenerationStatus(legacyVisual?.generation?.status ?? legacyVisual?.assetStatus),
      provider: legacyVisual?.generation?.provider,
      model: legacyVisual?.generation?.model,
      prompt,
      negativePrompt,
      referenceIds,
      aspectRatio,
      assetId: legacyVisual?.generation?.assetId ?? assetId,
      providerRequestId: legacyVisual?.generation?.providerRequestId,
      providerJobId: legacyVisual?.generation?.providerJobId,
      providerStatus: legacyVisual?.generation?.providerStatus,
      submittedAt: legacyVisual?.generation?.submittedAt,
      lastPolledAt: legacyVisual?.generation?.lastPolledAt,
      errorCode: legacyVisual?.generation?.errorCode,
      errorMessage: legacyVisual?.generation?.errorMessage,
      error: legacyVisual?.generation?.error,
      createdAt: legacyVisual?.generation?.createdAt ?? nowIso(),
      completedAt: legacyVisual?.generation?.completedAt,
      metadata: legacyVisual?.generation?.metadata
    };

    return {
      kind: 'generated_image',
      assetId: normalizedGeneration.assetId,
      attempts: normalizeAttempts(legacyVisual?.attempts, 'image', normalizedGeneration),
      generation: normalizedGeneration
    };
  }

  if (legacyVisual?.kind === 'generated_video' || (scene.type === 'video' && (legacyVisual?.assetStatus === 'planned' || legacyVisual?.assetStatus === 'generated') && !assetId)) {
    const normalizedGeneration: GenerationRecord = {
      id: legacyVisual?.generation?.id ?? `generation_${scene.id ?? 'scene'}`,
      kind: 'video',
      status: normalizeGenerationStatus(legacyVisual?.generation?.status ?? legacyVisual?.assetStatus),
      provider: legacyVisual?.generation?.provider,
      model: legacyVisual?.generation?.model,
      prompt,
      negativePrompt,
      referenceIds,
      aspectRatio,
      duration: legacyVisual?.generation?.duration ?? scene.duration,
      assetId: legacyVisual?.generation?.assetId ?? assetId,
      providerRequestId: legacyVisual?.generation?.providerRequestId,
      providerJobId: legacyVisual?.generation?.providerJobId,
      providerStatus: legacyVisual?.generation?.providerStatus,
      submittedAt: legacyVisual?.generation?.submittedAt,
      lastPolledAt: legacyVisual?.generation?.lastPolledAt,
      errorCode: legacyVisual?.generation?.errorCode,
      errorMessage: legacyVisual?.generation?.errorMessage,
      error: legacyVisual?.generation?.error,
      createdAt: legacyVisual?.generation?.createdAt ?? nowIso(),
      completedAt: legacyVisual?.generation?.completedAt,
      metadata: legacyVisual?.generation?.metadata
    };

    return {
      kind: 'generated_video',
      assetId: normalizedGeneration.assetId,
      attempts: normalizeAttempts(legacyVisual?.attempts, 'video', normalizedGeneration),
      generation: normalizedGeneration
    };
  }

  if (legacyVisual?.kind === 'graphic' || scene.type === 'graphic') {
    return {
      kind: 'graphic',
      template: legacyVisual?.template ?? 'simple_diagram',
      prompt,
      templateData: legacyVisual?.templateData
    };
  }

  if (legacyVisual?.kind === 'text' || scene.type === 'text') {
    return {
      kind: 'text',
      text: legacyVisual?.text ?? scene.textOverlay ?? (typeof scene.narration === 'string' ? scene.narration : scene.narration?.text) ?? ''
    };
  }

  if (scene.type === 'blank' || legacyVisual?.kind === 'blank') {
    return { kind: 'blank' };
  }

  return {
    kind: 'generated_image',
    generation: {
      id: `generation_${scene.id ?? 'scene'}`,
      kind: scene.type === 'video' ? 'video' : 'image',
      status: normalizeGenerationStatus(legacyVisual?.assetStatus),
      prompt,
      negativePrompt,
      referenceIds,
      aspectRatio,
      duration: scene.type === 'video' ? scene.duration : undefined,
      createdAt: nowIso()
    }
  };
}

function normalizeNarration(narration: string | NarrationSpec | undefined): NarrationSpec | undefined {
  if (!narration) {
    return undefined;
  }

  if (typeof narration === 'string') {
    const text = narration.trim();
    return text ? { text } : undefined;
  }

  const text = (narration.text ?? '').trim();
  const attempts = (narration.attempts ?? []).map((attempt, index) => {
    const normalized: NarrationGenerationAttempt = {
      id: attempt.id ?? `narration_attempt_${index + 1}`,
      status: attempt.status ?? 'planned',
      provider: attempt.provider ?? 'unknown',
      model: attempt.model,
      voiceId: attempt.voiceId,
      format: attempt.format ?? 'mp3',
      providerRequestId: attempt.providerRequestId,
      mimeType: attempt.mimeType,
      duration: attempt.duration,
      audioAssetId: attempt.audioAssetId,
      createdAt: attempt.createdAt ?? nowIso(),
      completedAt: attempt.completedAt,
      error: attempt.error
    };

    return normalized;
  });

  if (!text && !narration.audioAssetId) {
    return undefined;
  }

  return {
    text,
    voiceId: narration.voiceId,
    model: narration.model,
    format: narration.format ?? 'mp3',
    audioAssetId: narration.audioAssetId,
    status: narration.status ?? (narration.audioAssetId ? 'generated' : 'planned'),
    lastAttemptId: narration.lastAttemptId,
    error: narration.error,
    duration: narration.duration,
    attempts
  };
}

export function normalizeScene(scene: LegacyScene, project: Partial<Project>, index: number): Scene {
  const sceneId = scene.id ?? `scene-${index + 1}`;
  const legacySceneWithRenders = scene as LegacyScene & { renders?: Scene['renders'] };

  return {
    id: sceneId,
    order: scene.order ?? index + 1,
    duration: scene.duration ?? 5,
    type: scene.type ?? 'image',
    narration: normalizeNarration(scene.narration as string | NarrationSpec | undefined),
    visual: normalizeLegacyVisual({ ...scene, id: sceneId }, project),
    render: scene.render ?? {
      motion: normalizeMotion(scene.motion),
      transition: normalizeTransition(scene.transition)
    },
    overlay: scene.overlay ?? (scene.textOverlay ? { type: 'text', text: scene.textOverlay, position: 'bottom' } : { type: 'none' }),
    referenceIds: scene.referenceIds ?? [],
    notes: scene.notes ?? '',
    renders: legacySceneWithRenders.renders ?? []
  };
}

function normalizeAsset(asset: Asset): Asset {
  return {
    ...asset,
    provenance: inferAssetProvenance(asset),
    generation: asset.generation,
    metadata: asset.metadata ?? {}
  };
}

function normalizeReference(reference: ReferenceImage): ReferenceImage {
  return {
    ...reference,
    tags: reference.tags ?? [],
    metadata: reference.metadata ?? {}
  };
}

export function normalizeProject(project: Project): Project {
  const normalizedProject: Project = {
    ...project,
    narration: {
      text: project.narration?.text ?? '',
      segments: project.narration?.segments ?? []
    },
    scenes: (project.scenes ?? []).map((scene, index) => normalizeScene(scene as LegacyScene, project, index)),
    assets: (project.assets ?? []).map(normalizeAsset),
    references: (project.references ?? []).map(normalizeReference),
    compositions: project.compositions ?? [],
    renderSettings: {
      aspectRatio: project.renderSettings?.aspectRatio ?? project.aspectRatio ?? DEFAULT_RENDER_SETTINGS.aspectRatio,
      fps: project.renderSettings?.fps ?? project.fps ?? DEFAULT_RENDER_SETTINGS.fps,
      width: project.renderSettings?.width ?? DEFAULT_RENDER_SETTINGS.width,
      height: project.renderSettings?.height ?? DEFAULT_RENDER_SETTINGS.height,
      background: project.renderSettings?.background ?? DEFAULT_RENDER_SETTINGS.background,
      audio: normalizeAudioMix({
        narrationVolume:
          project.renderSettings?.audio?.narrationVolume ??
          (project.renderSettings as Partial<typeof DEFAULT_RENDER_SETTINGS> & { narrationVolume?: number })?.narrationVolume,
        musicVolume:
          project.renderSettings?.audio?.musicVolume ??
          (project.renderSettings as Partial<typeof DEFAULT_RENDER_SETTINGS> & { musicVolume?: number })?.musicVolume,
        effectsVolume: project.renderSettings?.audio?.effectsVolume
      }),
      subtitlesEnabled: project.renderSettings?.subtitlesEnabled ?? DEFAULT_RENDER_SETTINGS.subtitlesEnabled,
      seed: project.renderSettings?.seed
    }
  };

  normalizedProject.explainer = normalizeExplainer(normalizedProject);

  return normalizedProject;
}
