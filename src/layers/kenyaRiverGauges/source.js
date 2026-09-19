/**
 * @module kenyaRiverGauges/source
 * @description Fetch GloFAS river discharge for the Kenya river sites from the
 * Open-Meteo Flood API (https://open-meteo.com/en/docs/flood-api, CC BY 4.0,
 * no key, CORS-enabled). Portable: `fetchImpl` and `cache` are injected, so
 * this module never touches `window` or storage itself.
 *
 * Cells: every site with bundled thresholds (thresholds.json) is requested at
 * its frozen threshold cell, so the classification and the thresholds always
 * refer to the same GloFAS cell. Only a site without a bundled cell falls
 * back to the one-time 3×3 neighbourhood probe (wettest cell wins, cached in
 * the injected cache for a week).
 *
 * Snapshot (each refresh), two calls so a slow ensemble never hides the river:
 *   1. control run, 30 past days + 10 forecast days, with ensemble
 *      mean/max/min (about 8 KB for 24 sites);
 *   2. the 50 perturbed ensemble members for the 10 forecast days only (about 25 KB),
 *      merged into the first payload. If it fails the rows still render,
 *      classified `unrated`, and `getLastEnsembleError()` says why.
 */
import { KENYA_GAUGE_SITES, GLOFAS_CELL_DEG } from './sites.js';
import { normalizeFloodSnapshot, snapSitesFromProbe } from './records.js';
import bundledThresholds from './thresholds.json' with { type: 'json' };

export const FLOOD_API_URL = 'https://flood-api.open-meteo.com/v1/flood';
export const FLOOD_PAST_DAYS = 30;
export const FLOOD_FORECAST_DAYS = 10;
const SNAP_PAST_DAYS = 30;
const SNAP_CACHE_KEY = 'gev:kenya-river-gauges:snap:v2';
const SNAP_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Bundled return-level thresholds (see scripts/kenya-gauge-thresholds.mjs). */
export const KENYA_GAUGE_THRESHOLDS = bundledThresholds;

function coordinateList(points, key) {
  return points.map((p) => Number(p[key]).toFixed(4)).join(',');
}

