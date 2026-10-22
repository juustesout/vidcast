import type {
  HtmlChartPoint,
  HtmlChartTemplateData,
  HtmlComparisonItem,
  HtmlComparisonTemplateData,
  HtmlHeadlineTemplateData,
  HtmlStatCardTemplateData,
  HtmlStillTemplateType,
  HtmlStillTrendDirection,
  HtmlTimelineEvent,
  HtmlTimelineTemplateData
} from '@/lib/types/scene';
import { HtmlStillError } from './errors';
import { escapeHtml } from './sanitize';

export const HTML_STILL_CANONICAL_TEMPLATE_IDS = ['headline', 'stat_card', 'comparison', 'chart', 'timeline'] as const;
export type HtmlStillCanonicalTemplateId = (typeof HTML_STILL_CANONICAL_TEMPLATE_IDS)[number];

export const HTML_STILL_TEMPLATE_IDS = [
  ...HTML_STILL_CANONICAL_TEMPLATE_IDS,
  'headline_card',
  'comparison_card',
  'stat-card'
] as const;
export type HtmlStillTemplateId = (typeof HTML_STILL_TEMPLATE_IDS)[number];

export const HTML_STILL_TEXT_LIMITS = {
  TITLE: 120,
  LINE: 160,
  VALUE: 32,
  NAME: 40,
  FEATURE: 48,
  ASSET_ID: 80,
  MIN_COMPARISON_ITEMS: 2,
  MAX_COMPARISON_ITEMS: 4,
  MIN_FEATURES: 1,
  MAX_FEATURES: 6,
  CHART_LABEL: 24,
  CHART_UNIT: 16,
  MIN_CHART_POINTS: 1,
  MAX_CHART_POINTS: 8,
  MAX_CHART_ABS: 1_000_000,
  MIN_TIMELINE_EVENTS: 1,
  MAX_TIMELINE_EVENTS: 6,
  DATE: 24
} as const;

const TEMPLATE_ALIASES: Record<string, HtmlStillCanonicalTemplateId> = {
  headline: 'headline',
  headline_card: 'headline',
  stat_card: 'stat_card',
  'stat-card': 'stat_card',
  comparison: 'comparison',
  comparison_card: 'comparison',
  chart: 'chart',
  timeline: 'timeline'
};

export type HeadlineCardData = HtmlHeadlineTemplateData;
export interface ComparisonCardRow {
  label: string;
  left: string;
  right: string;
}
export interface ComparisonCardData {
  title: string;
  leftLabel?: string;
  rightLabel?: string;
  rows?: ComparisonCardRow[];
  items?: HtmlComparisonItem[];
  background?: string;
  accent?: string;
  textColor?: string;
}

export function isHtmlStillTemplateId(value: unknown): value is HtmlStillTemplateId {
  return typeof value === 'string' && value in TEMPLATE_ALIASES;
}

export function canonicalizeHtmlStillTemplateId(value: unknown): HtmlStillCanonicalTemplateId | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return TEMPLATE_ALIASES[value];
}

function hexOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim()) ? value.trim() : fallback;
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HtmlStillError('html.template.data.invalid', `${field} is required.`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new HtmlStillError('html.template.data.invalid', `${field} exceeds ${max} characters.`);
  }
  return text;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new HtmlStillError('html.template.data.invalid', `${field} must be a string.`);
  }
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  if (text.length > max) {
    throw new HtmlStillError('html.template.data.invalid', `${field} exceeds ${max} characters.`);
  }
  return text;
}

function optionalHex(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim())) {
    throw new HtmlStillError('html.template.data.invalid', `${field} must be a hex color.`);
  }
  return value.trim();
}

function optionalAssetId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.trim())) {
    throw new HtmlStillError('html.template.data.invalid', `${field} must be a project asset id, not a URL or file path.`);
  }
  return value.trim();
}

