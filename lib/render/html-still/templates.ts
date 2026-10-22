import type {
  HtmlComparisonItem,
  HtmlComparisonTemplateData,
  HtmlHeadlineTemplateData,
  HtmlStatCardTemplateData,
  HtmlStillTemplateType,
  HtmlStillTrendDirection
} from '@/lib/types/scene';
import { HtmlStillError } from './errors';
import { escapeHtml } from './sanitize';

export const HTML_STILL_CANONICAL_TEMPLATE_IDS = ['headline', 'stat_card', 'comparison'] as const;
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
  MAX_FEATURES: 6
} as const;

const TEMPLATE_ALIASES: Record<string, HtmlStillCanonicalTemplateId> = {
  headline: 'headline',
  headline_card: 'headline',
  stat_card: 'stat_card',
  'stat-card': 'stat_card',
  comparison: 'comparison',
  comparison_card: 'comparison'
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

export function parseHtmlStillTemplateData(
  templateId: HtmlStillCanonicalTemplateId,
  data: Record<string, unknown>
): HtmlHeadlineTemplateData | HtmlStatCardTemplateData | HtmlComparisonTemplateData {
  if (templateId === 'headline') {
    return parseHeadlineTemplateData(data);
  }
  if (templateId === 'stat_card') {
    return parseStatCardTemplateData(data);
  }
  return parseComparisonTemplateData(data);
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
  return buildComparisonCardMarkup(parsed as HtmlComparisonTemplateData);
}
