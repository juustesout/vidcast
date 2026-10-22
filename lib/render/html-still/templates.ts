import type {
  HtmlCalloutSide,
  HtmlChartPoint,
  HtmlChartTemplateData,
  HtmlComparisonItem,
  HtmlComparisonTemplateData,
  HtmlDecisionBranch,
  HtmlDecisionNode,
  HtmlDecisionNodeKind,
  HtmlDecisionTreeTemplateData,
  HtmlFeatureCallout,
  HtmlFeatureCalloutsTemplateData,
  HtmlFlowDiagramTemplateData,
  HtmlFlowLink,
  HtmlFlowStep,
  HtmlHeadlineTemplateData,
  HtmlLocationCardTemplateData,
  HtmlProductCardTemplateData,
  HtmlProductComparisonItem,
  HtmlProductComparisonTemplateData,
  HtmlProductFeature,
  HtmlRouteLink,
  HtmlRouteLocation,
  HtmlRouteMapTemplateData,
  HtmlStatCardTemplateData,
  HtmlStillTemplateType,
  HtmlStillTrendDirection,
  HtmlSystemComponent,
  HtmlSystemDiagramTemplateData,
  HtmlSystemLink,
  HtmlTimelineEvent,
  HtmlTimelineTemplateData
} from '@/lib/types/scene';
import { HtmlStillError } from './errors';
import { escapeHtml } from './sanitize';

export const HTML_STILL_CANONICAL_TEMPLATE_IDS = ['headline', 'stat_card', 'comparison', 'chart', 'timeline', 'location_card', 'route_map', 'product_card', 'product_comparison', 'feature_callouts', 'flow_diagram', 'decision_tree', 'system_diagram'] as const;
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
  DATE: 24,
  PLACE: 48,
  REGION: 48,
  LOCATION_ID: 24,
  MIN_ROUTE_LOCATIONS: 2,
  MAX_ROUTE_LOCATIONS: 6,
  MIN_ROUTE_LINKS: 1,
  MAX_ROUTE_LINKS: 8,
  PRODUCT_NAME: 48,
  CURRENCY: 8,
  MAX_PRICE: 1_000_000,
  MIN_PRODUCT_FEATURES: 0,
  MAX_PRODUCT_FEATURES: 6,
  MIN_PRODUCTS: 2,
  MAX_PRODUCTS: 4,
  MIN_CALLOUTS: 1,
  MAX_CALLOUTS: 4,
  NODE_ID: 24,
  BRANCH_LABEL: 24,
  ROLE: 32,
  MIN_FLOW_STEPS: 2,
  MAX_FLOW_STEPS: 8,
  MIN_FLOW_LINKS: 1,
  MAX_FLOW_LINKS: 8,
  MIN_DECISION_NODES: 2,
  MAX_DECISION_NODES: 8,
  MIN_DECISION_BRANCHES: 1,
  MAX_DECISION_BRANCHES: 8,
  MAX_DECISION_OUT_DEGREE: 3,
  MIN_SYSTEM_COMPONENTS: 2,
  MAX_SYSTEM_COMPONENTS: 6,
  MIN_SYSTEM_LINKS: 1,
  MAX_SYSTEM_LINKS: 8
} as const;

const TEMPLATE_ALIASES: Record<string, HtmlStillCanonicalTemplateId> = {
  headline: 'headline',
  headline_card: 'headline',
  stat_card: 'stat_card',
  'stat-card': 'stat_card',
  comparison: 'comparison',
  comparison_card: 'comparison',
  chart: 'chart',
  timeline: 'timeline',
  location_card: 'location_card',
  route_map: 'route_map',
  product_card: 'product_card',
  product_comparison: 'product_comparison',
  feature_callouts: 'feature_callouts',
  flow_diagram: 'flow_diagram',
  decision_tree: 'decision_tree',
  system_diagram: 'system_diagram'
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

function requireCoordinate(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HtmlStillError('html.template.data.invalid', `${field} must be a finite number.`);
  }
  if (value < min || value > max) {
    throw new HtmlStillError('html.template.data.invalid', `${field} must be between ${min} and ${max}.`);
  }
  return value;
}

function optionalCoordinate(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return requireCoordinate(value, field, min, max);
}

function optionalLatLon(data: Record<string, unknown>, prefix: string): { lat?: number; lon?: number } {
  const lat = optionalCoordinate(data.lat, `${prefix}lat`, -90, 90);
  const lon = optionalCoordinate(data.lon, `${prefix}lon`, -180, 180);
  if ((lat === undefined) !== (lon === undefined)) {
    throw new HtmlStillError('html.template.data.invalid', `${prefix}lat and lon must both be set or both omitted.`);
  }
  return lat === undefined || lon === undefined ? {} : { lat, lon };
}

function requireLocationId(value: unknown, field: string): string {
  const id = requireText(value, field, HTML_STILL_TEXT_LIMITS.LOCATION_ID);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
    throw new HtmlStillError('html.template.data.invalid', `${field} must start with a letter and contain only letters, digits, _ or -.`);
  }
  return id;
}

export function parseLocationCardTemplateData(data: Record<string, unknown>): HtmlLocationCardTemplateData {
  return {
    place: requireText(data.place, 'place', HTML_STILL_TEXT_LIMITS.PLACE),
    region: optionalText(data.region, 'region', HTML_STILL_TEXT_LIMITS.REGION),
    detail: optionalText(data.detail, 'detail', HTML_STILL_TEXT_LIMITS.LINE),
    ...optionalLatLon(data, ''),
    background: optionalHex(data.background, 'background'),
    accent: optionalHex(data.accent, 'accent'),
    textColor: optionalHex(data.textColor, 'textColor')
  };
}

function parseRouteLocation(value: unknown, index: number): HtmlRouteLocation {
  const location = assertPlainObject(value, `locations[${index}]`);
  return {
    id: requireLocationId(location.id, `locations[${index}].id`),
    label: requireText(location.label, `locations[${index}].label`, HTML_STILL_TEXT_LIMITS.PLACE),
    ...optionalLatLon(location, `locations[${index}].`)
  };
}

function parseRouteLink(value: unknown, index: number): HtmlRouteLink {
  const link = assertPlainObject(value, `links[${index}]`);
  const from = requireLocationId(link.from, `links[${index}].from`);
  const to = requireLocationId(link.to, `links[${index}].to`);
  if (from === to) {
    throw new HtmlStillError('html.template.data.invalid', `links[${index}] cannot connect a location to itself.`);
  }
  return { from, to };
}

