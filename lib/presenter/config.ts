import { deriveNarrationFreshness } from '@/lib/generation/narration-freshness';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import type { Project } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';
import type {
  PresenterAvatarType,
  PresenterClipSpec,
  PresenterClipStatus,
  PresenterCostRecord,
  PresenterEngine,
  PresenterLayout,
  PresenterOutputFormat,
  PresenterPipPosition,
  PresenterPipSettings,
  PresenterProviderKey,
  PresenterResolution,
  PresenterSceneSetting,
  ProjectPresenterSettings
} from '@/lib/types/presenter';

export const PRESENTER_LAYOUTS: PresenterLayout[] = ['fullscreen', 'pip'];
export const PRESENTER_PIP_POSITIONS: PresenterPipPosition[] = ['bottom_right', 'bottom_left', 'top_right', 'top_left'];
export const PRESENTER_OUTPUT_FORMATS: PresenterOutputFormat[] = ['mp4', 'webm'];
export const PRESENTER_PROVIDER_KEYS: PresenterProviderKey[] = ['mock', 'heygen'];

export const PRESENTER_PIP_LIMITS = {
  MIN_WIDTH_RATIO: 0.12,
  MAX_WIDTH_RATIO: 0.55,
  MIN_MARGIN_RATIO: 0,
  MAX_MARGIN_RATIO: 0.08
} as const;

export const PRESENTER_DEFAULT_LIMITS = {
  MAX_GENERATED_SECONDS: 60,
  MAX_PAID_REQUESTS: 1
} as const;

// Server-side ceilings. Authoring may lower the spend guards but never raise
// them beyond these values.
export const PRESENTER_LIMIT_CEILINGS = {
  MAX_GENERATED_SECONDS: 300,
  MAX_PAID_REQUESTS: 5,
  MAX_COST_USD: 25
} as const;

export const PRESENTER_MAX_EXPECTED_PADDING_SECONDS = 0.5;

export const PRESENTER_DEFAULT_PIP: Required<PresenterPipSettings> = {
  position: 'bottom_right',
  widthRatio: 0.28,
  marginRatio: 0.03
};

export const PRESENTER_DEFAULT_PROVIDER: PresenterProviderKey = 'mock';
export const PRESENTER_DEFAULT_OUTPUT_FORMAT: PresenterOutputFormat = 'mp4';
export const PRESENTER_MAX_SCENES = 40;

export function isPresenterLayout(value: unknown): value is PresenterLayout {
  return typeof value === 'string' && (PRESENTER_LAYOUTS as string[]).includes(value);
}

export function isPresenterPipPosition(value: unknown): value is PresenterPipPosition {
  return typeof value === 'string' && (PRESENTER_PIP_POSITIONS as string[]).includes(value);
}

export function isPresenterOutputFormat(value: unknown): value is PresenterOutputFormat {
  return typeof value === 'string' && (PRESENTER_OUTPUT_FORMATS as string[]).includes(value);
}

export function isPresenterProviderKey(value: unknown): value is PresenterProviderKey {
  return typeof value === 'string' && (PRESENTER_PROVIDER_KEYS as string[]).includes(value);
}

export function normalizePresenterProviderKey(value: unknown): PresenterProviderKey | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'fake' || normalized === 'local') {
    return 'mock';
  }
  return isPresenterProviderKey(normalized) ? normalized : undefined;
}

export function clampPresenterWidthRatio(value: unknown): number | undefined {
  return clampRatio(value, PRESENTER_PIP_LIMITS.MIN_WIDTH_RATIO, PRESENTER_PIP_LIMITS.MAX_WIDTH_RATIO);
}

export function clampPresenterMarginRatio(value: unknown): number | undefined {
  return clampRatio(value, PRESENTER_PIP_LIMITS.MIN_MARGIN_RATIO, PRESENTER_PIP_LIMITS.MAX_MARGIN_RATIO);
}

function clampRatio(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, value));
}

function clampLimit(value: unknown, fallback: number, ceiling: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(ceiling, value);
}

function clampMoney(value: unknown, ceiling: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(ceiling, Math.round(value * 10000) / 10000);
}