/** Build the snapshot URL for a list of {lat,lon} points. Exported for tests. */
export function buildFloodUrl(
  points,
  { pastDays, forecastDays, daily, ensemble = false },
) {
  const params = new URLSearchParams({
    latitude: coordinateList(points, 'lat'),
    longitude: coordinateList(points, 'lon'),
    daily: daily.join(','),
    past_days: String(pastDays),
    forecast_days: String(forecastDays),
  });
  if (ensemble) params.set('ensemble', 'true');
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
 * @param {readonly object[]} [options.sites] Sites to watch.
 * @param {object|null} [options.thresholds] thresholds.json document (bundled by default).
 * @param {{get:function(string):(string|null),set:function(string,string):void}|null} [options.cache]
 *   Optional string cache for snapped coordinates (the app passes localStorage).
 * @param {function():number} [options.now] Clock, for tests.
 * @param {boolean} [options.snap=true] Probe neighbourhoods for sites without a bundled cell.
 * @param {boolean} [options.ensemble=true] Ask for the 50 ensemble members.
 */
export function createOpenMeteoFloodSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  sites = KENYA_GAUGE_SITES,
  thresholds = bundledThresholds,
  cache = null,
  now = () => Date.now(),
  snap = true,
  ensemble = true,
} = {}) {
  /** @type {Map<string,{lat:number,lon:number}>|null} */
  let snapped = null;
  const ratings = thresholds?.sites || {};

  function bundledCell(site) {
    const cell = ratings[site.id]?.cell;
    return cell && Number.isFinite(cell.lat) && Number.isFinite(cell.lon)
      ? { lat: cell.lat, lon: cell.lon }
      : null;
  }

  function readCachedSnap(pending) {
    if (!cache) return null;
    try {
      const raw = cache.get(SNAP_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (now() - Number(parsed.savedAt || 0) > SNAP_CACHE_TTL_MS) return null;
      const map = new Map();
      for (const site of pending) {
        const hit = parsed.sites?.[site.id];
        if (
          hit &&
          Number.isFinite(Number(hit.lat)) &&
          Number.isFinite(Number(hit.lon))
        ) {
          map.set(site.id, { lat: Number(hit.lat), lon: Number(hit.lon) });
        }
      }
      return map.size === pending.length ? map : null;
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
    const map = new Map();
    const pending = [];
    for (const site of sites) {
      const cell = bundledCell(site);
      if (cell) map.set(site.id, cell);
      else pending.push(site);
    }
    if (!pending.length) {
      snapped = map;
      return snapped;
    }
    const cached = readCachedSnap(pending);
    if (cached) {
      for (const [id, cell] of cached) map.set(id, cell);
      snapped = map;
      return snapped;
    }
    for (const site of pending)
      map.set(site.id, { lat: site.lat, lon: site.lon });
    if (snap) {
      const candidates = snapCandidates(pending);
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
      if (best) {
        const learned = new Map();
        for (const [id, hit] of best) {
          map.set(id, { lat: hit.lat, lon: hit.lon });
          learned.set(id, { lat: hit.lat, lon: hit.lon });
        }
        writeCachedSnap(learned);
      }
    }
    snapped = map;
    return snapped;
  }

  /** Merge forecast-only member series into the control payload, in order. */
  function mergeMembers(basePayload, ensemblePayload) {
    const base = Array.isArray(basePayload) ? basePayload : [basePayload];
    const ens = Array.isArray(ensemblePayload)
      ? ensemblePayload
      : [ensemblePayload];
    if (ens.length !== base.length) return false;
    base.forEach((location, i) => {
      const daily = location?.daily;
      const eDaily = ens[i]?.daily;
      if (
        !daily ||
        !eDaily ||
        !Array.isArray(daily.time) ||
        !Array.isArray(eDaily.time)
      )
        return;
      // Join every value by its date; a date the control run does not know
      // is dropped rather than shifted onto a neighbour.
      const indexByDate = new Map(daily.time.map((t, i) => [String(t), i]));
      const targets = eDaily.time.map((t) => indexByDate.get(String(t)) ?? -1);
      if (!targets.some((t) => t >= 0)) return;
      for (const key of Object.keys(eDaily)) {
        if (!/^river_discharge_member\d+$/.test(key)) continue;
        if (!Array.isArray(eDaily[key])) continue;
        const series = new Array(daily.time.length).fill(null);
        eDaily[key].forEach((v, d) => {
          const i = targets[d];
          if (i >= 0) series[i] = v;
        });
        daily[key] = series;
      }
    });
    return true;
  }

  let lastEnsembleError = null;

  return {
    /** Sites in request order, so consumers can align rows. */
    sites,
    /** The thresholds document in use (bundled unless injected). */
    thresholds,
    /**
     * @param {{signal?:AbortSignal}} [options]
     * @returns {Promise<object[]>} Site rows (see records.js).
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const snapMap = await resolveSnap(signal);
      const points = sites.map((site) => snapMap.get(site.id));
      const controlUrl = buildFloodUrl(points, {
        pastDays: FLOOD_PAST_DAYS,
        forecastDays: FLOOD_FORECAST_DAYS,
        daily: [
          'river_discharge',
          'river_discharge_mean',
          'river_discharge_max',
          'river_discharge_min',
        ],
      });
      const payload = await fetchJson(controlUrl, signal);
      lastEnsembleError = null;
      if (ensemble) {
        const ensembleUrl = buildFloodUrl(points, {
          pastDays: 0,
          forecastDays: FLOOD_FORECAST_DAYS,
          daily: ['river_discharge'],
          ensemble: true,
        });
        try {
          const members = await fetchJson(ensembleUrl, signal);
          if (!mergeMembers(payload, members))
            lastEnsembleError = 'ensemble payload did not align with the sites';
        } catch (error) {
          if (signal?.aborted) throw error;
          lastEnsembleError = error?.message || 'ensemble unavailable';
        }
      }
      const rows = normalizeFloodSnapshot(payload, sites, {
        todayIso: new Date(now()).toISOString().slice(0, 10),
        thresholds: ratings,
      });
      if (!rows) throw new Error('Malformed Open-Meteo flood response');
      return rows;
    },
    /** Why the last snapshot had no ensemble members, or null. */
    getLastEnsembleError() {
      return lastEnsembleError;
    },
    /** Snapped coordinates, once known (diagnostics and tests). */
    getSnappedSites() {
      return snapped ? new Map(snapped) : null;
    },
  };
}