export function parseRouteMapTemplateData(data: Record<string, unknown>): HtmlRouteMapTemplateData {
  if (!Array.isArray(data.locations)) {
    throw new HtmlStillError('html.template.data.invalid', 'locations must be an array.');
  }
  if (data.locations.length < HTML_STILL_TEXT_LIMITS.MIN_ROUTE_LOCATIONS || data.locations.length > HTML_STILL_TEXT_LIMITS.MAX_ROUTE_LOCATIONS) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `route_map requires ${HTML_STILL_TEXT_LIMITS.MIN_ROUTE_LOCATIONS}-${HTML_STILL_TEXT_LIMITS.MAX_ROUTE_LOCATIONS} locations.`
    );
  }
  if (!Array.isArray(data.links)) {
    throw new HtmlStillError('html.template.data.invalid', 'links must be an array.');
  }
  if (data.links.length < HTML_STILL_TEXT_LIMITS.MIN_ROUTE_LINKS || data.links.length > HTML_STILL_TEXT_LIMITS.MAX_ROUTE_LINKS) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `route_map requires ${HTML_STILL_TEXT_LIMITS.MIN_ROUTE_LINKS}-${HTML_STILL_TEXT_LIMITS.MAX_ROUTE_LINKS} links.`
    );
  }
  const locations = data.locations.map((location, index) => parseRouteLocation(location, index));
  const seen = new Set<string>();
  for (const location of locations) {
    if (seen.has(location.id)) {
      throw new HtmlStillError('html.template.data.invalid', `duplicate location id: ${location.id}.`);
    }
    seen.add(location.id);
  }
  const links = data.links.map((link, index) => parseRouteLink(link, index));
  const ids = new Set(locations.map((location) => location.id));
  for (const [index, link] of links.entries()) {
    if (!ids.has(link.from) || !ids.has(link.to)) {
      throw new HtmlStillError('html.template.data.invalid', `links[${index}] references an unknown location id.`);
    }
  }
  return {
    title: requireText(data.title, 'title', HTML_STILL_TEXT_LIMITS.TITLE),
    locations,
    links,
    background: optionalHex(data.background, 'background'),
    accent: optionalHex(data.accent, 'accent'),
    textColor: optionalHex(data.textColor, 'textColor')
  };
}

function parseProductFeature(value: unknown, index: number): HtmlProductFeature {
  const feature = assertPlainObject(value, `features[${index}]`);
  return {
    label: requireText(feature.label, `features[${index}].label`, HTML_STILL_TEXT_LIMITS.FEATURE),
    value: requireText(feature.value, `features[${index}].value`, HTML_STILL_TEXT_LIMITS.FEATURE)
  };
}

function parseProductFeatures(value: unknown, required: boolean): HtmlProductFeature[] {
  if (value === undefined || value === null) {
    if (required) {
      throw new HtmlStillError('html.template.data.invalid', 'features must be an array.');
    }
    return [];
  }
  if (!Array.isArray(value)) {
    throw new HtmlStillError('html.template.data.invalid', 'features must be an array.');
  }
  if (value.length > HTML_STILL_TEXT_LIMITS.MAX_PRODUCT_FEATURES) {
    throw new HtmlStillError('html.template.data.invalid', `features supports at most ${HTML_STILL_TEXT_LIMITS.MAX_PRODUCT_FEATURES} items.`);
  }
  if (required && value.length < HTML_STILL_TEXT_LIMITS.MIN_FEATURES) {
    throw new HtmlStillError('html.template.data.invalid', `features requires at least ${HTML_STILL_TEXT_LIMITS.MIN_FEATURES} item.`);
  }
  return value.map((feature, index) => parseProductFeature(feature, index));
}

function optionalPrice(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > HTML_STILL_TEXT_LIMITS.MAX_PRICE) {
    throw new HtmlStillError('html.template.data.invalid', `price must be a finite number between 0 and ${HTML_STILL_TEXT_LIMITS.MAX_PRICE}.`);
  }
  return value;
}

export function parseProductCardTemplateData(data: Record<string, unknown>): HtmlProductCardTemplateData {
  const features = parseProductFeatures(data.features, false);
  const price = optionalPrice(data.price);
  const currency = optionalText(data.currency, 'currency', HTML_STILL_TEXT_LIMITS.CURRENCY);
  if (currency && price === undefined) {
    throw new HtmlStillError('html.template.data.invalid', 'currency requires price.');
  }
  return {
    name: requireText(data.name, 'name', HTML_STILL_TEXT_LIMITS.PRODUCT_NAME),
    subtitle: optionalText(data.subtitle, 'subtitle', HTML_STILL_TEXT_LIMITS.LINE),
    description: optionalText(data.description, 'description', HTML_STILL_TEXT_LIMITS.LINE),
    price,
    currency,
    features: features.length > 0 ? features : undefined,
    imageAssetId: optionalAssetId(data.imageAssetId, 'imageAssetId'),
    background: optionalHex(data.background, 'background'),
    accent: optionalHex(data.accent, 'accent'),
    textColor: optionalHex(data.textColor, 'textColor')
  };
}

function parseProductComparisonItem(value: unknown, index: number): HtmlProductComparisonItem {
  const product = assertPlainObject(value, `products[${index}]`);
  return {
    name: requireText(product.name, `products[${index}].name`, HTML_STILL_TEXT_LIMITS.PRODUCT_NAME),
    imageAssetId: optionalAssetId(product.imageAssetId, `products[${index}].imageAssetId`),
    features: parseProductFeatures(product.features, true)
  };
}

export function parseProductComparisonTemplateData(data: Record<string, unknown>): HtmlProductComparisonTemplateData {
  if (!Array.isArray(data.products)) {
    throw new HtmlStillError('html.template.data.invalid', 'products must be an array.');
  }
  if (data.products.length < HTML_STILL_TEXT_LIMITS.MIN_PRODUCTS || data.products.length > HTML_STILL_TEXT_LIMITS.MAX_PRODUCTS) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `product_comparison requires ${HTML_STILL_TEXT_LIMITS.MIN_PRODUCTS}-${HTML_STILL_TEXT_LIMITS.MAX_PRODUCTS} products.`
    );
  }
  const products = data.products.map((product, index) => parseProductComparisonItem(product, index));
  const featureCount = products[0].features.length;
  if (products.some((product) => product.features.length !== featureCount)) {
    throw new HtmlStillError('html.template.data.invalid', 'product_comparison items must share the same number of features.');
  }
  const labels = products[0].features.map((feature) => feature.label);
  if (products.some((product) => product.features.some((feature, index) => feature.label !== labels[index]))) {
    throw new HtmlStillError('html.template.data.invalid', 'product_comparison items must share the same feature labels in the same order.');
  }
  return {
    title: requireText(data.title, 'title', HTML_STILL_TEXT_LIMITS.TITLE),
    products,
    background: optionalHex(data.background, 'background'),
    accent: optionalHex(data.accent, 'accent'),
    textColor: optionalHex(data.textColor, 'textColor')
  };
}

function optionalCalloutSide(value: unknown, field: string): HtmlCalloutSide | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value !== 'left' && value !== 'right') {
    throw new HtmlStillError('html.template.data.invalid', `${field} must be left or right.`);
  }
  return value;
}

function parseFeatureCallout(value: unknown, index: number): HtmlFeatureCallout {
  const callout = assertPlainObject(value, `callouts[${index}]`);
  return {
    label: requireText(callout.label, `callouts[${index}].label`, HTML_STILL_TEXT_LIMITS.FEATURE),
    detail: requireText(callout.detail, `callouts[${index}].detail`, HTML_STILL_TEXT_LIMITS.LINE),
    side: optionalCalloutSide(callout.side, `callouts[${index}].side`)
  };
}