function normalizeSetting(setting: unknown): PresenterSceneSetting | undefined {
  if (!setting || typeof setting !== 'object' || Array.isArray(setting)) {
    return undefined;
  }
  const value = setting as Record<string, unknown>;
  const sceneId = typeof value.sceneId === 'string' ? value.sceneId.trim() : '';
  if (!sceneId) {
    return undefined;
  }
  const layout = isPresenterLayout(value.layout) ? value.layout : undefined;
  if (!layout) {
    return undefined;
  }

  const pipValue = value.pip && typeof value.pip === 'object' && !Array.isArray(value.pip)
    ? value.pip as Record<string, unknown>
    : undefined;
  const pip: PresenterPipSettings | undefined = pipValue
    ? {
        position: isPresenterPipPosition(pipValue.position) ? pipValue.position : undefined,
        widthRatio: clampPresenterWidthRatio(pipValue.widthRatio),
        marginRatio: clampPresenterMarginRatio(pipValue.marginRatio)
      }
    : undefined;

  const startOffset = typeof value.startOffsetSeconds === 'number' && Number.isFinite(value.startOffsetSeconds) && value.startOffsetSeconds > 0
    ? value.startOffsetSeconds
    : undefined;

  return {
    sceneId,
    layout,
    pip,
    startOffsetSeconds: startOffset
  };
}

export function normalizeProjectPresenter(value: unknown): ProjectPresenterSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const rawSettings = Array.isArray(candidate.sceneSettings) ? candidate.sceneSettings : [];
  const seen = new Set<string>();
  const sceneSettings: PresenterSceneSetting[] = [];

  for (const raw of rawSettings.slice(0, PRESENTER_MAX_SCENES)) {
    const setting = normalizeSetting(raw);
    if (!setting || seen.has(setting.sceneId)) {
      continue;
    }
    seen.add(setting.sceneId);
    sceneSettings.push(setting);
  }

  const enabled = candidate.enabled === true;
  if (!enabled && sceneSettings.length === 0) {
    return {
      enabled: false,
      sceneSettings: []
    };
  }

  return {
    enabled,
    avatarId: typeof candidate.avatarId === 'string' && candidate.avatarId.trim() ? candidate.avatarId.trim() : undefined,
    provider: normalizePresenterProviderKey(candidate.provider),
    outputFormat: isPresenterOutputFormat(candidate.outputFormat) ? candidate.outputFormat : undefined,
    sceneSettings,
    maxGeneratedSeconds: clampLimit(
      candidate.maxGeneratedSeconds,
      PRESENTER_DEFAULT_LIMITS.MAX_GENERATED_SECONDS,
      PRESENTER_LIMIT_CEILINGS.MAX_GENERATED_SECONDS
    ),
    maxPaidRequests: clampLimit(
      candidate.maxPaidRequests,
      PRESENTER_DEFAULT_LIMITS.MAX_PAID_REQUESTS,
      PRESENTER_LIMIT_CEILINGS.MAX_PAID_REQUESTS
    ),
    maxCostUsd: clampMoney(candidate.maxCostUsd, PRESENTER_LIMIT_CEILINGS.MAX_COST_USD)
  };
}

const CLIP_STATUSES: PresenterClipStatus[] = ['planned', 'submitting', 'generating', 'generated', 'failed'];

function normalizeClipStatus(value: unknown): PresenterClipStatus {
  return typeof value === 'string' && (CLIP_STATUSES as string[]).includes(value)
    ? value as PresenterClipStatus
    : 'planned';
}