function optionalTrend(value: unknown): HtmlStillTrendDirection | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value !== 'up' && value !== 'down' && value !== 'flat') {
    throw new HtmlStillError('html.template.data.invalid', 'trend must be up, down, or flat.');
  }
  return value;
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HtmlStillError('html.template.data.invalid', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function parseHeadlineTemplateData(data: Record<string, unknown>): HtmlHeadlineTemplateData {
  return {
    title: requireText(data.title, 'title', HTML_STILL_TEXT_LIMITS.TITLE),
    subtitle: optionalText(data.subtitle, 'subtitle', HTML_STILL_TEXT_LIMITS.LINE),
    source: optionalText(data.source, 'source', HTML_STILL_TEXT_LIMITS.LINE),
    kicker: optionalText(data.kicker, 'kicker', HTML_STILL_TEXT_LIMITS.LINE),
    imageAssetId: optionalAssetId(data.imageAssetId, 'imageAssetId'),
    background: optionalHex(data.background, 'background'),
    accent: optionalHex(data.accent, 'accent'),
    textColor: optionalHex(data.textColor, 'textColor')
  };
}

export function parseStatCardTemplateData(data: Record<string, unknown>): HtmlStatCardTemplateData {
  return {
    label: requireText(data.label, 'label', HTML_STILL_TEXT_LIMITS.LINE),
    value: requireText(data.value, 'value', HTML_STILL_TEXT_LIMITS.VALUE),
    detail: optionalText(data.detail, 'detail', HTML_STILL_TEXT_LIMITS.LINE),
    trend: optionalTrend(data.trend),
    delta: optionalText(data.delta, 'delta', HTML_STILL_TEXT_LIMITS.VALUE),
    background: optionalHex(data.background, 'background'),
    accent: optionalHex(data.accent, 'accent'),
    textColor: optionalHex(data.textColor, 'textColor')
  };
}

function parseFeature(value: unknown, index: number): { label: string; value: string } {
  const row = assertPlainObject(value, `features[${index}]`);
  return {
    label: requireText(row.label, `features[${index}].label`, HTML_STILL_TEXT_LIMITS.FEATURE),
    value: requireText(row.value, `features[${index}].value`, HTML_STILL_TEXT_LIMITS.FEATURE)
  };
}

function parseComparisonItem(value: unknown, index: number): HtmlComparisonItem {
  const item = assertPlainObject(value, `items[${index}]`);
  if (!Array.isArray(item.features)) {
    throw new HtmlStillError('html.template.data.invalid', `items[${index}].features must be an array.`);
  }
  if (item.features.length < HTML_STILL_TEXT_LIMITS.MIN_FEATURES || item.features.length > HTML_STILL_TEXT_LIMITS.MAX_FEATURES) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `items[${index}] must have ${HTML_STILL_TEXT_LIMITS.MIN_FEATURES}-${HTML_STILL_TEXT_LIMITS.MAX_FEATURES} features.`
    );
  }
  return {
    name: requireText(item.name, `items[${index}].name`, HTML_STILL_TEXT_LIMITS.NAME),
    features: item.features.map((feature, featureIndex) => parseFeature(feature, featureIndex))
  };
}

function comparisonItemsFromLegacyRows(data: Record<string, unknown>): HtmlComparisonItem[] | undefined {
  if (!Array.isArray(data.rows) || data.rows.length === 0) {
    return undefined;
  }
  const leftName = optionalText(data.leftLabel, 'leftLabel', HTML_STILL_TEXT_LIMITS.NAME) ?? 'Before';
  const rightName = optionalText(data.rightLabel, 'rightLabel', HTML_STILL_TEXT_LIMITS.NAME) ?? 'After';
  const rows = data.rows.map((row, index) => {
    const entry = assertPlainObject(row, `rows[${index}]`);
    return {
      label: requireText(entry.label, `rows[${index}].label`, HTML_STILL_TEXT_LIMITS.FEATURE),
      left: requireText(entry.left, `rows[${index}].left`, HTML_STILL_TEXT_LIMITS.FEATURE),
      right: requireText(entry.right, `rows[${index}].right`, HTML_STILL_TEXT_LIMITS.FEATURE)
    };
  });
  if (rows.length > HTML_STILL_TEXT_LIMITS.MAX_FEATURES) {
    throw new HtmlStillError('html.template.data.invalid', `comparison supports at most ${HTML_STILL_TEXT_LIMITS.MAX_FEATURES} features.`);
  }
  return [
    { name: leftName, features: rows.map((row) => ({ label: row.label, value: row.left })) },
    { name: rightName, features: rows.map((row) => ({ label: row.label, value: row.right })) }
  ];
}

