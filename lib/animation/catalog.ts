import type {
  AnimationTemplateDefinition,
  AnimationTemplateId,
  AnimationTemplateSummary,
  NixOverlayParams,
  NorthwindChartParams
} from './types';
import { ANIMATION_TEMPLATE_IDS } from './types';

export const NORTHWIND_CHART_DEFAULTS: NorthwindChartParams = {
  title: 'Northwind ARR',
  subtitle: 'Last five quarters, $M',
  labels: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'],
  values: [24, 41, 63, 88, 76],
  colors: ['#38bdf8', '#60a5fa', '#34d399', '#fbbf24', '#f472b6'],
  background: '#0f172a',
  holdSeconds: 2.1
};

export const NIX_OVERLAY_DEFAULTS: NixOverlayParams = {
  badge: 'NIX',
  bodyColor: '#0e7490',
  headColor: '#22d3ee',
  badgeColor: '#ef4444'
};

const HEX_PATTERN = '^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$';

export const ANIMATION_TEMPLATES: Record<AnimationTemplateId, AnimationTemplateDefinition> = {
  northwind_arr_chart: {
    id: 'northwind_arr_chart',
    title: 'Northwind ARR chart',
    description:
      'Opaque 1920x1080 H.264 bar chart for the studio bigscreen. Structured numbers and colors only; no code.',
    destination: 'bigscreen',
    headlessTarget: 'chart',
    output: {
      container: 'mp4',
      codec: 'h264',
      pixFmt: 'yuv420p',
      mimeType: 'video/mp4',
      width: 1920,
      height: 1080,
      fps: 30,
      alpha: false
    },
    allowedParamKeys: ['title', 'subtitle', 'labels', 'values', 'colors', 'background', 'holdSeconds'],
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 80, description: 'Chart title' },
        subtitle: { type: 'string', minLength: 1, maxLength: 120, description: 'Chart subtitle' },
        labels: {
          type: 'string[]',
          minItems: 2,
          maxItems: 8,
          description: 'Category labels; same length as values'
        },
        values: {
          type: 'number[]',
          minItems: 2,
          maxItems: 8,
          description: 'Non-negative finite values; same length as labels'
        },
        colors: {
          type: 'string[]',
          minItems: 2,
          maxItems: 8,
          description: 'Hex colors; same length as values'
        },
        background: { type: 'string', pattern: HEX_PATTERN, description: 'Opaque hex background' },
        holdSeconds: { type: 'number', min: 0, max: 10, description: 'Hold time after the animation' }
      }
    },
    defaults: { ...NORTHWIND_CHART_DEFAULTS }
  },
  nix_overlay: {
    id: 'nix_overlay',
    title: 'Nix overlay',
    description:
      'Transparent 520x780 VP9/WebM mascot overlay. Colors and badge text only; compositor places it on studio-overlay.',
    destination: 'overlay',
    headlessTarget: 'overlay',
    output: {
      container: 'webm',
      codec: 'vp9',
      pixFmt: 'yuva420p',
      mimeType: 'video/webm',
      width: 520,
      height: 780,
      fps: 30,
      alpha: true
    },
    allowedParamKeys: ['badge', 'bodyColor', 'headColor', 'badgeColor'],
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        badge: { type: 'string', minLength: 1, maxLength: 8, description: 'Badge text' },
        bodyColor: { type: 'string', pattern: HEX_PATTERN, description: 'Body fill hex color' },
        headColor: { type: 'string', pattern: HEX_PATTERN, description: 'Head fill hex color' },
        badgeColor: { type: 'string', pattern: HEX_PATTERN, description: 'Badge fill hex color' }
      }
    },
    defaults: { ...NIX_OVERLAY_DEFAULTS }
  }
};

export function isAnimationTemplateId(value: unknown): value is AnimationTemplateId {
  return typeof value === 'string' && (ANIMATION_TEMPLATE_IDS as readonly string[]).includes(value);
}

export function getAnimationTemplate(id: string): AnimationTemplateDefinition | undefined {
  if (!isAnimationTemplateId(id)) {
    return undefined;
  }
  return ANIMATION_TEMPLATES[id];
}

export function listAnimationTemplateSummaries(): AnimationTemplateSummary[] {
  return ANIMATION_TEMPLATE_IDS.map((id) => {
    const template = ANIMATION_TEMPLATES[id];
    return {
      id: template.id,
      title: template.title,
      description: template.description,
      destination: template.destination,
      output: template.output,
      allowedParamKeys: template.allowedParamKeys,
      paramsSchema: template.paramsSchema,
      defaults: template.defaults
    };
  });
}
