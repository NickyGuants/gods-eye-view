/**
 * @module nasaImerg/model
 * @description Constants and pure helpers for the NASA GIBS rainfall overlay.
 * No Cesium here so the tile addressing can be unit-tested.
 */

/** GIBS WMTS endpoint (Web Mercator, "best" quality). KVP GetTile. */
export const GIBS_WMTS_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi';

/** GIBS layer identifiers for GPM IMERG precipitation rate. */
export const IMERG_PRODUCTS = Object.freeze({
  /** Half-hourly precipitation rate, near real time (Early run). */
  rate: 'IMERG_Precipitation_Rate',
  /** Half-hourly product exposed under the explicit 30-minute name. */
  rate30: 'IMERG_Precipitation_Rate_30min',
});

export const IMERG_TILE_MATRIX_SET = 'GoogleMapsCompatible_Level6';
export const IMERG_MAX_LEVEL = 6;
export const IMERG_FORMAT = 'image/png';
export const IMERG_DEFAULT_ALPHA = 0.72;

/** Clamp an alpha to the range the overlay accepts. */
export function normalizeAlpha(value, fallback = IMERG_DEFAULT_ALPHA) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0.1, n));
}

/** Resolve a product key or identifier to a GIBS layer identifier. */
export function resolveImergLayer(product) {
  if (!product) return IMERG_PRODUCTS.rate;
  if (IMERG_PRODUCTS[product]) return IMERG_PRODUCTS[product];
  const known = Object.values(IMERG_PRODUCTS);
  return known.includes(product) ? product : IMERG_PRODUCTS.rate;
}

/**
 * Round a timestamp down to the last completed IMERG half-hour, minus the
 * latency GIBS needs to publish the Early run (about 4-6 hours), as a WMTS
 * TIME string. Callers usually leave TIME out entirely and let GIBS serve its
 * default (latest) slot; this exists for explicit replay.
 * @param {number} timestampMs
 * @param {number} [latencyMs=5*3600*1000]
 */
export function imergTimeFor(timestampMs, latencyMs = 5 * 3600 * 1000) {
  const slot = 30 * 60 * 1000;
  const t = Math.floor((timestampMs - latencyMs) / slot) * slot;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
