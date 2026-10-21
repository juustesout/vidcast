import { getAnimationTemplate } from './catalog';
import { AnimationError } from './errors';
import type {
  AnimationAttachInput,
  AnimationAttachPosition,
  AnimationAttachRect,
  AnimationDestination,
  AnimationTemplateDefinition,
  AnimationTemplateId,
  AnimationTemplateParams,
  NixOverlayParams,
  NorthwindChartParams
} from './types';

const HEX_COLOR = /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
const SAFE_TEXT = /^[\p{L}\p{N} .,_$%/+-]+$/u;
const MAX_PARAM_OBJECT_KEYS = 16;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string, details?: Record<string, unknown>): never {
  throw new AnimationError('animation.params.invalid', message, details);
}

function assertNoUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    fail(`Unknown field(s) on ${path}: ${extra.join(', ')}.`, { path, extra });
  }
}

function assertSafeText(value: unknown, path: string, minLength: number, maxLength: number): string {
  if (typeof value !== 'string') {
    fail(`${path} must be a string.`, { path });
  }
  const trimmed = value.trim();
  if (trimmed.length < minLength || trimmed.length > maxLength) {
    fail(`${path} must be ${minLength}-${maxLength} characters.`, { path, minLength, maxLength });
  }
  if (!SAFE_TEXT.test(trimmed)) {
    fail(`${path} contains unsupported characters.`, { path });
  }
  return trimmed;
}

function assertHexColor(value: unknown, path: string): string {
  if (typeof value !== 'string' || !HEX_COLOR.test(value.trim())) {
    fail(`${path} must be a #RGB or #RRGGBB hex color.`, { path });
  }
  return value.trim().toLowerCase();
}

function assertFiniteNumber(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${path} must be a finite number.`, { path });
  }
  if (value < min || value > max) {
    fail(`${path} must be between ${min} and ${max}.`, { path, min, max, value });
  }
  return value;
}

function assertStringArray(value: unknown, path: string, minItems: number, maxItems: number, itemMax: number): string[] {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array of strings.`, { path });
  }
  if (value.length < minItems || value.length > maxItems) {
    fail(`${path} must have ${minItems}-${maxItems} items.`, { path, minItems, maxItems });
  }
  return value.map((entry, index) => assertSafeText(entry, `${path}[${index}]`, 1, itemMax));
}

function assertNumberArray(value: unknown, path: string, minItems: number, maxItems: number, min: number, max: number): number[] {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array of numbers.`, { path });
  }
  if (value.length < minItems || value.length > maxItems) {
    fail(`${path} must have ${minItems}-${maxItems} items.`, { path, minItems, maxItems });
  }
  return value.map((entry, index) => assertFiniteNumber(entry, `${path}[${index}]`, min, max));
}

function assertColorArray(value: unknown, path: string, minItems: number, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array of hex colors.`, { path });
  }
  if (value.length < minItems || value.length > maxItems) {
    fail(`${path} must have ${minItems}-${maxItems} items.`, { path, minItems, maxItems });
  }
  return value.map((entry, index) => assertHexColor(entry, `${path}[${index}]`));
}

function mergeParams(defaults: Record<string, unknown>, raw: unknown): Record<string, unknown> {
  if (raw === undefined) {
    return { ...defaults };
  }
  if (!isPlainObject(raw)) {
    fail('params must be an object.', { path: 'params' });
  }
  const keys = Object.keys(raw);
  if (keys.length > MAX_PARAM_OBJECT_KEYS) {
    fail('params has too many fields.', { path: 'params', maxKeys: MAX_PARAM_OBJECT_KEYS });
  }
  return { ...defaults, ...raw };
}

function validateNorthwindChart(merged: Record<string, unknown>): NorthwindChartParams {
  assertNoUnknownKeys(merged, ['title', 'subtitle', 'labels', 'values', 'colors', 'background', 'holdSeconds'], 'params');
  const labels = assertStringArray(merged.labels, 'params.labels', 2, 8, 12);
  const values = assertNumberArray(merged.values, 'params.values', 2, 8, 0, 10_000);
  const colors = assertColorArray(merged.colors, 'params.colors', 2, 8);
  if (labels.length !== values.length || values.length !== colors.length) {
    fail('params.labels, params.values, and params.colors must have the same length.', {
      labels: labels.length,
      values: values.length,
      colors: colors.length
    });
  }
  return {
    title: assertSafeText(merged.title, 'params.title', 1, 80),
    subtitle: assertSafeText(merged.subtitle, 'params.subtitle', 1, 120),
    labels,
    values,
    colors,
    background: assertHexColor(merged.background, 'params.background'),
    holdSeconds: assertFiniteNumber(merged.holdSeconds, 'params.holdSeconds', 0, 10)
  };
}