export function parseFeatureCalloutsTemplateData(data: Record<string, unknown>): HtmlFeatureCalloutsTemplateData {
  if (!Array.isArray(data.callouts)) {
    throw new HtmlStillError('html.template.data.invalid', 'callouts must be an array.');
  }
  if (data.callouts.length < HTML_STILL_TEXT_LIMITS.MIN_CALLOUTS || data.callouts.length > HTML_STILL_TEXT_LIMITS.MAX_CALLOUTS) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `feature_callouts requires ${HTML_STILL_TEXT_LIMITS.MIN_CALLOUTS}-${HTML_STILL_TEXT_LIMITS.MAX_CALLOUTS} callouts.`
    );
  }
  return {
    name: requireText(data.name, 'name', HTML_STILL_TEXT_LIMITS.PRODUCT_NAME),
    imageAssetId: optionalAssetId(data.imageAssetId, 'imageAssetId'),
    callouts: data.callouts.map((callout, index) => parseFeatureCallout(callout, index)),
    background: optionalHex(data.background, 'background'),
    accent: optionalHex(data.accent, 'accent'),
    textColor: optionalHex(data.textColor, 'textColor')
  };
}

function requireNodeId(value: unknown, field: string): string {
  const id = requireText(value, field, HTML_STILL_TEXT_LIMITS.NODE_ID);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
    throw new HtmlStillError('html.template.data.invalid', `${field} must start with a letter and contain only letters, digits, _ or -.`);
  }
  return id;
}

function assertUniqueIds(ids: string[], label: string): Set<string> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new HtmlStillError('html.template.data.invalid', `duplicate ${label} id: ${id}.`);
    }
    seen.add(id);
  }
  return seen;
}

function assertNoCycle(ids: string[], edges: Array<{ from: string; to: string }>, label: string): void {
  const outgoing = new Map<string, string[]>();
  for (const id of ids) {
    outgoing.set(id, []);
  }
  for (const edge of edges) {
    outgoing.get(edge.from)?.push(edge.to);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new HtmlStillError('html.template.data.invalid', `${label} cannot contain a cycle.`);
    }
    visiting.add(id);
    for (const next of outgoing.get(id) ?? []) {
      walk(next);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) {
    walk(id);
  }
}

function parseFlowStep(value: unknown, index: number): HtmlFlowStep {
  const step = assertPlainObject(value, `steps[${index}]`);
  return {
    id: requireNodeId(step.id, `steps[${index}].id`),
    label: requireText(step.label, `steps[${index}].label`, HTML_STILL_TEXT_LIMITS.FEATURE),
    detail: optionalText(step.detail, `steps[${index}].detail`, HTML_STILL_TEXT_LIMITS.LINE)
  };
}

function parseDirectedLink(value: unknown, index: number, field: string): HtmlFlowLink {
  const link = assertPlainObject(value, `${field}[${index}]`);
  const from = requireNodeId(link.from, `${field}[${index}].from`);
  const to = requireNodeId(link.to, `${field}[${index}].to`);
  if (from === to) {
    throw new HtmlStillError('html.template.data.invalid', `${field}[${index}] cannot connect a node to itself.`);
  }
  return { from, to };
}

export function parseFlowDiagramTemplateData(data: Record<string, unknown>): HtmlFlowDiagramTemplateData {
  if (!Array.isArray(data.steps)) {
    throw new HtmlStillError('html.template.data.invalid', 'steps must be an array.');
  }
  if (data.steps.length < HTML_STILL_TEXT_LIMITS.MIN_FLOW_STEPS || data.steps.length > HTML_STILL_TEXT_LIMITS.MAX_FLOW_STEPS) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `flow_diagram requires ${HTML_STILL_TEXT_LIMITS.MIN_FLOW_STEPS}-${HTML_STILL_TEXT_LIMITS.MAX_FLOW_STEPS} steps.`
    );
  }
  if (!Array.isArray(data.links)) {
    throw new HtmlStillError('html.template.data.invalid', 'links must be an array.');
  }
  if (data.links.length < HTML_STILL_TEXT_LIMITS.MIN_FLOW_LINKS || data.links.length > HTML_STILL_TEXT_LIMITS.MAX_FLOW_LINKS) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `flow_diagram requires ${HTML_STILL_TEXT_LIMITS.MIN_FLOW_LINKS}-${HTML_STILL_TEXT_LIMITS.MAX_FLOW_LINKS} links.`
    );
  }
  const steps = data.steps.map((step, index) => parseFlowStep(step, index));
  const ids = assertUniqueIds(steps.map((step) => step.id), 'step');
  const links = data.links.map((link, index) => parseDirectedLink(link, index, 'links'));
  for (const [index, link] of links.entries()) {
    if (!ids.has(link.from) || !ids.has(link.to)) {
      throw new HtmlStillError('html.template.data.invalid', `links[${index}] references an unknown step id.`);
    }
  }
  assertNoCycle(steps.map((step) => step.id), links, 'flow_diagram');
  return {
    title: requireText(data.title, 'title', HTML_STILL_TEXT_LIMITS.TITLE),
    steps,
    links,
    background: optionalHex(data.background, 'background'),
    accent: optionalHex(data.accent, 'accent'),
    textColor: optionalHex(data.textColor, 'textColor')
  };
}

function optionalDecisionKind(value: unknown, field: string): HtmlDecisionNodeKind {
  if (value !== 'question' && value !== 'outcome') {
    throw new HtmlStillError('html.template.data.invalid', `${field} must be question or outcome.`);
  }
  return value;
}

function parseDecisionNode(value: unknown, index: number): HtmlDecisionNode {
  const node = assertPlainObject(value, `nodes[${index}]`);
  return {
    id: requireNodeId(node.id, `nodes[${index}].id`),
    kind: optionalDecisionKind(node.kind, `nodes[${index}].kind`),
    label: requireText(node.label, `nodes[${index}].label`, HTML_STILL_TEXT_LIMITS.FEATURE)
  };
}

function parseDecisionBranch(value: unknown, index: number): HtmlDecisionBranch {
  const branch = assertPlainObject(value, `branches[${index}]`);
  const from = requireNodeId(branch.from, `branches[${index}].from`);
  const to = requireNodeId(branch.to, `branches[${index}].to`);
  if (from === to) {
    throw new HtmlStillError('html.template.data.invalid', `branches[${index}] cannot connect a node to itself.`);
  }
  return {
    from,
    to,
    label: optionalText(branch.label, `branches[${index}].label`, HTML_STILL_TEXT_LIMITS.BRANCH_LABEL)
  };
}