export function parseComparisonTemplateData(data: Record<string, unknown>): HtmlComparisonTemplateData {
  const title = requireText(data.title, 'title', HTML_STILL_TEXT_LIMITS.TITLE);
  const items = Array.isArray(data.items)
    ? data.items.map((item, index) => parseComparisonItem(item, index))
    : comparisonItemsFromLegacyRows(data);
  if (!items || items.length < HTML_STILL_TEXT_LIMITS.MIN_COMPARISON_ITEMS) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `comparison requires ${HTML_STILL_TEXT_LIMITS.MIN_COMPARISON_ITEMS}-${HTML_STILL_TEXT_LIMITS.MAX_COMPARISON_ITEMS} items.`
    );
  }
  if (items.length > HTML_STILL_TEXT_LIMITS.MAX_COMPARISON_ITEMS) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `comparison supports at most ${HTML_STILL_TEXT_LIMITS.MAX_COMPARISON_ITEMS} items.`
    );
  }
  const featureCount = items[0].features.length;
  if (items.some((item) => item.features.length !== featureCount)) {
    throw new HtmlStillError('html.template.data.invalid', 'comparison items must share the same number of features.');
  }
  return {
    title,
    items,
    background: optionalHex(data.background, 'background'),
    accent: optionalHex(data.accent, 'accent'),
    textColor: optionalHex(data.textColor, 'textColor')
  };
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HtmlStillError('html.template.data.invalid', `${field} must be a finite number.`);
  }
  if (Math.abs(value) > HTML_STILL_TEXT_LIMITS.MAX_CHART_ABS) {
    throw new HtmlStillError('html.template.data.invalid', `${field} exceeds ${HTML_STILL_TEXT_LIMITS.MAX_CHART_ABS}.`);
  }
  return value;
}

function parseChartPoint(value: unknown, index: number): HtmlChartPoint {
  const point = assertPlainObject(value, `points[${index}]`);
  return {
    label: requireText(point.label, `points[${index}].label`, HTML_STILL_TEXT_LIMITS.CHART_LABEL),
    value: requireFiniteNumber(point.value, `points[${index}].value`)
  };
}

export function parseChartTemplateData(data: Record<string, unknown>): HtmlChartTemplateData {
  if (data.kind !== 'bar' && data.kind !== 'line') {
    throw new HtmlStillError('html.template.data.invalid', 'kind must be bar or line.');
  }
  if (!Array.isArray(data.points)) {
    throw new HtmlStillError('html.template.data.invalid', 'points must be an array.');
  }
  if (data.points.length < HTML_STILL_TEXT_LIMITS.MIN_CHART_POINTS || data.points.length > HTML_STILL_TEXT_LIMITS.MAX_CHART_POINTS) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `chart requires ${HTML_STILL_TEXT_LIMITS.MIN_CHART_POINTS}-${HTML_STILL_TEXT_LIMITS.MAX_CHART_POINTS} points.`
    );
  }
  return {
    title: requireText(data.title, 'title', HTML_STILL_TEXT_LIMITS.TITLE),
    kind: data.kind,
    points: data.points.map((point, index) => parseChartPoint(point, index)),
    unit: optionalText(data.unit, 'unit', HTML_STILL_TEXT_LIMITS.CHART_UNIT),
    background: optionalHex(data.background, 'background'),
    accent: optionalHex(data.accent, 'accent'),
    textColor: optionalHex(data.textColor, 'textColor')
  };
}

function parseTimelineEvent(value: unknown, index: number): HtmlTimelineEvent {
  const event = assertPlainObject(value, `events[${index}]`);
  return {
    label: requireText(event.label, `events[${index}].label`, HTML_STILL_TEXT_LIMITS.NAME),
    detail: requireText(event.detail, `events[${index}].detail`, HTML_STILL_TEXT_LIMITS.LINE),
    date: optionalText(event.date, `events[${index}].date`, HTML_STILL_TEXT_LIMITS.DATE)
  };
}

