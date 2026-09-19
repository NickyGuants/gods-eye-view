/**
 * @module kenyaRiverGauges/records
 * @description Pure normalization of Open-Meteo Flood API payloads into gauge
 * rows. No Cesium, no browser globals, no fetch: everything here is testable
 * with plain objects.
 *
 * Open-Meteo returns one object for a single location and an array of objects
 * (in request order, each carrying `location_id`) for several. Both shapes
 * are accepted. A malformed payload returns `null` so a bad snapshot never
 * partially replaces good data.
 */

/** Severity bands on the forecast peak relative to the recent baseline. */
export const GAUGE_SEVERITIES = Object.freeze([
  'steady',
  'rising',
  'high',
  'severe',
]);

const RATIO_RISING = 1.3;
const RATIO_HIGH = 2.0;
const RATIO_SEVERE = 4.0;
/** Baselines below this (m³/s) are near-dry channels; ratios there mislead. */
const LOW_BASELINE_M3S = 2;

/** Coerce Open-Meteo's single/multi shape into an array of location objects. */
export function locationsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') return [payload];
  return null;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Classify a peak-to-baseline ratio. Exported for the legend and tests. */
export function severityForRatio(ratio) {
  if (!Number.isFinite(ratio)) return 'steady';
  if (ratio >= RATIO_SEVERE) return 'severe';
  if (ratio >= RATIO_HIGH) return 'high';
  if (ratio >= RATIO_RISING) return 'rising';
  return 'steady';
}

/**
 * Turn one Open-Meteo location object into a gauge row.
 * @param {object} location One entry of the API payload.
 * @param {object} site The site it was requested for.
 * @param {string} todayIso `YYYY-MM-DD` in UTC; days before it are the past.
 * @returns {object|null} A row, or null when the entry is unusable.
 */
export function gaugeRowFromLocation(location, site, todayIso) {
  const daily = location?.daily;
  if (!daily || !Array.isArray(daily.time) || !daily.time.length) return null;
  const times = daily.time.map(String);
  const discharge = Array.isArray(daily.river_discharge)
    ? daily.river_discharge.map(finiteOrNull)
    : null;
  if (!discharge || discharge.length !== times.length) return null;
  const maxSeries = Array.isArray(daily.river_discharge_max)
    ? daily.river_discharge_max.map(finiteOrNull)
    : null;
  const minSeries = Array.isArray(daily.river_discharge_min)
    ? daily.river_discharge_min.map(finiteOrNull)
    : null;
  const meanSeries = Array.isArray(daily.river_discharge_mean)
    ? daily.river_discharge_mean.map(finiteOrNull)
    : null;

  let todayIndex = times.findIndex((t) => t >= todayIso);
  if (todayIndex < 0) todayIndex = times.length - 1;

  const past = [];
  for (let i = 0; i < todayIndex; i++) {
    if (discharge[i] !== null) past.push(discharge[i]);
  }
  const baseline = median(past);

  // Current flow: today's value, else the last known past value.
  let current = discharge[todayIndex];
  if (current === null) {
    for (let i = todayIndex - 1; i >= 0 && current === null; i--)
      current = discharge[i];
  }

  // Forecast peak: prefer the ensemble maximum when the API provides it.
  let peak = null;
  let peakDate = null;
  let peakIndex = -1;
  for (let i = todayIndex; i < times.length; i++) {
    const candidate =
      (maxSeries && maxSeries[i] !== null ? maxSeries[i] : null) ??
      discharge[i];
    if (candidate === null) continue;
    if (peak === null || candidate > peak) {
      peak = candidate;
      peakDate = times[i];
      peakIndex = i;
    }
  }

  const ratio =
    peak !== null && baseline !== null && baseline > 0 ? peak / baseline : null;
  const lowBaseline = baseline !== null && baseline < LOW_BASELINE_M3S;
  const severity = lowBaseline
    ? peak !== null && peak >= LOW_BASELINE_M3S * RATIO_SEVERE
      ? 'rising'
      : 'steady'
    : severityForRatio(ratio);

  const days = times.map((time, i) => ({
    time,
    discharge: discharge[i],
    max: maxSeries ? maxSeries[i] : null,
    min: minSeries ? minSeries[i] : null,
    mean: meanSeries ? meanSeries[i] : null,
    past: i < todayIndex,
  }));

  return {
    id: site.id,
    name: site.name,
    river: site.river,
    county: site.county,
    note: site.note,
    lat: finiteOrNull(location.latitude) ?? site.lat,
    lon: finiteOrNull(location.longitude) ?? site.lon,
    requestedLat: site.lat,
    requestedLon: site.lon,
    unit: String(location?.daily_units?.river_discharge || 'm³/s'),
    todayIso: times[todayIndex],
    current,
    baseline,
    peak,
    peakDate,
    peakInDays: peakIndex >= 0 ? peakIndex - todayIndex : null,
    ratio,
    lowBaseline,
    severity,
    days,
  };
}

/**
 * Normalize a whole snapshot. Rows keep the site order; a site whose entry is
 * unusable is dropped rather than failing the snapshot, but a payload with no
 * usable entries at all, or with a shape that is not Open-Meteo's, is `null`.
 * @param {object|object[]} payload API response.
 * @param {readonly object[]} sites Requested sites, in request order.
 * @param {{todayIso?:string}} [options]
 * @returns {object[]|null}
 */
export function normalizeFloodSnapshot(payload, sites, { todayIso } = {}) {
  const locations = locationsFromPayload(payload);
  if (!locations || !Array.isArray(sites)) return null;
  if (locations.length !== sites.length) return null;
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const rows = [];
  locations.forEach((location, index) => {
    const row = gaugeRowFromLocation(location, sites[index], today);
    if (row) rows.push(row);
  });
  return rows.length ? rows : null;
}

/**
 * Pick, for each site, the neighbourhood cell with the largest mean past flow:
 * that is the cell GloFAS routes the river through. Used once per session by
 * the source's snap step.
 * @param {object|object[]} payload Probe response, one entry per candidate.
 * @param {Array<{siteId:string,lat:number,lon:number,center?:boolean}>} candidates
 *   Same order; `center` marks the site's own cell, which wins ties.
 * @returns {Map<string,{lat:number,lon:number,meanFlow:number}>|null}
 */
export function snapSitesFromProbe(payload, candidates) {
  const locations = locationsFromPayload(payload);
  if (!locations || locations.length !== candidates.length) return null;
  const best = new Map();
  locations.forEach((location, index) => {
    const candidate = candidates[index];
    const series = location?.daily?.river_discharge;
    if (!Array.isArray(series)) return;
    const values = series.map(finiteOrNull).filter((v) => v !== null);
    if (!values.length) return;
    const meanFlow = values.reduce((a, b) => a + b, 0) / values.length;
    const previous = best.get(candidate.siteId);
    const wins =
      !previous ||
      meanFlow > previous.meanFlow ||
      (meanFlow === previous.meanFlow && candidate.center === true);
    if (wins) {
      best.set(candidate.siteId, {
        lat: finiteOrNull(location.latitude) ?? candidate.lat,
        lon: finiteOrNull(location.longitude) ?? candidate.lon,
        meanFlow,
      });
    }
  });
  return best.size ? best : null;
}