export function parseDecisionTreeTemplateData(data: Record<string, unknown>): HtmlDecisionTreeTemplateData {
  if (!Array.isArray(data.nodes)) {
    throw new HtmlStillError('html.template.data.invalid', 'nodes must be an array.');
  }
  if (data.nodes.length < HTML_STILL_TEXT_LIMITS.MIN_DECISION_NODES || data.nodes.length > HTML_STILL_TEXT_LIMITS.MAX_DECISION_NODES) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `decision_tree requires ${HTML_STILL_TEXT_LIMITS.MIN_DECISION_NODES}-${HTML_STILL_TEXT_LIMITS.MAX_DECISION_NODES} nodes.`
    );
  }
  if (!Array.isArray(data.branches)) {
    throw new HtmlStillError('html.template.data.invalid', 'branches must be an array.');
  }
  if (data.branches.length < HTML_STILL_TEXT_LIMITS.MIN_DECISION_BRANCHES || data.branches.length > HTML_STILL_TEXT_LIMITS.MAX_DECISION_BRANCHES) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `decision_tree requires ${HTML_STILL_TEXT_LIMITS.MIN_DECISION_BRANCHES}-${HTML_STILL_TEXT_LIMITS.MAX_DECISION_BRANCHES} branches.`
    );
  }
  const nodes = data.nodes.map((node, index) => parseDecisionNode(node, index));
  const ids = assertUniqueIds(nodes.map((node) => node.id), 'node');
  if (!nodes.some((node) => node.kind === 'question')) {
    throw new HtmlStillError('html.template.data.invalid', 'decision_tree requires at least one question node.');
  }
  if (!nodes.some((node) => node.kind === 'outcome')) {
    throw new HtmlStillError('html.template.data.invalid', 'decision_tree requires at least one outcome node.');
  }
  const branches = data.branches.map((branch, index) => parseDecisionBranch(branch, index));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const outDegree = new Map<string, number>();
  for (const [index, branch] of branches.entries()) {
    if (!ids.has(branch.from) || !ids.has(branch.to)) {
      throw new HtmlStillError('html.template.data.invalid', `branches[${index}] references an unknown node id.`);
    }
    const from = byId.get(branch.from);
    const to = byId.get(branch.to);
    if (from?.kind !== 'question') {
      throw new HtmlStillError('html.template.data.invalid', `branches[${index}] must start from a question node.`);
    }
    if (!to) {
      throw new HtmlStillError('html.template.data.invalid', `branches[${index}] references an unknown node id.`);
    }
    const next = (outDegree.get(branch.from) ?? 0) + 1;
    if (next > HTML_STILL_TEXT_LIMITS.MAX_DECISION_OUT_DEGREE) {
      throw new HtmlStillError('html.template.data.invalid', `question nodes may have at most ${HTML_STILL_TEXT_LIMITS.MAX_DECISION_OUT_DEGREE} branches.`);
    }
    outDegree.set(branch.from, next);
  }
  for (const node of nodes) {
    if (node.kind === 'question' && (outDegree.get(node.id) ?? 0) < 1) {
      throw new HtmlStillError('html.template.data.invalid', `question node ${node.id} must have at least one branch.`);
    }
    if (node.kind === 'outcome' && (outDegree.get(node.id) ?? 0) > 0) {
      throw new HtmlStillError('html.template.data.invalid', `outcome node ${node.id} cannot have outgoing branches.`);
    }
  }
  assertNoCycle(nodes.map((node) => node.id), branches, 'decision_tree');
  return {
    title: requireText(data.title, 'title', HTML_STILL_TEXT_LIMITS.TITLE),
    nodes,
    branches,
    background: optionalHex(data.background, 'background'),
    accent: optionalHex(data.accent, 'accent'),
    textColor: optionalHex(data.textColor, 'textColor')
  };
}

function parseSystemComponent(value: unknown, index: number): HtmlSystemComponent {
  const component = assertPlainObject(value, `components[${index}]`);
  return {
    id: requireNodeId(component.id, `components[${index}].id`),
    label: requireText(component.label, `components[${index}].label`, HTML_STILL_TEXT_LIMITS.FEATURE),
    role: optionalText(component.role, `components[${index}].role`, HTML_STILL_TEXT_LIMITS.ROLE)
  };
}

function parseSystemLink(value: unknown, index: number): HtmlSystemLink {
  const link = parseDirectedLink(value, index, 'links');
  const raw = assertPlainObject(value, `links[${index}]`);
  return {
    ...link,
    label: optionalText(raw.label, `links[${index}].label`, HTML_STILL_TEXT_LIMITS.BRANCH_LABEL)
  };
}

export function parseSystemDiagramTemplateData(data: Record<string, unknown>): HtmlSystemDiagramTemplateData {
  if (!Array.isArray(data.components)) {
    throw new HtmlStillError('html.template.data.invalid', 'components must be an array.');
  }
  if (data.components.length < HTML_STILL_TEXT_LIMITS.MIN_SYSTEM_COMPONENTS || data.components.length > HTML_STILL_TEXT_LIMITS.MAX_SYSTEM_COMPONENTS) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `system_diagram requires ${HTML_STILL_TEXT_LIMITS.MIN_SYSTEM_COMPONENTS}-${HTML_STILL_TEXT_LIMITS.MAX_SYSTEM_COMPONENTS} components.`
    );
  }
  if (!Array.isArray(data.links)) {
    throw new HtmlStillError('html.template.data.invalid', 'links must be an array.');
  }
  if (data.links.length < HTML_STILL_TEXT_LIMITS.MIN_SYSTEM_LINKS || data.links.length > HTML_STILL_TEXT_LIMITS.MAX_SYSTEM_LINKS) {
    throw new HtmlStillError(
      'html.template.data.invalid',
      `system_diagram requires ${HTML_STILL_TEXT_LIMITS.MIN_SYSTEM_LINKS}-${HTML_STILL_TEXT_LIMITS.MAX_SYSTEM_LINKS} links.`
    );
  }
  const components = data.components.map((component, index) => parseSystemComponent(component, index));
  const ids = assertUniqueIds(components.map((component) => component.id), 'component');
  const links = data.links.map((link, index) => parseSystemLink(link, index));
  for (const [index, link] of links.entries()) {
    if (!ids.has(link.from) || !ids.has(link.to)) {
      throw new HtmlStillError('html.template.data.invalid', `links[${index}] references an unknown component id.`);
    }
  }
  return {
    title: requireText(data.title, 'title', HTML_STILL_TEXT_LIMITS.TITLE),
    components,
    links,
    background: optionalHex(data.background, 'background'),
    accent: optionalHex(data.accent, 'accent'),
    textColor: optionalHex(data.textColor, 'textColor')
  };
}

export type HtmlStillParsedTemplateData =
  | HtmlHeadlineTemplateData
  | HtmlStatCardTemplateData
  | HtmlComparisonTemplateData
  | HtmlChartTemplateData
  | HtmlTimelineTemplateData
  | HtmlLocationCardTemplateData
  | HtmlRouteMapTemplateData
  | HtmlProductCardTemplateData
  | HtmlProductComparisonTemplateData
  | HtmlFeatureCalloutsTemplateData
  | HtmlFlowDiagramTemplateData
  | HtmlDecisionTreeTemplateData
  | HtmlSystemDiagramTemplateData;

