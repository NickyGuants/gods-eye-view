/**
 * @module kenyaRiverGauges/source
 * @description Fetch GloFAS river discharge for the Kenya gauge sites from the
 * Open-Meteo Flood API (https://open-meteo.com/en/docs/flood-api, CC BY 4.0,
 * no key, CORS-enabled). Portable: `fetchImpl` and `cache` are injected, so
 * this module never touches `window` or storage itself.
 *
 * Two requests per session, then one per refresh:
 *   1. SNAP (once): for every site, probe the 3×3 grid-cell neighbourhood and
 *      keep the cell with the highest mean past flow. GloFAS routes the river
 *      through one 0.05° cell; a hand-placed coordinate a few hundred metres
 *      off lands in a dry neighbour and reads as "no river". The snapped
 *      coordinates are kept in the injected cache for a week.
 *   2. SNAPSHOT (each refresh): 30 past days + 10 forecast days of
 *      river_discharge (with ensemble max/min/mean) for the snapped sites.
 */
import { KENYA_GAUGE_SITES, GLOFAS_CELL_DEG } from './sites.js';
import { normalizeFloodSnapshot, snapSitesFromProbe } from './records.js';

export const FLOOD_API_URL = 'https://flood-api.open-meteo.com/v1/flood';
export const FLOOD_PAST_DAYS = 30;
export const FLOOD_FORECAST_DAYS = 10;
const SNAP_PAST_DAYS = 30;
const SNAP_CACHE_KEY = 'gev:kenya-river-gauges:snap:v1';
const SNAP_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function coordinateList(points, key) {
  return points.map((p) => Number(p[key]).toFixed(4)).join(',');
}

/** Build the snapshot URL for a list of {lat,lon} points. Exported for tests. */
export function buildFloodUrl(points, { pastDays, forecastDays, daily }) {
  const params = new URLSearchParams({
    latitude: coordinateList(points, 'lat'),
    longitude: coordinateList(points, 'lon'),
    daily: daily.join(','),
    past_days: String(pastDays),
    forecast_days: String(forecastDays),
  });
  return `${FLOOD_API_URL}?${params.toString()}`;
}

/** The 3×3 neighbourhood of every site, flattened in site order. */
export function snapCandidates(sites, cellDeg = GLOFAS_CELL_DEG) {
  const candidates = [];
  for (const site of sites) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        candidates.push({
          siteId: site.id,
          lat: site.lat + dy * cellDeg,
          lon: site.lon + dx * cellDeg,
          center: dx === 0 && dy === 0,
        });
      }
    }
  }
  return candidates;
}

/**
 * @param {object} [options]
 * @param {function} [options.fetchImpl] fetch-compatible function.
 * @param {readonly object[]} [options.sites] Gauge sites to watch.
 * @param {{get:function(string):(string|null),set:function(string,string):void}|null} [options.cache]
 *   Optional string cache for snapped coordinates (the app passes localStorage).
 * @param {function():number} [options.now] Clock, for tests.
 * @param {boolean} [options.snap=true] Probe neighbourhoods before the first snapshot.
 */
export function createOpenMeteoFloodSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  sites = KENYA_GAUGE_SITES,
  cache = null,
  now = () => Date.now(),
  snap = true,
} = {}) {
  /** @type {Map<string,{lat:number,lon:number}>|null} */
  let snapped = null;

  function readCachedSnap() {
    if (!cache) return null;
    try {
      const raw = cache.get(SNAP_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (now() - Number(parsed.savedAt || 0) > SNAP_CACHE_TTL_MS) return null;
      const map = new Map();
      for (const site of sites) {
        const hit = parsed.sites?.[site.id];
        if (
          hit &&
          Number.isFinite(Number(hit.lat)) &&
          Number.isFinite(Number(hit.lon))
        ) {
          map.set(site.id, { lat: Number(hit.lat), lon: Number(hit.lon) });
        }
      }
      return map.size === sites.length ? map : null;
    } catch {
      return null;
    }
  }

  function writeCachedSnap(map) {
    if (!cache) return;
    try {
      const record = { savedAt: now(), sites: {} };
      for (const [id, point] of map) record.sites[id] = point;
      cache.set(SNAP_CACHE_KEY, JSON.stringify(record));
    } catch {
      /* cache is a convenience only */
    }
  }

  async function fetchJson(url, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, { signal });
    if (!response.ok)
      throw new Error(`Open-Meteo flood HTTP ${response.status}`);
    const payload = await response.json();
    signal?.throwIfAborted();
    return payload;
  }

  async function resolveSnap(signal) {
    if (snapped) return snapped;
    const cached = readCachedSnap();
    if (cached) {
      snapped = cached;
      return snapped;
    }
    const fallback = new Map(
      sites.map((site) => [site.id, { lat: site.lat, lon: site.lon }]),
    );
    if (!snap) {
      snapped = fallback;
      return snapped;
    }
    const candidates = snapCandidates(sites);
    const url = buildFloodUrl(candidates, {
      pastDays: SNAP_PAST_DAYS,
      forecastDays: 1,
      daily: ['river_discharge'],
    });
    let best = null;
    try {
      best = snapSitesFromProbe(await fetchJson(url, signal), candidates);
    } catch (error) {
      if (signal?.aborted) throw error;
      best = null; // A failed probe is not fatal: fall back to the raw sites.
    }
    const map = new Map(fallback);
    if (best) {
      for (const [id, hit] of best) map.set(id, { lat: hit.lat, lon: hit.lon });
      writeCachedSnap(map);
    }
    snapped = map;
    return snapped;
  }

  return {
    /** Sites in request order, so consumers can align rows. */
    sites,
    /**
     * @param {{signal?:AbortSignal}} [options]
     * @returns {Promise<object[]>} Gauge rows (see records.js).
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const snapMap = await resolveSnap(signal);
      const points = sites.map((site) => snapMap.get(site.id));
      const url = buildFloodUrl(points, {
        pastDays: FLOOD_PAST_DAYS,
        forecastDays: FLOOD_FORECAST_DAYS,
        daily: [
          'river_discharge',
          'river_discharge_mean',
          'river_discharge_max',
          'river_discharge_min',
        ],
      });
      const payload = await fetchJson(url, signal);
      const rows = normalizeFloodSnapshot(payload, sites, {
        todayIso: new Date(now()).toISOString().slice(0, 10),
      });
      if (!rows) throw new Error('Malformed Open-Meteo flood response');
      return rows;
    },
    /** Snapped coordinates, once known (diagnostics and tests). */
    getSnappedSites() {
      return snapped ? new Map(snapped) : null;
    },
  };
}
