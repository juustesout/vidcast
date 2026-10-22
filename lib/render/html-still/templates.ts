import { escapeHtml } from './sanitize';

export const HTML_STILL_TEMPLATE_IDS = ['headline_card', 'comparison_card'] as const;
export type HtmlStillTemplateId = (typeof HTML_STILL_TEMPLATE_IDS)[number];

export interface HeadlineCardData {
  kicker?: string;
  title: string;
  subtitle?: string;
  background?: string;
  accent?: string;
  textColor?: string;
}

export interface ComparisonCardRow {
  label: string;
  left: string;
  right: string;
}

export interface ComparisonCardData {
  title: string;
  leftLabel?: string;
  rightLabel?: string;
  rows: ComparisonCardRow[];
  background?: string;
  accent?: string;
  textColor?: string;
}

export function isHtmlStillTemplateId(value: unknown): value is HtmlStillTemplateId {
  return value === 'headline_card' || value === 'comparison_card';
}

function hexOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim()) ? value.trim() : fallback;
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function buildHeadlineCardMarkup(data: HeadlineCardData): { markup: string; css: string; background: string } {
  const background = hexOr(data.background, '#0056a7');
  const accent = hexOr(data.accent, '#ff5a5f');
  const textColor = hexOr(data.textColor, '#ffffff');
  const kicker = data.kicker ? escapeHtml(data.kicker) : '';
  const title = escapeHtml(textOr(data.title, 'Headline'));
  const subtitle = data.subtitle ? escapeHtml(data.subtitle) : '';

  return {
    background,
    css: `
.card{box-sizing:border-box;width:100%;height:100%;padding:96px 120px;display:flex;flex-direction:column;justify-content:center;gap:28px;font-family:DejaVu Sans,Arial,sans-serif;color:${textColor};}
.kicker{font-size:28px;letter-spacing:0.28em;text-transform:uppercase;color:${accent};font-weight:700;}
.title{font-size:92px;line-height:1.05;font-weight:800;max-width:18ch;}
.subtitle{font-size:36px;line-height:1.35;opacity:0.92;max-width:28ch;}
.rule{width:120px;height:8px;background:${accent};border-radius:999px;}
`,
    markup: `<div class="card">${kicker ? `<div class="kicker">${kicker}</div>` : ''}<div class="title">${title}</div><div class="rule"></div>${subtitle ? `<div class="subtitle">${subtitle}</div>` : ''}</div>`
  };
}

export function buildComparisonCardMarkup(data: ComparisonCardData): { markup: string; css: string; background: string } {
  const background = hexOr(data.background, '#0f172a');
  const accent = hexOr(data.accent, '#38bdf8');
  const textColor = hexOr(data.textColor, '#f8fafc');
  const title = escapeHtml(textOr(data.title, 'Comparison'));
  const leftLabel = escapeHtml(textOr(data.leftLabel, 'Before'));
  const rightLabel = escapeHtml(textOr(data.rightLabel, 'After'));
  const rows = (Array.isArray(data.rows) ? data.rows : []).slice(0, 8).map((row) => ({
    label: escapeHtml(textOr(row?.label, '')),
    left: escapeHtml(textOr(row?.left, '')),
    right: escapeHtml(textOr(row?.right, ''))
  })).filter((row) => row.label || row.left || row.right);

  const body = rows.length > 0
    ? rows.map((row) => `<tr><th>${row.label}</th><td>${row.left}</td><td>${row.right}</td></tr>`).join('')
    : '<tr><th>Metric</th><td>Before</td><td>After</td></tr>';

  return {
    background,
    css: `
.card{box-sizing:border-box;width:100%;height:100%;padding:80px 110px;display:flex;flex-direction:column;gap:36px;font-family:DejaVu Sans,Arial,sans-serif;color:${textColor};}
.title{font-size:64px;font-weight:800;}
.rule{width:96px;height:6px;background:${accent};border-radius:999px;}
table{width:100%;border-collapse:separate;border-spacing:0 12px;font-size:32px;}
th,td{padding:18px 24px;text-align:left;}
th{width:32%;color:${accent};font-weight:700;}
td{background:rgba(15,23,42,0.35);font-weight:600;}
td:first-of-type{border-radius:16px 0 0 16px;}
td:last-of-type{border-radius:0 16px 16px 0;}
thead td{background:transparent;color:${accent};font-size:22px;letter-spacing:0.16em;text-transform:uppercase;}
`,
    markup: `<div class="card"><div class="title">${title}</div><div class="rule"></div><table><thead><tr><th></th><td>${leftLabel}</td><td>${rightLabel}</td></tr></thead><tbody>${body}</tbody></table></div>`
  };
}

export function resolveHtmlStillTemplate(templateId: HtmlStillTemplateId, data: Record<string, unknown>): { markup: string; css: string; background: string } {
  if (templateId === 'headline_card') {
    return buildHeadlineCardMarkup({
      kicker: typeof data.kicker === 'string' ? data.kicker : undefined,
      title: textOr(data.title, 'Headline'),
      subtitle: typeof data.subtitle === 'string' ? data.subtitle : undefined,
      background: typeof data.background === 'string' ? data.background : undefined,
      accent: typeof data.accent === 'string' ? data.accent : undefined,
      textColor: typeof data.textColor === 'string' ? data.textColor : undefined
    });
  }

  const rows = Array.isArray(data.rows)
    ? data.rows.filter((row): row is ComparisonCardRow => Boolean(row) && typeof row === 'object').map((row) => ({
        label: typeof row.label === 'string' ? row.label : '',
        left: typeof row.left === 'string' ? row.left : '',
        right: typeof row.right === 'string' ? row.right : ''
      }))
    : [];

  return buildComparisonCardMarkup({
    title: textOr(data.title, 'Comparison'),
    leftLabel: typeof data.leftLabel === 'string' ? data.leftLabel : undefined,
    rightLabel: typeof data.rightLabel === 'string' ? data.rightLabel : undefined,
    rows,
    background: typeof data.background === 'string' ? data.background : undefined,
    accent: typeof data.accent === 'string' ? data.accent : undefined,
    textColor: typeof data.textColor === 'string' ? data.textColor : undefined
  });
}