export function collectHtmlStillImageAssetIds(data: HtmlStillParsedTemplateData): string[] {
  const ids: string[] = [];
  if ('imageAssetId' in data && typeof data.imageAssetId === 'string') {
    ids.push(data.imageAssetId);
  }
  if ('products' in data && Array.isArray(data.products)) {
    for (const product of data.products) {
      if (product.imageAssetId) {
        ids.push(product.imageAssetId);
      }
    }
  }
  return ids;
}

export function parseHtmlStillTemplateData(
  templateId: HtmlStillCanonicalTemplateId,
  data: Record<string, unknown>
): HtmlStillParsedTemplateData {
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
  if (templateId === 'timeline') {
    return parseTimelineTemplateData(data);
  }
  if (templateId === 'location_card') {
    return parseLocationCardTemplateData(data);
  }
  if (templateId === 'route_map') {
    return parseRouteMapTemplateData(data);
  }
  if (templateId === 'product_card') {
    return parseProductCardTemplateData(data);
  }
  if (templateId === 'product_comparison') {
    return parseProductComparisonTemplateData(data);
  }
  if (templateId === 'feature_callouts') {
    return parseFeatureCalloutsTemplateData(data);
  }
  if (templateId === 'flow_diagram') {
    return parseFlowDiagramTemplateData(data);
  }
  if (templateId === 'decision_tree') {
    return parseDecisionTreeTemplateData(data);
  }
  return parseSystemDiagramTemplateData(data);
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

function formatCoordinate(value: number): string {
  return value.toFixed(2);
}

export function buildLocationCardMarkup(data: HtmlLocationCardTemplateData): { markup: string; css: string; background: string } {
  const background = hexOr(data.background, '#0f172a');
  const accent = hexOr(data.accent, '#38bdf8');
  const textColor = hexOr(data.textColor, '#f8fafc');
  const hasCoords = data.lat !== undefined && data.lon !== undefined;
  const coords = hasCoords
    ? `<div class="coords">${escapeHtml(formatCoordinate(data.lat as number))} / ${escapeHtml(formatCoordinate(data.lon as number))}</div>`
    : '';
  const pin = `<svg class="pin" viewBox="0 0 120 160" width="180" height="240"><path d="M60 8c-28 0-52 22-52 52 0 38 52 92 52 92s52-54 52-92c0-30-24-52-52-52z" fill="${accent}"/><circle cx="60" cy="58" r="22" fill="#0f172a"/></svg>`;
  return {
    background,
    css: `
.card{box-sizing:border-box;width:100%;height:100%;padding:96px 120px;display:flex;flex-direction:row;align-items:center;gap:80px;font-family:DejaVu Sans,Arial,sans-serif;color:${textColor};}
.mark{flex:0 0 220px;display:flex;align-items:center;justify-content:center;}
.pin{display:block;}
.copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:22px;}
.region{font-size:28px;letter-spacing:0.22em;text-transform:uppercase;color:${accent};font-weight:700;}
.place{font-size:92px;line-height:1.02;font-weight:800;overflow:hidden;max-width:14ch;}
.rule{width:120px;height:8px;background:${accent};border-radius:999px;}
.detail{font-size:34px;line-height:1.35;opacity:0.9;max-width:28ch;overflow:hidden;}
.coords{font-size:28px;letter-spacing:0.08em;opacity:0.78;}
`,
    markup: `<div class="card"><div class="mark">${pin}</div><div class="copy">${data.region ? `<div class="region">${escapeHtml(data.region)}</div>` : ''}<div class="place">${escapeHtml(data.place)}</div><div class="rule"></div>${data.detail ? `<div class="detail">${escapeHtml(data.detail)}</div>` : ''}${coords}</div></div>`
  };
}

function routeHasCompleteCoords(locations: HtmlRouteLocation[]): boolean {
  return locations.every((location) => location.lat !== undefined && location.lon !== undefined);
}

function projectRouteLocations(locations: HtmlRouteLocation[]): Array<{ location: HtmlRouteLocation; x: number; y: number }> {
  const width = 1480;
  const height = 620;
  const pad = 90;
  if (routeHasCompleteCoords(locations)) {
    const lats = locations.map((location) => location.lat as number);
    const lons = locations.map((location) => location.lon as number);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const latSpan = Math.max(0.0001, maxLat - minLat);
    const lonSpan = Math.max(0.0001, maxLon - minLon);
    return locations.map((location) => ({
      location,
      x: pad + ((location.lon as number - minLon) / lonSpan) * (width - pad * 2),
      y: pad + ((maxLat - (location.lat as number)) / latSpan) * (height - pad * 2)
    }));
  }
  const count = locations.length;
  return locations.map((location, index) => {
    const t = count === 1 ? 0.5 : index / (count - 1);
    return {
      location,
      x: pad + t * (width - pad * 2),
      y: pad + (0.28 + 0.44 * (index % 2)) * (height - pad * 2)
    };
  });
}

function buildRouteMapSvg(data: HtmlRouteMapTemplateData, accent: string, textColor: string): string {
  const width = 1480;
  const height = 620;
  const projected = projectRouteLocations(data.locations);
  const byId = new Map(projected.map((entry) => [entry.location.id, entry]));
  const grid = `<rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="28" fill="none" stroke="${textColor}" stroke-opacity="0.12" stroke-width="3"/><line x1="80" y1="${height / 2}" x2="${width - 80}" y2="${height / 2}" stroke="${textColor}" stroke-opacity="0.08" stroke-width="2"/><line x1="${width / 2}" y1="80" x2="${width / 2}" y2="${height - 80}" stroke="${textColor}" stroke-opacity="0.08" stroke-width="2"/>`;
  const links = data.links.map((link) => {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    if (!from || !to) {
      return '';
    }
    return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${accent}" stroke-width="10" stroke-linecap="round"/>`;
  }).join('');
  const nodes = projected.map((entry) => `<circle cx="${entry.x}" cy="${entry.y}" r="18" fill="${accent}"/><text x="${entry.x}" y="${entry.y - 32}" text-anchor="middle" fill="${textColor}" font-size="26" font-weight="700" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(entry.location.label)}</text>`).join('');
  return `<svg class="map" viewBox="0 0 ${width} ${height}" width="100%" height="100%">${grid}${links}${nodes}</svg>`;
}

export function buildRouteMapMarkup(data: HtmlRouteMapTemplateData): { markup: string; css: string; background: string } {
  const background = hexOr(data.background, '#082032');
  const accent = hexOr(data.accent, '#fbbf24');
  const textColor = hexOr(data.textColor, '#f8fafc');
  return {
    background,
    css: `
.card{box-sizing:border-box;width:100%;height:100%;padding:72px 96px 56px;display:flex;flex-direction:column;gap:24px;font-family:DejaVu Sans,Arial,sans-serif;color:${textColor};}
.head{display:flex;align-items:baseline;justify-content:space-between;gap:24px;}
.title{font-size:56px;font-weight:800;overflow:hidden;max-width:22ch;}
.note{font-size:22px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.68;}
.rule{width:96px;height:6px;background:${accent};border-radius:999px;}
.plot{flex:1;min-height:0;}
.map{display:block;}
`,
    markup: `<div class="card"><div class="head"><div class="title">${escapeHtml(data.title)}</div><div class="note">Schematic map</div></div><div class="rule"></div><div class="plot">${buildRouteMapSvg(data, accent, textColor)}</div></div>`
  };
}

function formatPrice(value: number, currency?: string): string {
  const amount = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return currency ? `${escapeHtml(currency)} ${amount}` : amount;
}

function productImageBlock(hasImage: boolean): string {
  return hasImage
    ? `<div class="image image-present"><span>Asset</span></div>`
    : `<div class="image image-missing"><span>No image</span></div>`;
}

export function buildProductCardMarkup(data: HtmlProductCardTemplateData): { markup: string; css: string; background: string } {
  const background = hexOr(data.background, '#111827');
  const accent = hexOr(data.accent, '#34d399');
  const textColor = hexOr(data.textColor, '#f8fafc');
  const features = (data.features ?? []).map((feature) => `<li><span>${escapeHtml(feature.label)}</span><strong>${escapeHtml(feature.value)}</strong></li>`).join('');
  return {
    background,
    css: `
.card{box-sizing:border-box;width:100%;height:100%;padding:88px 110px;display:flex;flex-direction:row;align-items:stretch;gap:72px;font-family:DejaVu Sans,Arial,sans-serif;color:${textColor};}
.copy{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:22px;}
.subtitle{font-size:26px;letter-spacing:0.2em;text-transform:uppercase;color:${accent};font-weight:700;}
.name{font-size:84px;line-height:1.02;font-weight:800;overflow:hidden;max-width:14ch;}
.rule{width:120px;height:8px;background:${accent};border-radius:999px;}
.description{font-size:32px;line-height:1.35;opacity:0.9;max-width:28ch;overflow:hidden;}
.price{font-size:48px;font-weight:800;}
.features{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px;}
.features li{display:flex;justify-content:space-between;gap:16px;font-size:28px;}
.features span{opacity:0.76;}
.image{width:460px;flex:0 0 460px;border:4px solid ${accent};border-radius:32px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.18);}
.image span{font-size:24px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.72;}
.image-missing{border-style:dashed;}
`,
    markup: `<div class="card"><div class="copy">${data.subtitle ? `<div class="subtitle">${escapeHtml(data.subtitle)}</div>` : ''}<div class="name">${escapeHtml(data.name)}</div><div class="rule"></div>${data.description ? `<div class="description">${escapeHtml(data.description)}</div>` : ''}${data.price !== undefined ? `<div class="price">${formatPrice(data.price, data.currency)}</div>` : ''}${features ? `<ul class="features">${features}</ul>` : ''}</div>${productImageBlock(Boolean(data.imageAssetId))}</div>`
  };
}

export function buildProductComparisonMarkup(data: HtmlProductComparisonTemplateData): { markup: string; css: string; background: string } {
  const background = hexOr(data.background, '#0b1220');
  const accent = hexOr(data.accent, '#818cf8');
  const textColor = hexOr(data.textColor, '#f8fafc');
  const columns = data.products.map((product) => {
    const features = product.features.map((feature) => `<li><span>${escapeHtml(feature.label)}</span><strong>${escapeHtml(feature.value)}</strong></li>`).join('');
    return `<section class="item">${productImageBlock(Boolean(product.imageAssetId))}<h2>${escapeHtml(product.name)}</h2><ul>${features}</ul></section>`;
  }).join('');
  return {
    background,
    css: `
.card{box-sizing:border-box;width:100%;height:100%;padding:72px 80px;display:flex;flex-direction:column;gap:32px;font-family:DejaVu Sans,Arial,sans-serif;color:${textColor};}
.title{font-size:56px;font-weight:800;overflow:hidden;max-width:24ch;}
.rule{width:96px;height:6px;background:${accent};border-radius:999px;}
.grid{display:flex;gap:24px;flex:1;min-height:0;}
.item{flex:1;min-width:0;background:rgba(15,23,42,0.35);border-radius:28px;padding:28px 24px;display:flex;flex-direction:column;gap:18px;}
.item h2{margin:0;font-size:32px;overflow:hidden;max-width:16ch;}
.item ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px;}
.item li{display:flex;justify-content:space-between;gap:12px;font-size:24px;}
.item span{opacity:0.72;}
.image{height:160px;width:100%;border:3px solid ${accent};border-radius:20px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.18);}
.image span{font-size:18px;letter-spacing:0.16em;text-transform:uppercase;opacity:0.7;}
.image-missing{border-style:dashed;}
`,
    markup: `<div class="card"><div class="title">${escapeHtml(data.title)}</div><div class="rule"></div><div class="grid">${columns}</div></div>`
  };
}

function calloutSide(callout: HtmlFeatureCallout, index: number): HtmlCalloutSide {
  return callout.side ?? (index % 2 === 0 ? 'left' : 'right');
}

function buildFeatureCalloutsSvg(data: HtmlFeatureCalloutsTemplateData, accent: string, textColor: string): string {
  const width = 1480;
  const height = 720;
  const centerX = width / 2;
  const centerY = height / 2;
  const image = `<rect x="${centerX - 210}" y="${centerY - 230}" width="420" height="460" rx="36" fill="none" stroke="${accent}" stroke-width="6"${data.imageAssetId ? '' : ' stroke-dasharray="18 14"'}/><text x="${centerX}" y="${centerY + 8}" text-anchor="middle" fill="${textColor}" font-size="28" font-family="DejaVu Sans,Arial,sans-serif">${data.imageAssetId ? 'Asset' : 'No image'}</text>`;
  const left = data.callouts.map((callout, index) => ({ callout, index })).filter((entry) => calloutSide(entry.callout, entry.index) === 'left');
  const right = data.callouts.map((callout, index) => ({ callout, index })).filter((entry) => calloutSide(entry.callout, entry.index) === 'right');
  const place = (entries: Array<{ callout: HtmlFeatureCallout; index: number }>, side: HtmlCalloutSide) => entries.map((entry, slot) => {
    const y = 140 + slot * Math.min(160, 480 / Math.max(entries.length, 1));
    const x = side === 'left' ? 80 : width - 80;
    const anchor = side === 'left' ? 'start' : 'end';
    const lineX = side === 'left' ? centerX - 210 : centerX + 210;
    const markerX = side === 'left' ? centerX - 170 : centerX + 170;
    return `<line x1="${x + (side === 'left' ? 320 : -320)}" y1="${y + 18}" x2="${lineX}" y2="${y + 18}" stroke="${accent}" stroke-width="4"/><circle cx="${markerX}" cy="${y + 18}" r="10" fill="${accent}"/><text x="${x}" y="${y}" text-anchor="${anchor}" fill="${accent}" font-size="26" font-weight="700" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(entry.callout.label)}</text><text x="${x}" y="${y + 40}" text-anchor="${anchor}" fill="${textColor}" font-size="24" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(entry.callout.detail)}</text>`;
  }).join('');
  return `<svg class="callouts" viewBox="0 0 ${width} ${height}" width="100%" height="100%">${image}${place(left, 'left')}${place(right, 'right')}</svg>`;
}

export function buildFeatureCalloutsMarkup(data: HtmlFeatureCalloutsTemplateData): { markup: string; css: string; background: string } {
  const background = hexOr(data.background, '#0f172a');
  const accent = hexOr(data.accent, '#f472b6');
  const textColor = hexOr(data.textColor, '#f8fafc');
  return {
    background,
    css: `
.card{box-sizing:border-box;width:100%;height:100%;padding:64px 80px 48px;display:flex;flex-direction:column;gap:20px;font-family:DejaVu Sans,Arial,sans-serif;color:${textColor};}
.name{font-size:56px;font-weight:800;overflow:hidden;max-width:22ch;}
.rule{width:96px;height:6px;background:${accent};border-radius:999px;}
.plot{flex:1;min-height:0;}
.callouts{display:block;}
`,
    markup: `<div class="card"><div class="name">${escapeHtml(data.name)}</div><div class="rule"></div><div class="plot">${buildFeatureCalloutsSvg(data, accent, textColor)}</div></div>`
  };
}

function roundCoord(value: number): number {
  return Math.round(value * 10) / 10;
}

function directedEdge(
  from: { x: number; y: number },
  to: { x: number; y: number },
  accent: string,
  halfW: number,
  halfH: number,
  label?: string
): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) {
    return '';
  }
  const ux = dx / len;
  const uy = dy / len;
  const inset = Math.min(halfW / Math.max(Math.abs(ux), 0.001), halfH / Math.max(Math.abs(uy), 0.001));
  const endX = roundCoord(to.x - ux * inset);
  const endY = roundCoord(to.y - uy * inset);
  const startX = roundCoord(from.x);
  const startY = roundCoord(from.y);
  const bx = endX - ux * 16;
  const by = endY - uy * 16;
  const px = -uy * 8;
  const py = ux * 8;
  const head = `<polygon points="${endX},${endY} ${roundCoord(bx + px)},${roundCoord(by + py)} ${roundCoord(bx - px)},${roundCoord(by - py)}" fill="${accent}"/>`;
  const caption = label
    ? `<text x="${roundCoord((startX + endX) / 2)}" y="${roundCoord((startY + endY) / 2 - 10)}" text-anchor="middle" fill="${accent}" font-size="18" font-weight="700" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(label)}</text>`
    : '';
  return `<line x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}" stroke="${accent}" stroke-width="5" stroke-linecap="round"/>${head}${caption}`;
}

