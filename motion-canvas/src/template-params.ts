export interface ChartParams {
  title: string;
  subtitle: string;
  labels: string[];
  values: number[];
  colors: string[];
  background: string;
  holdSeconds: number;
}

export interface OverlayParams {
  badge: string;
  bodyColor: string;
  headColor: string;
  badgeColor: string;
}

export const DEFAULT_CHART_PARAMS: ChartParams = {
  title: 'Northwind ARR',
  subtitle: 'Last five quarters, $M',
  labels: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'],
  values: [24, 41, 63, 88, 76],
  colors: ['#38bdf8', '#60a5fa', '#34d399', '#fbbf24', '#f472b6'],
  background: '#0f172a',
  holdSeconds: 2.1,
};

export const DEFAULT_OVERLAY_PARAMS: OverlayParams = {
  badge: 'NIX',
  bodyColor: '#0e7490',
  headColor: '#22d3ee',
  badgeColor: '#ef4444',
};

export interface TemplateParamPayload {
  templateId?: string;
  target?: string;
  outputName?: string;
  params?: Record<string, unknown>;
}

function payload(): TemplateParamPayload {
  return ((globalThis as {__MC_TEMPLATE_PARAMS?: TemplateParamPayload}).__MC_TEMPLATE_PARAMS) ?? {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : fallback;
}

function asNumberArray(value: unknown, fallback: number[]): number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ? (value as number[])
    : fallback;
}

export function readChartParams(): ChartParams {
  const raw = payload().params ?? {};
  const labels = asStringArray(raw.labels, DEFAULT_CHART_PARAMS.labels);
  const values = asNumberArray(raw.values, DEFAULT_CHART_PARAMS.values);
  const colors = asStringArray(raw.colors, DEFAULT_CHART_PARAMS.colors);
  const count = Math.min(labels.length, values.length, colors.length);
  return {
    title: asString(raw.title, DEFAULT_CHART_PARAMS.title),
    subtitle: asString(raw.subtitle, DEFAULT_CHART_PARAMS.subtitle),
    labels: labels.slice(0, count),
    values: values.slice(0, count),
    colors: colors.slice(0, count),
    background: asString(raw.background, DEFAULT_CHART_PARAMS.background),
    holdSeconds: asNumber(raw.holdSeconds, DEFAULT_CHART_PARAMS.holdSeconds),
  };
}

export function readOverlayParams(): OverlayParams {
  const raw = payload().params ?? {};
  return {
    badge: asString(raw.badge, DEFAULT_OVERLAY_PARAMS.badge),
    bodyColor: asString(raw.bodyColor, DEFAULT_OVERLAY_PARAMS.bodyColor),
    headColor: asString(raw.headColor, DEFAULT_OVERLAY_PARAMS.headColor),
    badgeColor: asString(raw.badgeColor, DEFAULT_OVERLAY_PARAMS.badgeColor),
  };
}

export function readTemplatePayload(): TemplateParamPayload {
  return payload();
}