export function parseTimelineTemplateData(data: Record<string, unknown>): HtmlTimelineTemplateData {
  if (!Array.isArray(data.events)) {
    throw new HtmlStillError('html.template.data.invalid', 'events must be an array.');
  }
  if (data.events.length < HTML_STILL_TEXT_LIMITS.MIN_TIMELINE_EVENTS || data.events.length > HTML_STILL_TEXT_LIMITS.MAX_TIMELINE_EVENTS) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `timeline requires ${HTML_STILL_TEXT_LIMITS.MIN_TIMELINE_EVENTS}-${HTML_STILL_TEXT_LIMITS.MAX_TIMELINE_EVENTS} events.`
    );
  }
  return {
    title: requireText(data.title, 'title', HTML_STILL_TEXT_LIMITS.TITLE),
    events: data.events.map((event, index) => parseTimelineEvent(event, index)),
    background: optionalHex(data.background, 'background'),
    accent: optionalHex(data.accent, 'accent'),
    textColor: optionalHex(data.textColor, 'textColor')
  };
}

export function parseHtmlStillTemplateData(
  templateId: HtmlStillCanonicalTemplateId,
  data: Record<string, unknown>
): HtmlHeadlineTemplateData | HtmlStatCardTemplateData | HtmlComparisonTemplateData | HtmlChartTemplateData | HtmlTimelineTemplateData {
  if (templateId === 'headline') {
    return parseHeadlineTemplateData(data);
  }
  if (templateId === 'stat_card') {
    return parseStatCardTemplateData(data);
  }
  if (templateId === 'comparison') {
    return parseComparisonTemplateData(data);
  }
  if (templateId === 'chart') {
    return parseChartTemplateData(data);
  }
  return parseTimelineTemplateData(data);
}

function trendMark(trend: HtmlStillTrendDirection): string {
  if (trend === 'up') {
    return '▲';
  }
  if (trend === 'down') {
    return '▼';
  }
  return '■';
}

export function buildHeadlineCardMarkup(data: HtmlHeadlineTemplateData): { markup: string; css: string; background: string } {
  const background = hexOr(data.background, '#0056a7');
  const accent = hexOr(data.accent, '#ff5a5f');
  const textColor = hexOr(data.textColor, '#ffffff');
  const kicker = data.kicker ? escapeHtml(data.kicker) : '';
  const title = escapeHtml(data.title);
  const subtitle = data.subtitle ? escapeHtml(data.subtitle) : '';
  const source = data.source ? escapeHtml(data.source) : '';
  const hasImage = Boolean(data.imageAssetId);

  return {
    background,
    css: `
.card{box-sizing:border-box;width:100%;height:100%;padding:96px 120px;display:flex;flex-direction:row;align-items:stretch;gap:64px;font-family:DejaVu Sans,Arial,sans-serif;color:${textColor};}
.copy{flex:1;display:flex;flex-direction:column;justify-content:center;gap:28px;min-width:0;}
.kicker{font-size:28px;letter-spacing:0.28em;text-transform:uppercase;color:${accent};font-weight:700;}
.title{font-size:92px;line-height:1.05;font-weight:800;max-width:16ch;overflow:hidden;}
.subtitle{font-size:36px;line-height:1.35;opacity:0.92;max-width:28ch;overflow:hidden;}
.source{font-size:24px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.78;}
.rule{width:120px;height:8px;background:${accent};border-radius:999px;flex:0 0 auto;}
.image{width:420px;flex:0 0 420px;border:4px solid ${accent};border-radius:28px;display:${hasImage ? 'flex' : 'none'};align-items:center;justify-content:center;background:rgba(0,0,0,0.18);}
.image span{font-size:22px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.7;}
`,
    markup: `<div class="card"><div class="copy">${kicker ? `<div class="kicker">${kicker}</div>` : ''}<div class="title">${title}</div><div class="rule"></div>${subtitle ? `<div class="subtitle">${subtitle}</div>` : ''}${source ? `<div class="source">${source}</div>` : ''}</div>${hasImage ? '<div class="image"><span>Still</span></div>' : ''}</div>`
  };
}