function wrapDiagramCard(title: string, note: string, svg: string, background: string, accent: string, textColor: string, className: string): { markup: string; css: string; background: string } {
  return {
    background,
    css: `
.card{box-sizing:border-box;width:100%;height:100%;padding:64px 80px 48px;display:flex;flex-direction:column;gap:20px;font-family:DejaVu Sans,Arial,sans-serif;color:${textColor};}
.head{display:flex;align-items:baseline;justify-content:space-between;gap:24px;}
.title{font-size:52px;font-weight:800;overflow:hidden;max-width:22ch;}
.note{font-size:20px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.68;}
.rule{width:96px;height:6px;background:${accent};border-radius:999px;}
.plot{flex:1;min-height:0;}
.${className}{display:block;}
`,
    markup: `<div class="card"><div class="head"><div class="title">${escapeHtml(title)}</div><div class="note">${escapeHtml(note)}</div></div><div class="rule"></div><div class="plot">${svg}</div></div>`
  };
}

function layoutFlowPositions(count: number, width: number, height: number): Array<{ x: number; y: number }> {
  const padX = 110;
  const padY = 90;
  if (count <= 4) {
    return Array.from({ length: count }, (_, index) => {
      const t = count === 1 ? 0.5 : index / (count - 1);
      return { x: padX + t * (width - padX * 2), y: height / 2 };
    });
  }
  const topCount = Math.ceil(count / 2);
  const bottomCount = count - topCount;
  return Array.from({ length: count }, (_, index) => {
    const onTop = index < topCount;
    const slot = onTop ? index : index - topCount;
    const group = onTop ? topCount : bottomCount;
    const t = group === 1 ? 0.5 : slot / (group - 1);
    return {
      x: padX + t * (width - padX * 2),
      y: onTop ? padY + 70 : height - padY - 70
    };
  });
}