export function normalizePresenterClips(value: unknown): PresenterClipSpec[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const seen = new Set<string>();
  const clips: PresenterClipSpec[] = [];

  for (const raw of value.slice(0, PRESENTER_MAX_SCENES)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const sceneId = typeof candidate.sceneId === 'string' ? candidate.sceneId.trim() : '';
    if (!sceneId || seen.has(sceneId)) {
      continue;
    }
    seen.add(sceneId);
    const attempts = Array.isArray(candidate.attempts)
      ? candidate.attempts.map((attempt, index) => normalizeClipAttempt(attempt, index)).filter((attempt): attempt is NonNullable<typeof attempt> => Boolean(attempt))
      : undefined;

    clips.push({
      sceneId,
      status: normalizeClipStatus(candidate.status),
      provider: typeof candidate.provider === 'string' && candidate.provider.trim() ? candidate.provider.trim() : PRESENTER_DEFAULT_PROVIDER,
      avatarId: typeof candidate.avatarId === 'string' ? candidate.avatarId : undefined,
      outputFormat: isPresenterOutputFormat(candidate.outputFormat) ? candidate.outputFormat : PRESENTER_DEFAULT_OUTPUT_FORMAT,
      audioAssetId: typeof candidate.audioAssetId === 'string' ? candidate.audioAssetId : '',
      narrationSignature: typeof candidate.narrationSignature === 'string' ? candidate.narrationSignature : '',
      duration: typeof candidate.duration === 'number' && Number.isFinite(candidate.duration) ? candidate.duration : 0,
      assetId: typeof candidate.assetId === 'string' ? candidate.assetId : undefined,
      lastAttemptId: typeof candidate.lastAttemptId === 'string' ? candidate.lastAttemptId : undefined,
      error: typeof candidate.error === 'string' ? candidate.error : undefined,
      attempts
    });
  }

  return clips.length > 0 ? clips : undefined;
}

function normalizeCostRecord(value: unknown): PresenterCostRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const cost = value as Record<string, unknown>;
  const engine = cost.engine;
  const avatarType = cost.avatarType;
  const resolution = cost.resolution;
  if (
    (engine !== 'avatar_iii' && engine !== 'avatar_iv' && engine !== 'avatar_v') ||
    (avatarType !== 'photo_avatar' && avatarType !== 'studio_avatar' && avatarType !== 'digital_twin' && avatarType !== 'custom_video') ||
    (resolution !== '720p' && resolution !== '1080p')
  ) {
    return undefined;
  }
  const numbers = ['seconds', 'billableSeconds', 'usdPerSecond', 'linearUsd', 'estimatedUsd', 'maxCostUsd'] as const;
  for (const key of numbers) {
    if (typeof cost[key] !== 'number' || !Number.isFinite(cost[key])) {
      return undefined;
    }
  }
  return {
    currency: 'USD',
    engine: engine as PresenterEngine,
    avatarType: avatarType as PresenterAvatarType,
    resolution: resolution as PresenterResolution,
    seconds: cost.seconds as number,
    billableSeconds: cost.billableSeconds as number,
    usdPerSecond: cost.usdPerSecond as number,
    linearUsd: cost.linearUsd as number,
    estimatedUsd: cost.estimatedUsd as number,
    maxCostUsd: cost.maxCostUsd as number,
    observedUsd: typeof cost.observedUsd === 'number' && Number.isFinite(cost.observedUsd) ? cost.observedUsd : undefined,
    observedAt: typeof cost.observedAt === 'string' ? cost.observedAt : undefined,
    observedSource: cost.observedSource === 'wallet_delta' ? 'wallet_delta' : undefined
  };
}

function normalizeClipAttempt(value: unknown, index: number) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const attempt = value as Record<string, unknown>;
  const id = typeof attempt.id === 'string' && attempt.id.trim() ? attempt.id.trim() : `presenter_attempt_${index + 1}`;
  return {
    id,
    status: normalizeClipStatus(attempt.status),
    provider: typeof attempt.provider === 'string' && attempt.provider.trim() ? attempt.provider.trim() : PRESENTER_DEFAULT_PROVIDER,
    avatarId: typeof attempt.avatarId === 'string' ? attempt.avatarId : undefined,
    providerJobId: typeof attempt.providerJobId === 'string' ? attempt.providerJobId : undefined,
    providerStatus: typeof attempt.providerStatus === 'string' ? attempt.providerStatus : undefined,
    outputFormat: isPresenterOutputFormat(attempt.outputFormat) ? attempt.outputFormat : PRESENTER_DEFAULT_OUTPUT_FORMAT,
    audioAssetId: typeof attempt.audioAssetId === 'string' ? attempt.audioAssetId : '',
    narrationSignature: typeof attempt.narrationSignature === 'string' ? attempt.narrationSignature : '',
    duration: typeof attempt.duration === 'number' && Number.isFinite(attempt.duration) ? attempt.duration : 0,
    videoAssetId: typeof attempt.videoAssetId === 'string' ? attempt.videoAssetId : undefined,
    mimeType: typeof attempt.mimeType === 'string' ? attempt.mimeType : undefined,
    width: typeof attempt.width === 'number' ? attempt.width : undefined,
    height: typeof attempt.height === 'number' ? attempt.height : undefined,
    cost: normalizeCostRecord(attempt.cost),
    walletBalanceBeforeUsd: typeof attempt.walletBalanceBeforeUsd === 'number' && Number.isFinite(attempt.walletBalanceBeforeUsd)
      ? attempt.walletBalanceBeforeUsd
      : undefined,
    error: typeof attempt.error === 'string' ? attempt.error : undefined,
    createdAt: typeof attempt.createdAt === 'string' ? attempt.createdAt : new Date(0).toISOString(),
    completedAt: typeof attempt.completedAt === 'string' ? attempt.completedAt : undefined
  };
}