export function buildStatCardMarkup(data: HtmlStatCardTemplateData): { markup: string; css: string; background: string } {
  const background = hexOr(data.background, '#111827');
  const accent = hexOr(data.accent, '#f59e0b');
  const textColor = hexOr(data.textColor, '#f8fafc');
  const trend = data.trend ? `<div class="trend trend-${data.trend}">${trendMark(data.trend)}${data.delta ? ` ${escapeHtml(data.delta)}` : ''}</div>` : (data.delta ? `<div class="trend">${escapeHtml(data.delta)}</div>` : '');

  return {
    background,
    css: `
.card{box-sizing:border-box;width:100%;height:100%;padding:110px 130px;display:flex;flex-direction:column;justify-content:center;gap:24px;font-family:DejaVu Sans,Arial,sans-serif;color:${textColor};}
.label{font-size:32px;letter-spacing:0.22em;text-transform:uppercase;color:${accent};font-weight:700;}
.value{font-size:168px;line-height:0.92;font-weight:800;letter-spacing:-0.04em;}
.detail{font-size:36px;line-height:1.35;max-width:28ch;opacity:0.9;}
.trend{font-size:34px;font-weight:700;}
.trend-up{color:#34d399;}
.trend-down{color:#f87171;}
.trend-flat{color:#94a3b8;}
.rule{width:140px;height:8px;background:${accent};border-radius:999px;}
`,
    markup: `<div class="card"><div class="label">${escapeHtml(data.label)}</div><div class="value">${escapeHtml(data.value)}</div><div class="rule"></div>${data.detail ? `<div class="detail">${escapeHtml(data.detail)}</div>` : ''}${trend}</div>`
  };
}

export function buildComparisonCardMarkup(data: HtmlComparisonTemplateData | ComparisonCardData): { markup: string; css: string; background: string } {
  const parsed = parseComparisonTemplateData({
    title: data.title,
    items: data.items,
    rows: 'rows' in data ? data.rows : undefined,
    leftLabel: 'leftLabel' in data ? data.leftLabel : undefined,
    rightLabel: 'rightLabel' in data ? data.rightLabel : undefined,
    background: data.background,
    accent: data.accent,
    textColor: data.textColor
  });
  const background = hexOr(parsed.background, '#0f172a');
  const accent = hexOr(parsed.accent, '#38bdf8');
  const textColor = hexOr(parsed.textColor, '#f8fafc');
  const items = parsed.items;
  const columns = items.map((item) => {
    const features = item.features.map((feature) => `<li><span>${escapeHtml(feature.label)}</span><strong>${escapeHtml(feature.value)}</strong></li>`).join('');
    return `<section class="item"><h2>${escapeHtml(item.name)}</h2><ul>${features}</ul></section>`;
  }).join('');

  return {
    background,
    css: `
.card{box-sizing:border-box;width:100%;height:100%;padding:80px 96px;display:flex;flex-direction:column;gap:40px;font-family:DejaVu Sans,Arial,sans-serif;color:${textColor};}
.title{font-size:64px;font-weight:800;}
.rule{width:96px;height:6px;background:${accent};border-radius:999px;}
.grid{display:flex;gap:28px;flex:1;min-height:0;}
.item{flex:1;min-width:0;background:rgba(15,23,42,0.35);border-radius:28px;padding:36px 32px;display:flex;flex-direction:column;gap:24px;}
.item h2{margin:0;font-size:36px;color:${accent};}
.item ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:16px;}
.item li{display:flex;justify-content:space-between;gap:16px;font-size:28px;}
.item span{opacity:0.78;}
.item strong{font-weight:700;}
`,
    markup: `<div class="card"><div class="title">${escapeHtml(parsed.title)}</div><div class="rule"></div><div class="grid">${columns}</div></div>`
  };
}

function formatChartValue(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(1).replace(/\.0$/, '');
}

function chartScale(points: HtmlChartPoint[]): { min: number; max: number; span: number } {
  const values = points.map((point) => point.value);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  if (dataMin === dataMax) {
    if (dataMin === 0) {
      return { min: 0, max: 1, span: 1 };
    }
    const pad = Math.abs(dataMin) * 0.25;
    const min = dataMin > 0 ? 0 : dataMin - pad;
    const max = dataMin < 0 ? 0 : dataMax + pad;
    return { min, max, span: max - min };
  }
  const min = Math.min(0, dataMin);
  const max = Math.max(0, dataMax);
  return { min, max, span: max - min };
}

