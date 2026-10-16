// Stock image provider domain types (P27).
//
// A stock selection is a first-class author intent: instead of paying for a new
// AI image, a scene can request a royalty-free photo from a stock provider. The
// provider-specific usage terms (hotlinking vs. download-to-server) are captured
// on the normalized photo so downstream code can honour them explicitly.

export type StockProviderId = 'unsplash' | 'pexels' | 'pixabay' | 'fake';

// `download`  -> the provider permits copying the asset onto our server; we may
//                persist a durable project asset and render from it.
// `hotlink`   -> the provider requires its CDN URL to be used directly; we must
//                not store a durable copy. The bytes are fetched only into the
//                transient per-render workspace.
export type StockUsagePolicy = 'download' | 'hotlink';

export type StockOrientation = 'landscape' | 'portrait' | 'squarish';

export interface StockAttribution {
  provider: StockProviderId;
  providerName: string;
  photoId: string;
  photographerName: string;
  photographerUrl?: string;
  // Canonical page for the photo, used for the required "credit + link" back.
  sourceUrl: string;
  license: string;
}

export interface StockPhoto {
  provider: StockProviderId;
  photoId: string;
  width: number;
  height: number;
  // URL to use for display/render. For `hotlink` providers this is the CDN URL
  // that must be referenced directly; for `download` providers it is the
  // preferred full-size URL that may be fetched and stored.
  imageUrl: string;
  // Optional alternate download URL (provider download endpoint/variant).
  downloadUrl?: string;
  // Endpoint that must be triggered on an actual download event (Unsplash
  // `download_location`). Purely an accounting event; no bytes are returned.
  downloadTrackingUrl?: string;
  sourceUrl: string;
  photographerName: string;
  photographerUrl?: string;
  color?: string;
  description?: string;
  usagePolicy: StockUsagePolicy;
  attribution: StockAttribution;
}

export interface StockSearchQuery {
  query: string;
  orientation?: StockOrientation;
  perPage?: number;
}

export interface StockRateLimitSnapshot {
  limit?: number;
  remaining?: number;
  // Epoch milliseconds at which the current window resets, when the provider
  // reports it.
  resetAt?: number;
  windowSeconds?: number;
}

export interface StockSearchResult {
  provider: StockProviderId;
  query: string;
  photos: StockPhoto[];
  rateLimit?: StockRateLimitSnapshot;
}

// How a selection came to be. `auto` is the router/planner path; `manual` is an
// explicit author choice made from search results. Manual selections are pinned
// so a production run (even a forced one) never silently swaps the photo for a
// different provider or a generated image.
export type StockSelectionOrigin = 'auto' | 'manual';

// Persisted, resolved choice for a scene. Stable across restarts so repeated
// resolutions are idempotent and never issue a duplicate search.
export interface StockSelection {
  provider: StockProviderId;
  photoId: string;
  query: string;
  orientation?: StockOrientation;
  usagePolicy: StockUsagePolicy;
  attribution: StockAttribution;
  sourceUrl: string;
  imageUrl: string;
  downloadUrl?: string;
  downloadTrackingUrl?: string;
  width: number;
  height: number;
  selectedAt: string;
  selectionKey: string;
  origin?: StockSelectionOrigin;
}

export function stockSelectionKey(query: string, orientation?: StockOrientation): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${orientation ?? 'any'}::${normalized}`;
}