export function getPresenterSetting(project: Project, sceneId: string): PresenterSceneSetting | undefined {
  if (!project.presenter?.enabled) {
    return undefined;
  }
  return project.presenter.sceneSettings.find((entry) => entry.sceneId === sceneId);
}

export function getPresenterClip(project: Project, sceneId: string): PresenterClipSpec | undefined {
  return project.presenterClips?.find((entry) => entry.sceneId === sceneId);
}

export function resolvePresenterPip(setting: PresenterSceneSetting): Required<PresenterPipSettings> | undefined {
  if (setting.layout !== 'pip') {
    return undefined;
  }
  return {
    position: setting.pip?.position ?? PRESENTER_DEFAULT_PIP.position,
    widthRatio: setting.pip?.widthRatio ?? PRESENTER_DEFAULT_PIP.widthRatio,
    marginRatio: setting.pip?.marginRatio ?? PRESENTER_DEFAULT_PIP.marginRatio
  };
}

export function isPresenterClipCurrent(project: Project, scene: Scene, clip: PresenterClipSpec | undefined): boolean {
  if (!clip || clip.status !== 'generated' || !clip.assetId) {
    return false;
  }
  const asset = project.assets.find((entry) => entry.id === clip.assetId);
  if (!asset || asset.status !== 'available' || !asset.localPath) {
    return false;
  }
  const freshness = deriveNarrationFreshness(project, scene);
  return clip.audioAssetId === (scene.narration?.audioAssetId ?? '') &&
    clip.narrationSignature === freshness.narrationSignature;
}

export function hasPresenterAsset(project: Project, clip: PresenterClipSpec | undefined): boolean {
  if (!clip?.assetId) {
    return false;
  }
  const asset = project.assets.find((entry) => entry.id === clip.assetId);
  return Boolean(asset && asset.status === 'available' && asset.localPath);
}

export function derivePresenterSignature(project: Project): string {
  const presenter = project.presenter;
  if (!presenter?.enabled) {
    return 'presenter:off';
  }
  const settings = presenter.sceneSettings
    .map((setting) => ({
      sceneId: setting.sceneId,
      layout: setting.layout,
      pip: setting.pip ?? null,
      startOffsetSeconds: setting.startOffsetSeconds ?? 0
    }))
    .sort((left, right) => left.sceneId.localeCompare(right.sceneId));
  const clips = (project.presenterClips ?? [])
    .filter((clip) => clip.status === 'generated' && clip.assetId)
    .map((clip) => ({
      sceneId: clip.sceneId,
      assetId: clip.assetId ?? '',
      audioAssetId: clip.audioAssetId,
      narrationSignature: clip.narrationSignature,
      duration: clip.duration
    }))
    .sort((left, right) => left.sceneId.localeCompare(right.sceneId));

  return JSON.stringify({
    enabled: presenter.enabled,
    outputFormat: presenter.outputFormat ?? PRESENTER_DEFAULT_OUTPUT_FORMAT,
    settings,
    clips
  });
}

export interface PresenterBudgetReport {
  maxGeneratedSeconds: number;
  maxPaidRequests: number;
  generatedSeconds: number;
  paidRequests: number;
  plannedSeconds: number;
  plannedRequests: number;
  exceeded: boolean;
  reasons: string[];
}

function paidAttempts(project: Project) {
  const attempts = (project.presenterClips ?? []).flatMap((clip) =>
    (clip.attempts ?? []).filter((attempt) => attempt.provider === 'heygen')
  );
  const byId = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  return Array.from(byId.values());
}

