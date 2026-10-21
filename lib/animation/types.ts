export const ANIMATION_TEMPLATE_IDS = ['northwind_arr_chart', 'nix_overlay'] as const;

export type AnimationTemplateId = (typeof ANIMATION_TEMPLATE_IDS)[number];

export type AnimationDestination = 'bigscreen' | 'overlay';

export interface AnimationTemplateOutput {
  container: 'mp4' | 'webm';
  codec: 'h264' | 'vp9';
  pixFmt: 'yuv420p' | 'yuva420p';
  mimeType: 'video/mp4' | 'video/webm';
  width: number;
  height: number;
  fps: number;
  alpha: boolean;
}

export interface AnimationParamField {
  type: 'string' | 'number' | 'string[]' | 'number[]';
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  min?: number;
  max?: number;
  pattern?: string;
  description: string;
}

export interface AnimationTemplateDefinition {
  id: AnimationTemplateId;
  title: string;
  description: string;
  destination: AnimationDestination;
  headlessTarget: 'chart' | 'overlay';
  output: AnimationTemplateOutput;
  allowedParamKeys: string[];
  paramsSchema: {
    type: 'object';
    additionalProperties: false;
    properties: Record<string, AnimationParamField>;
  };
  defaults: Record<string, unknown>;
}

export interface AnimationTemplateSummary {
  id: AnimationTemplateId;
  title: string;
  description: string;
  destination: AnimationDestination;
  output: AnimationTemplateOutput;
  allowedParamKeys: string[];
  paramsSchema: AnimationTemplateDefinition['paramsSchema'];
  defaults: Record<string, unknown>;
}

export interface NorthwindChartParams {
  title: string;
  subtitle: string;
  labels: string[];
  values: number[];
  colors: string[];
  background: string;
  holdSeconds: number;
}

export interface NixOverlayParams {
  badge: string;
  bodyColor: string;
  headColor: string;
  badgeColor: string;
}

export type AnimationTemplateParams = NorthwindChartParams | NixOverlayParams;

export interface AnimationRenderInput {
  projectId: string;
  templateId: AnimationTemplateId;
  params?: Record<string, unknown>;
}

export interface AnimationRenderResult {
  projectId: string;
  templateId: AnimationTemplateId;
  assetId: string;
  localPath: string;
  mimeType: string;
  destination: AnimationDestination;
  width?: number;
  height?: number;
  duration?: number;
  filesize?: number;
}

export interface AnimationAttachPosition {
  x: number;
  y: number;
}

export interface AnimationAttachRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnimationAttachInput {
  projectId: string;
  sceneId: string;
  assetId: string;
  destination: AnimationDestination;
  startSeconds?: number;
  durationSeconds?: number;
  scale?: number;
  position?: AnimationAttachPosition;
  rect?: AnimationAttachRect;
}

export interface AnimationAttachResult {
  projectId: string;
  sceneId: string;
  assetId: string;
  localPath: string;
  destination: AnimationDestination;
  layerId: string;
  rect: AnimationAttachRect;
  startSeconds?: number;
  durationSeconds?: number;
}
