import { HtmlStillError } from './errors';

export const HTML_STILL_MAX_CHARS = 50_000;

const FORBIDDEN_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'link',
  'base',
  'meta',
  'applet',
  'video',
  'audio',
  'source',
  'track',
  'frame',
  'frameset',
  'portal',
  'template',
  'foreignobject',
  'use',
  'animate',
  'set',
  'handler'
];

const FORBIDDEN_URL_PATTERN = /(?:javascript|vbscript|file|https?|ftp|ws|blob|data)\s*:/i;
const CSS_URL_PATTERN = /url\s*\(/i;
const CSS_IMPORT_PATTERN = /@import/i;
const EVENT_HANDLER_PATTERN = /\son[a-z]+\s*=/i;
const SRCDOC_PATTERN = /\ssrcdoc\s*=/i;
const XLINK_PATTERN = /\s(?:xlink:)?href\s*=/i;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function containsForbiddenTag(value: string): string | undefined {
  const lower = value.toLowerCase();
  return FORBIDDEN_TAGS.find((tag) => lower.includes(`<${tag}`) || lower.includes(`</${tag}`));
}

export function assertSafeHtmlFragment(value: string, label: string): string {
  if (typeof value !== 'string') {
    throw new HtmlStillError('html.invalid', `${label} must be a string.`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new HtmlStillError('html.invalid', `${label} is empty.`);
  }
  if (trimmed.length > HTML_STILL_MAX_CHARS) {
    throw new HtmlStillError('html.tooLarge', `${label} exceeds ${HTML_STILL_MAX_CHARS} characters.`);
  }

  const forbiddenTag = containsForbiddenTag(trimmed);
  if (forbiddenTag) {
    throw new HtmlStillError('html.invalid', `${label} contains forbidden tag <${forbiddenTag}>.`);
  }
  if (EVENT_HANDLER_PATTERN.test(trimmed) || SRCDOC_PATTERN.test(trimmed)) {
    throw new HtmlStillError('html.invalid', `${label} contains event handlers or srcdoc.`);
  }
  if (FORBIDDEN_URL_PATTERN.test(trimmed) || XLINK_PATTERN.test(trimmed)) {
    throw new HtmlStillError('html.invalid', `${label} contains a remote, data, or script URL.`);
  }
  if (CSS_URL_PATTERN.test(trimmed) || CSS_IMPORT_PATTERN.test(trimmed)) {
    throw new HtmlStillError('html.invalid', `${label} contains CSS url() or @import.`);
  }

  return trimmed;
}

export function assertSafeCss(value: string | undefined): string {
  if (value === undefined || value === '') {
    return '';
  }
  if (typeof value !== 'string') {
    throw new HtmlStillError('html.invalid', 'CSS must be a string.');
  }
  if (value.length > HTML_STILL_MAX_CHARS) {
    throw new HtmlStillError('html.tooLarge', `CSS exceeds ${HTML_STILL_MAX_CHARS} characters.`);
  }
  if (FORBIDDEN_URL_PATTERN.test(value) || CSS_URL_PATTERN.test(value) || CSS_IMPORT_PATTERN.test(value) || EVENT_HANDLER_PATTERN.test(value)) {
    throw new HtmlStillError('html.invalid', 'CSS contains a remote URL, url(), @import, or event handler.');
  }
  if (containsForbiddenTag(value)) {
    throw new HtmlStillError('html.invalid', 'CSS contains HTML tags.');
  }
  return value.trim();
}

export function wrapHtmlStillDocument(input: {
  markup: string;
  css?: string;
  width: number;
  height: number;
  background: 'opaque' | 'transparent';
  pageBackground?: string;
}): string {
  const markup = assertSafeHtmlFragment(input.markup, 'HTML markup');
  const css = assertSafeCss(input.css);
  const pageBackground = input.background === 'transparent'
    ? 'transparent'
    : (input.pageBackground && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(input.pageBackground) ? input.pageBackground : '#0f172a');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html,body{margin:0;padding:0;width:${input.width}px;height:${input.height}px;overflow:hidden;background:${pageBackground};}
${css}
</style>
</head>
<body>
${markup}
</body>
</html>
`;
}