function validateNixOverlay(merged: Record<string, unknown>): NixOverlayParams {
  assertNoUnknownKeys(merged, ['badge', 'bodyColor', 'headColor', 'badgeColor'], 'params');
  return {
    badge: assertSafeText(merged.badge, 'params.badge', 1, 8),
    bodyColor: assertHexColor(merged.bodyColor, 'params.bodyColor'),
    headColor: assertHexColor(merged.headColor, 'params.headColor'),
    badgeColor: assertHexColor(merged.badgeColor, 'params.badgeColor')
  };
}

export function requireAnimationTemplate(templateId: unknown): AnimationTemplateDefinition {
  if (typeof templateId !== 'string' || !templateId.trim()) {
    throw new AnimationError('animation.params.invalid', 'templateId is required.', { path: 'templateId' });
  }
  const template = getAnimationTemplate(templateId.trim());
  if (!template) {
    throw new AnimationError('animation.template.notFound', `Unknown animation template: ${templateId}.`, {
      templateId,
      knownIds: ['northwind_arr_chart', 'nix_overlay']
    });
  }
  return template;
}

export function validateAnimationParams(
  templateId: AnimationTemplateId,
  rawParams: unknown
): AnimationTemplateParams {
  const template = requireAnimationTemplate(templateId);
  const merged = mergeParams(template.defaults, rawParams);
  if (template.id === 'northwind_arr_chart') {
    return validateNorthwindChart(merged);
  }
  return validateNixOverlay(merged);
}

export function validateAnimationDestination(value: unknown): AnimationDestination {
  if (value !== 'bigscreen' && value !== 'overlay') {
    throw new AnimationError('animation.destination.unsupported', 'destination must be bigscreen or overlay.', {
      destination: value
    });
  }
  return value;
}

function validateRect(value: unknown, path: string): AnimationAttachRect {
  if (!isPlainObject(value)) {
    fail(`${path} must be an object with x, y, width, and height.`, { path });
  }
  assertNoUnknownKeys(value, ['x', 'y', 'width', 'height'], path);
  const x = assertFiniteNumber(value.x, `${path}.x`, -1920, 3840);
  const y = assertFiniteNumber(value.y, `${path}.y`, -1080, 2160);
  const width = assertFiniteNumber(value.width, `${path}.width`, 1, 1920);
  const height = assertFiniteNumber(value.height, `${path}.height`, 1, 1080);
  return { x, y, width, height };
}

function validatePosition(value: unknown): AnimationAttachPosition {
  if (!isPlainObject(value)) {
    fail('position must be an object with x and y.', { path: 'position' });
  }
  assertNoUnknownKeys(value, ['x', 'y'], 'position');
  return {
    x: assertFiniteNumber(value.x, 'position.x', -1920, 3840),
    y: assertFiniteNumber(value.y, 'position.y', -1080, 2160)
  };
}

export function validateAnimationAttachInput(raw: unknown): AnimationAttachInput {
  if (!isPlainObject(raw)) {
    fail('Attach payload must be an object.');
  }
  assertNoUnknownKeys(
    raw,
    ['projectId', 'sceneId', 'assetId', 'destination', 'startSeconds', 'durationSeconds', 'scale', 'position', 'rect'],
    'attach'
  );

  const projectId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
  const sceneId = typeof raw.sceneId === 'string' ? raw.sceneId.trim() : '';
  const assetId = typeof raw.assetId === 'string' ? raw.assetId.trim() : '';
  if (!projectId) {
    fail('projectId is required.', { path: 'projectId' });
  }
  if (!sceneId) {
    fail('sceneId is required.', { path: 'sceneId' });
  }
  if (!assetId) {
    fail('assetId is required.', { path: 'assetId' });
  }

  const destination = validateAnimationDestination(raw.destination);
  const startSeconds = raw.startSeconds === undefined
    ? undefined
    : assertFiniteNumber(raw.startSeconds, 'startSeconds', 0, 600);
  const durationSeconds = raw.durationSeconds === undefined
    ? undefined
    : assertFiniteNumber(raw.durationSeconds, 'durationSeconds', 0.04, 600);
  const scale = raw.scale === undefined ? undefined : assertFiniteNumber(raw.scale, 'scale', 0.05, 2);
  const position = raw.position === undefined ? undefined : validatePosition(raw.position);
  const rect = raw.rect === undefined ? undefined : validateRect(raw.rect, 'rect');

  return {
    projectId,
    sceneId,
    assetId,
    destination,
    startSeconds,
    durationSeconds,
    scale,
    position,
    rect
  };
}

export function validateAnimationRenderInput(raw: unknown): {
  projectId: string;
  templateId: AnimationTemplateId;
  params: AnimationTemplateParams;
} {
  if (!isPlainObject(raw)) {
    fail('Render payload must be an object.');
  }
  assertNoUnknownKeys(raw, ['projectId', 'templateId', 'params'], 'render');
  const projectId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
  if (!projectId) {
    fail('projectId is required.', { path: 'projectId' });
  }
  const template = requireAnimationTemplate(raw.templateId);
  return {
    projectId,
    templateId: template.id,
    params: validateAnimationParams(template.id, raw.params)
  };
}