function chartY(value: number, scale: { min: number; span: number }, top: number, height: number): number {
  return top + height - ((value - scale.min) / scale.span) * height;
}

function buildChartSvg(data: HtmlChartTemplateData, accent: string, textColor: string): string {
  const width = 1480;
  const height = 620;
  const left = 96;
  const right = 40;
  const top = 28;
  const bottom = 78;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const scale = chartScale(data.points);
  const zeroY = chartY(0, scale, top, plotHeight);
  const count = data.points.length;
  const step = count === 1 ? plotWidth / 2 : plotWidth / (count - (data.kind === 'line' ? 1 : 0));
  const barWidth = Math.min(120, Math.max(36, (plotWidth / Math.max(count, 1)) * 0.55));
  const ticks = [scale.min, scale.min + scale.span / 2, scale.max];
  const axis = `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}" stroke="${textColor}" stroke-width="3" stroke-opacity="0.35"/><line x1="${left}" y1="${zeroY}" x2="${left + plotWidth}" y2="${zeroY}" stroke="${textColor}" stroke-width="3" stroke-opacity="0.45"/>`;
  const grid = ticks.map((tick) => {
    const y = chartY(tick, scale, top, plotHeight);
    return `<line x1="${left}" y1="${y}" x2="${left + plotWidth}" y2="${y}" stroke="${textColor}" stroke-width="2" stroke-opacity="0.12"/><text x="${left - 16}" y="${y + 10}" text-anchor="end" fill="${textColor}" font-size="22" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(formatChartValue(tick))}</text>`;
  }).join('');
  const bars = data.kind === 'bar'
    ? data.points.map((point, index) => {
        const center = left + (count === 1 ? plotWidth / 2 : (index + 0.5) * (plotWidth / count));
        const y = chartY(point.value, scale, top, plotHeight);
        const barTop = Math.min(y, zeroY);
        const barHeight = Math.max(6, Math.abs(zeroY - y));
        return `<rect x="${center - barWidth / 2}" y="${barTop}" width="${barWidth}" height="${barHeight}" rx="10" fill="${accent}"/><text x="${center}" y="${barTop - 12}" text-anchor="middle" fill="${textColor}" font-size="24" font-weight="700" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(formatChartValue(point.value))}</text><text x="${center}" y="${top + plotHeight + 40}" text-anchor="middle" fill="${textColor}" font-size="24" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(point.label)}</text>`;
      }).join('')
    : '';
  const line = data.kind === 'line'
    ? (() => {
        const coords = data.points.map((point, index) => {
          const x = left + (count === 1 ? plotWidth / 2 : index * step);
          const y = chartY(point.value, scale, top, plotHeight);
          return { x, y, point };
        });
        const polyline = coords.map((coord) => `${coord.x},${coord.y}`).join(' ');
        const dots = coords.map((coord) => `<circle cx="${coord.x}" cy="${coord.y}" r="10" fill="${accent}"/><text x="${coord.x}" y="${coord.y - 18}" text-anchor="middle" fill="${textColor}" font-size="24" font-weight="700" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(formatChartValue(coord.point.value))}</text><text x="${coord.x}" y="${top + plotHeight + 40}" text-anchor="middle" fill="${textColor}" font-size="24" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(coord.point.label)}</text>`).join('');
        return `<polyline fill="none" stroke="${accent}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" points="${polyline}"/>${dots}`;
      })()
    : '';
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="100%">${axis}${grid}${bars}${line}</svg>`;
}

export function buildChartMarkup(data: HtmlChartTemplateData): { markup: string; css: string; background: string } {
  const background = hexOr(data.background, '#0b1220');
  const accent = hexOr(data.accent, '#22d3ee');
  const textColor = hexOr(data.textColor, '#f8fafc');
  const unit = data.unit ? `<div class="unit">${escapeHtml(data.unit)}</div>` : '';
  return {
    background,
    css: `
.card{box-sizing:border-box;width:100%;height:100%;padding:72px 96px 64px;display:flex;flex-direction:column;gap:28px;font-family:DejaVu Sans,Arial,sans-serif;color:${textColor};}
.head{display:flex;align-items:baseline;justify-content:space-between;gap:24px;}
.title{font-size:56px;font-weight:800;overflow:hidden;max-width:22ch;}
.unit{font-size:28px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.72;}
.rule{width:96px;height:6px;background:${accent};border-radius:999px;}
.plot{flex:1;min-height:0;}
.chart{display:block;}
`,
    markup: `<div class="card"><div class="head"><div class="title">${escapeHtml(data.title)}</div>${unit}</div><div class="rule"></div><div class="plot">${buildChartSvg(data, accent, textColor)}</div></div>`
  };
}

export function buildTimelineMarkup(data: HtmlTimelineTemplateData): { markup: string; css: string; background: string } {
  const background = hexOr(data.background, '#111827');
  const accent = hexOr(data.accent, '#fb7185');
  const textColor = hexOr(data.textColor, '#f8fafc');
  const events = data.events.map((event, index) => {
    const date = event.date ? `<div class="date">${escapeHtml(event.date)}</div>` : '<div class="date date-empty"> </div>';
    return `<li class="event"><div class="marker">${index + 1}</div><div class="copy">${date}<div class="label">${escapeHtml(event.label)}</div><div class="detail">${escapeHtml(event.detail)}</div></div></li>`;
  }).join('');
  return {
    background,
    css: `
.card{box-sizing:border-box;width:100%;height:100%;padding:80px 120px;display:flex;flex-direction:column;gap:36px;font-family:DejaVu Sans,Arial,sans-serif;color:${textColor};}
.title{font-size:64px;font-weight:800;overflow:hidden;max-width:22ch;}
.rule{width:96px;height:6px;background:${accent};border-radius:999px;}
.events{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:28px;flex:1;min-height:0;position:relative;}
.events:before{content:"";position:absolute;left:28px;top:8px;bottom:8px;width:6px;background:${accent};border-radius:999px;opacity:0.55;}
.event{display:flex;gap:36px;align-items:flex-start;min-height:0;}
.marker{flex:0 0 62px;width:62px;height:62px;border-radius:999px;background:${accent};color:#111827;font-size:28px;font-weight:800;display:flex;align-items:center;justify-content:center;position:relative;z-index:1;}
.copy{min-width:0;display:flex;flex-direction:column;gap:8px;padding-top:4px;}
.date{font-size:22px;letter-spacing:0.16em;text-transform:uppercase;color:${accent};font-weight:700;min-height:1.2em;}
.date-empty{opacity:0;}
.label{font-size:36px;font-weight:800;overflow:hidden;max-width:28ch;}
.detail{font-size:28px;line-height:1.35;opacity:0.88;overflow:hidden;max-width:42ch;}
`,
    markup: `<div class="card"><div class="title">${escapeHtml(data.title)}</div><div class="rule"></div><ol class="events">${events}</ol></div>`
  };
}

export function resolveHtmlStillTemplate(templateId: HtmlStillTemplateType | HtmlStillTemplateId, data: Record<string, unknown>): { markup: string; css: string; background: string } {
  const canonical = canonicalizeHtmlStillTemplateId(templateId);
  if (!canonical) {
    throw new HtmlStillError('html.template.unknown', `Unknown HTML still template: ${String(templateId)}.`);
  }
  const parsed = parseHtmlStillTemplateData(canonical, data);
  if (canonical === 'headline') {
    return buildHeadlineCardMarkup(parsed as HtmlHeadlineTemplateData);
  }
  if (canonical === 'stat_card') {
    return buildStatCardMarkup(parsed as HtmlStatCardTemplateData);
  }
  if (canonical === 'comparison') {
    return buildComparisonCardMarkup(parsed as HtmlComparisonTemplateData);
  }
  if (canonical === 'chart') {
    return buildChartMarkup(parsed as HtmlChartTemplateData);
  }
  return buildTimelineMarkup(parsed as HtmlTimelineTemplateData);
}