function buildFlowDiagramSvg(data: HtmlFlowDiagramTemplateData, accent: string, textColor: string): string {
  const width = 1480;
  const height = 720;
  const positions = layoutFlowPositions(data.steps.length, width, height);
  const byId = new Map(data.steps.map((step, index) => [step.id, { step, ...positions[index] }]));
  const boxW = 220;
  const boxH = 96;
  const links = data.links.map((link) => {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    if (!from || !to) {
      return '';
    }
    return directedEdge(from, to, accent, boxW / 2, boxH / 2);
  }).join('');
  const nodes = data.steps.map((step) => {
    const point = byId.get(step.id);
    if (!point) {
      return '';
    }
    const detail = step.detail
      ? `<text x="${point.x}" y="${point.y + 22}" text-anchor="middle" fill="${textColor}" font-size="18" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(step.detail)}</text>`
      : '';
    return `<rect x="${point.x - boxW / 2}" y="${point.y - boxH / 2}" width="${boxW}" height="${boxH}" rx="18" fill="rgba(15,23,42,0.35)" stroke="${accent}" stroke-width="4"/><text x="${point.x}" y="${point.y + (step.detail ? -6 : 8)}" text-anchor="middle" fill="${textColor}" font-size="24" font-weight="700" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(step.label)}</text>${detail}`;
  }).join('');
  return `<svg class="flow" viewBox="0 0 ${width} ${height}" width="100%" height="100%">${links}${nodes}</svg>`;
}

export function buildFlowDiagramMarkup(data: HtmlFlowDiagramTemplateData): { markup: string; css: string; background: string } {
  const background = hexOr(data.background, '#0b1220');
  const accent = hexOr(data.accent, '#38bdf8');
  const textColor = hexOr(data.textColor, '#f8fafc');
  return wrapDiagramCard(data.title, 'Process flow', buildFlowDiagramSvg(data, accent, textColor), background, accent, textColor, 'flow');
}

function topologicalLayers(nodes: HtmlDecisionNode[], branches: HtmlDecisionBranch[]): HtmlDecisionNode[][] {
  const remaining = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    remaining.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const branch of branches) {
    outgoing.get(branch.from)?.push(branch.to);
    remaining.set(branch.to, (remaining.get(branch.to) ?? 0) + 1);
  }
  const layers: HtmlDecisionNode[][] = [];
  let frontier = nodes.filter((node) => (remaining.get(node.id) ?? 0) === 0);
  const placed = new Set<string>();
  while (frontier.length > 0) {
    layers.push(frontier);
    const next: HtmlDecisionNode[] = [];
    const seen = new Set<string>();
    for (const node of frontier) {
      placed.add(node.id);
      for (const target of outgoing.get(node.id) ?? []) {
        remaining.set(target, (remaining.get(target) ?? 0) - 1);
        if ((remaining.get(target) ?? 0) === 0 && !placed.has(target) && !seen.has(target)) {
          const found = byId.get(target);
          if (found) {
            seen.add(target);
            next.push(found);
          }
        }
      }
    }
    frontier = next;
  }
  const leftovers = nodes.filter((node) => !placed.has(node.id));
  if (leftovers.length > 0) {
    layers.push(leftovers);
  }
  return layers;
}

