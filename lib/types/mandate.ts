import type { StockProviderId } from './stock';
import type {
  ImageRunProvider,
  MusicRunProvider,
  NarrationRunProvider,
  PresenterRunProvider,
  VideoRunProvider
} from '@/lib/production/run-types';

export type MandateStatus = 'active' | 'consumed' | 'revoked' | 'expired' | 'failed';

export type MandateAction =
  | 'update_project'
  | 'import_asset'
  | 'import_studio_assets'
  | 'create_reference'
  | 'plan_scene_intents'
  | 'materialize_scene_intents'
  | 'search_stock_photos'
  | 'select_stock_photo'
  | 'generate_image'
  | 'generate_video'
  | 'generate_narration'
  | 'manage_project_music'
  | 'render_animation_template'
  | 'attach_animation'
  | 'run_production'
  | 'cancel_video';

export const MANDATE_ACTIONS: MandateAction[] = [
  'update_project',
  'import_asset',
  'import_studio_assets',
  'create_reference',
  'plan_scene_intents',
  'materialize_scene_intents',
  'search_stock_photos',
  'select_stock_photo',
  'generate_image',
  'generate_video',
  'generate_narration',
  'manage_project_music',
  'render_animation_template',
  'attach_animation',
  'run_production',
  'cancel_video'
];

export const DEFAULT_MANDATE_ACTIONS: MandateAction[] = [...MANDATE_ACTIONS];

export interface MandateProviderAllowlist {
  image?: ImageRunProvider[];
  video?: VideoRunProvider[];
  narration?: NarrationRunProvider[];
  music?: MusicRunProvider[];
  presenter?: PresenterRunProvider[];
  stock?: StockProviderId[];
}

export interface MandateBudgetSettings {
  maxSubmits?: number;
  maxImageSubmits?: number;
  maxVideoSubmits?: number;
  maxNarrationSubmits?: number;
  maxMusicSubmits?: number;
  maxPresenterSubmits?: number;
  maxCostUsd?: number;
}

export interface ProductionMandate {
  mandateId: string;
  projectId: string;
  issuedBy: string;
  issuedAt: string;
  expiresAt: string;
  status: MandateStatus;
  brief: string;
  allowedActions: MandateAction[];
  allowedProviders?: MandateProviderAllowlist;
  budgets?: MandateBudgetSettings;
  maxDurationMs?: number;
  boundRunId?: string;
  consumedAt?: string;
  revokedAt?: string;
  failedAt?: string;
}

export const DEFAULT_MANDATE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_MANDATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_MANDATE_TTL_MS = 60 * 1000;