export function resolvePresenterPlannedSeconds(project: Project): number {
  if (!project.presenter?.enabled) {
    return 0;
  }
  const plan = resolveRenderPlan(project);
  let total = 0;
  for (const setting of project.presenter.sceneSettings) {
    const planned = plan.scenes.find((entry) => entry.sceneId === setting.sceneId);
    if (planned) {
      total += planned.duration;
    }
  }
  return total;
}

export function evaluatePresenterBudget(project: Project, options: { additionalSeconds?: number; additionalRequests?: number } = {}): PresenterBudgetReport {
  const presenter = project.presenter;
  const maxGeneratedSeconds = presenter?.maxGeneratedSeconds ?? PRESENTER_DEFAULT_LIMITS.MAX_GENERATED_SECONDS;
  const maxPaidRequests = presenter?.maxPaidRequests ?? PRESENTER_DEFAULT_LIMITS.MAX_PAID_REQUESTS;
  const attempts = paidAttempts(project);
  const generatedSeconds = attempts.reduce((sum, attempt) => sum + (Number.isFinite(attempt.duration) ? attempt.duration : 0), 0);
  const paidRequests = attempts.length;

  // Only configured scenes that do not have a current clip still need work.
  const renderPlan = resolveRenderPlan(project);
  let plannedSeconds = 0;
  let plannedRequests = 0;
  for (const setting of presenter?.sceneSettings ?? []) {
    const scene = project.scenes.find((entry) => entry.id === setting.sceneId);
    if (!scene) {
      continue;
    }
    const clip = getPresenterClip(project, setting.sceneId);
    if (isPresenterClipCurrent(project, scene, clip)) {
      continue;
    }
    const planned = renderPlan.scenes.find((entry) => entry.sceneId === setting.sceneId);
    plannedSeconds += planned?.duration ?? scene.duration;
    plannedRequests += 1;
  }

  const totalSeconds = generatedSeconds + plannedSeconds + (options.additionalSeconds ?? 0);
  const totalRequests = paidRequests + plannedRequests + (options.additionalRequests ?? 0);
  const reasons: string[] = [];

  if (totalSeconds > maxGeneratedSeconds) {
    reasons.push(`Presenter generation would use ${totalSeconds.toFixed(1)}s of a ${maxGeneratedSeconds}s budget.`);
  }
  if (totalRequests > maxPaidRequests) {
    reasons.push(`Presenter generation would use ${totalRequests} of ${maxPaidRequests} paid request(s).`);
  }

  return {
    maxGeneratedSeconds,
    maxPaidRequests,
    generatedSeconds,
    paidRequests,
    plannedSeconds,
    plannedRequests,
    exceeded: reasons.length > 0,
    reasons
  };
}

// Strict per-charge guard used immediately before a paid provider request. It
// deliberately counts only work that would be newly billed.
export function evaluatePresenterChargeBudget(
  project: Project,
  charge: { seconds: number; requests?: number }
): { allowed: boolean; reasons: string[]; totalSeconds: number; totalRequests: number; maxGeneratedSeconds: number; maxPaidRequests: number } {
  const maxGeneratedSeconds = project.presenter?.maxGeneratedSeconds ?? PRESENTER_DEFAULT_LIMITS.MAX_GENERATED_SECONDS;
  const maxPaidRequests = project.presenter?.maxPaidRequests ?? PRESENTER_DEFAULT_LIMITS.MAX_PAID_REQUESTS;
  const attempts = paidAttempts(project);
  const totalSeconds = attempts.reduce((sum, attempt) => sum + (Number.isFinite(attempt.duration) ? attempt.duration : 0), 0) + charge.seconds;
  const totalRequests = attempts.length + (charge.requests ?? 1);
  const reasons: string[] = [];

  if (totalSeconds > maxGeneratedSeconds) {
    reasons.push(`Presenter generation would use ${totalSeconds.toFixed(1)}s of a ${maxGeneratedSeconds}s budget.`);
  }
  if (totalRequests > maxPaidRequests) {
    reasons.push(`Presenter generation would use ${totalRequests} of ${maxPaidRequests} paid request(s).`);
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    totalSeconds,
    totalRequests,
    maxGeneratedSeconds,
    maxPaidRequests
  };
}