function buildDecisionTreeSvg(data: HtmlDecisionTreeTemplateData, accent: string, textColor: string): string {
  const width = 1480;
  const height = 720;
  const layers = topologicalLayers(data.nodes, data.branches);
  const positions = new Map<string, { x: number; y: number; node: HtmlDecisionNode }>();
  const padX = 140;
  const padY = 90;
  layers.forEach((layer, layerIndex) => {
    const y = padY + (layers.length === 1 ? height / 2 - padY : (layerIndex / Math.max(layers.length - 1, 1)) * (height - padY * 2));
    layer.forEach((node, slot) => {
      const t = layer.length === 1 ? 0.5 : slot / (layer.length - 1);
      positions.set(node.id, { node, x: padX + t * (width - padX * 2), y });
    });
  });
  const links = data.branches.map((branch) => {
    const from = positions.get(branch.from);
    const to = positions.get(branch.to);
    if (!from || !to) {
      return '';
    }
    const half = to.node.kind === 'question' ? 54 : 40;
    return directedEdge(from, to, accent, to.node.kind === 'question' ? 118 : 110, half, branch.label);
  }).join('');
  const nodes = data.nodes.map((node) => {
    const point = positions.get(node.id);
    if (!point) {
      return '';
    }
    if (node.kind === 'question') {
      return `<polygon points="${point.x},${point.y - 54} ${point.x + 118},${point.y} ${point.x},${point.y + 54} ${point.x - 118},${point.y}" fill="rgba(15,23,42,0.4)" stroke="${accent}" stroke-width="4"/><text x="${point.x}" y="${point.y + 8}" text-anchor="middle" fill="${textColor}" font-size="22" font-weight="700" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(node.label)}</text>`;
    }
    return `<rect x="${point.x - 110}" y="${point.y - 40}" width="220" height="80" rx="16" fill="rgba(15,23,42,0.4)" stroke="${accent}" stroke-width="4"/><text x="${point.x}" y="${point.y + 8}" text-anchor="middle" fill="${textColor}" font-size="22" font-weight="700" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(node.label)}</text>`;
  }).join('');
  return `<svg class="decision" viewBox="0 0 ${width} ${height}" width="100%" height="100%">${links}${nodes}</svg>`;
}

export function buildDecisionTreeMarkup(data: HtmlDecisionTreeTemplateData): { markup: string; css: string; background: string } {
  const background = hexOr(data.background, '#111827');
  const accent = hexOr(data.accent, '#fbbf24');
  const textColor = hexOr(data.textColor, '#f8fafc');
  return wrapDiagramCard(data.title, 'Decision tree', buildDecisionTreeSvg(data, accent, textColor), background, accent, textColor, 'decision');
}

function layoutSystemPositions(count: number, width: number, height: number): Array<{ x: number; y: number }> {
  const padX = 140;
  const padY = 110;
  if (count <= 3) {
    return Array.from({ length: count }, (_, index) => {
      const t = count === 1 ? 0.5 : index / (count - 1);
      return { x: padX + t * (width - padX * 2), y: height / 2 };
    });
  }
  const cols = count <= 4 ? 2 : 3;
  const rows = Math.ceil(count / cols);
  return Array.from({ length: count }, (_, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const rowCount = Math.min(cols, count - row * cols);
    const t = rowCount === 1 ? 0.5 : col / (rowCount - 1);
    return {
      x: padX + t * (width - padX * 2),
      y: padY + (rows === 1 ? 0 : row / (rows - 1)) * (height - padY * 2)
    };
  });
}

function buildSystemDiagramSvg(data: HtmlSystemDiagramTemplateData, accent: string, textColor: string): string {
  const width = 1480;
  const height = 720;
  const positions = layoutSystemPositions(data.components.length, width, height);
  const byId = new Map(data.components.map((component, index) => [component.id, { component, ...positions[index] }]));
  const links = data.links.map((link) => {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    if (!from || !to) {
      return '';
    }
    return directedEdge(from, to, accent, 130, 48, link.label);
  }).join('');
  const nodes = data.components.map((component) => {
    const point = byId.get(component.id);
    if (!point) {
      return '';
    }
    const role = component.role
      ? `<text x="${point.x}" y="${point.y + 24}" text-anchor="middle" fill="${accent}" font-size="18" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(component.role)}</text>`
      : '';
    return `<rect x="${point.x - 130}" y="${point.y - 48}" width="260" height="96" rx="18" fill="rgba(15,23,42,0.4)" stroke="${accent}" stroke-width="4"/><text x="${point.x}" y="${point.y + (component.role ? -6 : 8)}" text-anchor="middle" fill="${textColor}" font-size="24" font-weight="700" font-family="DejaVu Sans,Arial,sans-serif">${escapeHtml(component.label)}</text>${role}`;
  }).join('');
  return `<svg class="system" viewBox="0 0 ${width} ${height}" width="100%" height="100%">${links}${nodes}</svg>`;
}

export function buildSystemDiagramMarkup(data: HtmlSystemDiagramTemplateData): { markup: string; css: string; background: string } {
  const background = hexOr(data.background, '#082032');
  const accent = hexOr(data.accent, '#34d399');
  const textColor = hexOr(data.textColor, '#f8fafc');
  return wrapDiagramCard(data.title, 'System map', buildSystemDiagramSvg(data, accent, textColor), background, accent, textColor, 'system');
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
  if (canonical === 'timeline') {
    return buildTimelineMarkup(parsed as HtmlTimelineTemplateData);
  }
  if (canonical === 'location_card') {
    return buildLocationCardMarkup(parsed as HtmlLocationCardTemplateData);
  }
  if (canonical === 'route_map') {
    return buildRouteMapMarkup(parsed as HtmlRouteMapTemplateData);
  }
  if (canonical === 'product_card') {
    return buildProductCardMarkup(parsed as HtmlProductCardTemplateData);
  }
  if (canonical === 'product_comparison') {
    return buildProductComparisonMarkup(parsed as HtmlProductComparisonTemplateData);
  }
  if (canonical === 'feature_callouts') {
    return buildFeatureCalloutsMarkup(parsed as HtmlFeatureCalloutsTemplateData);
  }
  if (canonical === 'flow_diagram') {
    return buildFlowDiagramMarkup(parsed as HtmlFlowDiagramTemplateData);
  }
  if (canonical === 'decision_tree') {
    return buildDecisionTreeMarkup(parsed as HtmlDecisionTreeTemplateData);
  }
  return buildSystemDiagramMarkup(parsed as HtmlSystemDiagramTemplateData);
}
