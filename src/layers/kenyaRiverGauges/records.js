/**
 * @module kenyaRiverGauges/records
 * @description Pure normalization of Open-Meteo Flood API payloads into river
 * site rows. No Cesium, no browser globals, no fetch: everything here is
 * testable with plain objects.
 *
 * Severity is modelled flood potential against return-level thresholds
 * (Q1.5, Q2, Q5, Q20) derived offline from the GloFAS reanalysis
 * (`thresholds.json`, see scripts/kenya-gauge-thresholds.mjs), classified the
 * way GloFAS reporting points are: for each forecast day the fraction of
 * ensemble members at or above a threshold; a level is reached when that
 * fraction hits 30% (15 of the 50 perturbed members Open-Meteo serves) on any
 * day in the horizon. Without
 * members there is no probability, so the row is `unrated` and only the
 * upper scenario (ensemble max) is shown. All-null series are `unknown`,
 * never "normal".
 *
 * Open-Meteo returns one object for a single location and an array of objects
 * (in request order, each carrying `location_id`) for several. Both shapes
 * are accepted. A malformed payload returns `null` so a bad snapshot never
 * partially replaces good data.
 */
import { gumbelReturnPeriod, thresholdKey } from './returnPeriods.js';

/** Severity bands, calm to alarm; `unknown`/`unrated` are not on the ramp. */
export const GAUGE_SEVERITIES = Object.freeze([
  'unknown',
  'unrated',
  'normal',
  'watch',
  'moderate',
  'high',
  'severe',
]);

/** Return period → band reached when ≥ PROB_ALERT of members cross it. */
export const BAND_BY_RETURN_PERIOD = Object.freeze([
  { returnPeriod: 20, key: 'q20', severity: 'severe' },
  { returnPeriod: 5, key: 'q5', severity: 'high' },
  { returnPeriod: 2, key: 'q2', severity: 'moderate' },
  { returnPeriod: 1.5, key: 'q1_5', severity: 'watch' },
]);

/** CEMS reporting-point rule: a level counts at 30% of members. */
export const PROB_ALERT = 0.3;
/** CEMS probability sub-bands: light 30–50%, medium 50–75%, dark 75–100%. */
export const PROB_BANDS = Object.freeze([
  { min: 0.75, id: 'dark' },
  { min: 0.5, id: 'medium' },
  { min: PROB_ALERT, id: 'light' },
]);
/** Fewer valid members than this (of those served) and no probability is claimed. */
export const MIN_MEMBER_COVERAGE = 0.5;
/** Days ahead (inclusive of today) that earn the "within 3 days" badge. */
export const SOON_DAYS = 3;
/** How far a returned cell may sit from the threshold cell to be rated (deg). */
const CELL_TOLERANCE_DEG = 0.01;

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

/** Ensemble member series in the payload, in member order. */
export function memberSeries(daily) {
  if (!daily || typeof daily !== 'object') return [];
  return Object.keys(daily)
    .filter((k) => /^river_discharge_member\d+$/.test(k))
    .sort()
    .map((k) => (Array.isArray(daily[k]) ? daily[k].map(finiteOrNull) : null))
    .filter(Boolean);
}

/**
 * A member's maximum over the forecast window and the first day it crosses
 * a threshold. Members with no valid forecast value are not counted.
 * @param {Array<Array<number|null>>} members
 * @param {number} fromIndex First forecast day index.
 * @returns {Array<{max:number, firstAtOrAbove:function(number):number|null}>}
 */
export function memberMaxima(members, fromIndex) {
  const out = [];
  for (const series of members) {
    let max = null;
    for (let d = fromIndex; d < series.length; d++) {
      const v = series[d];
      if (v === null || v === undefined) continue;
      if (max === null || v > max) max = v;
    }
    if (max === null) continue;
    out.push({
      max,
      firstAtOrAbove(threshold) {
        for (let d = fromIndex; d < series.length; d++) {
          const v = series[d];
          if (v !== null && v !== undefined && v >= threshold) return d;
        }
        return null;
      },
    });
  }
  return out;
}

/**
 * Exceedance of one threshold, CEMS style: the share of valid members whose
 * window maximum is at or above it, and the first day by which that share
 * reaches PROB_ALERT.
 * @param {Array<Array<number|null>>} members
 * @param {number} fromIndex
 * @param {number} threshold
 * @returns {{fraction:number,members:number,served:number,dayIndex:number|null}}
 */
export function exceedance(members, fromIndex, threshold) {
  const maxima = memberMaxima(members, fromIndex);
  const valid = maxima.length;
  if (!valid)
    return { fraction: 0, members: 0, served: members.length, dayIndex: null };
  const crossingDays = maxima
    .map((m) => m.firstAtOrAbove(threshold))
    .filter((d) => d !== null)
    .sort((a, b) => a - b);
  const fraction = crossingDays.length / valid;
  // Day by which PROB_ALERT of the valid members have crossed.
  const needed = Math.ceil(PROB_ALERT * valid - 1e-9);
  const dayIndex =
    crossingDays.length >= needed && needed > 0
      ? crossingDays[needed - 1]
      : null;
  return { fraction, members: valid, served: members.length, dayIndex };
}

/** CEMS probability sub-band for a fraction, or null below the alert rule. */
export function probabilityBand(fraction) {
  for (const band of PROB_BANDS) if (fraction >= band.min) return band.id;
  return null;
}

/**
 * Classify one site from its ensemble and thresholds.
 * @param {Array<Array<number|null>>} members
 * @param {number} todayIndex
 * @param {{thresholds:Record<string,number>}|null} rating
 * @returns {{severity:string,unratedReason:string|null,levels:object[],reachedKey:string|null,reachedDayIndex:number|null,validMembers:number}}
 */
export function classifyEnsemble(members, todayIndex, rating) {
  const empty = (unratedReason, validMembers = 0) => ({
    severity: 'unrated',
    unratedReason,
    levels: [],
    reachedKey: null,
    reachedDayIndex: null,
    validMembers,
  });
  if (!rating?.thresholds) return empty('no-thresholds');
  const validMembers = memberMaxima(members, todayIndex).length;
  if (!members.length) return empty('no-ensemble');
  if (validMembers < Math.ceil(MIN_MEMBER_COVERAGE * members.length))
    return empty('low-coverage', validMembers);
  const levels = BAND_BY_RETURN_PERIOD.map((band) => {
    const threshold = rating.thresholds[band.key];
    const ex = Number.isFinite(threshold)
      ? exceedance(members, todayIndex, threshold)
      : {
          fraction: 0,
          members: validMembers,
          served: members.length,
          dayIndex: null,
        };
    return {
      ...band,
      threshold,
      ...ex,
      probabilityBand: probabilityBand(ex.fraction),
    };
  });
  const reached = levels.find((l) => l.fraction >= PROB_ALERT) || null;
  return {
    severity: reached ? reached.severity : 'normal',
    unratedReason: null,
    levels,
    reachedKey: reached ? reached.key : null,
    reachedDayIndex: reached ? reached.dayIndex : null,
    validMembers,
  };
}

/** Rating record for a site if the returned cell is the threshold cell. */
export function ratingForLocation(location, siteRating) {
  if (!siteRating?.thresholds || !siteRating.cell) return null;
  const lat = finiteOrNull(location?.latitude);
  const lon = finiteOrNull(location?.longitude);
  if (lat === null || lon === null) return null;
  if (
    Math.abs(lat - siteRating.cell.lat) > CELL_TOLERANCE_DEG ||
    Math.abs(lon - siteRating.cell.lon) > CELL_TOLERANCE_DEG
  )
    return null;
  return siteRating;
}

/**
 * Turn one Open-Meteo location object into a site row.
 * @param {object} location One entry of the API payload.
 * @param {object} site The site it was requested for.
 * @param {string} todayIso `YYYY-MM-DD` in UTC; days before it are the past.
 * @param {object|null} [siteRating] Bundled thresholds for this site.
 * @returns {object|null} A row, or null when the entry is unusable.
 */
export function gaugeRowFromLocation(
  location,
  site,
  todayIso,
  siteRating = null,
) {
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
  const members = memberSeries(daily).filter((m) => m.length === times.length);

  let todayIndex = times.findIndex((t) => t >= todayIso);
  if (todayIndex < 0) todayIndex = times.length - 1;

  const past = [];
  for (let i = 0; i < todayIndex; i++) {
    if (discharge[i] !== null) past.push(discharge[i]);
  }
  const baseline = median(past);
  const pastDays = todayIndex;

  // Current flow: today's value, else the last known past value.
  let current = discharge[todayIndex];
  if (current === null) {
    for (let i = todayIndex - 1; i >= 0 && current === null; i--)
      current = discharge[i];
  }

  // Upper scenario: the ensemble max when the API provides it, else control.
  let peak = null;
  let peakDate = null;
  let peakIndex = -1;
  let forecastDays = 0;
  for (let i = todayIndex; i < times.length; i++) {
    const candidate =
      (maxSeries && maxSeries[i] !== null ? maxSeries[i] : null) ??
      discharge[i];
    if (candidate === null) continue;
    forecastDays++;
    if (peak === null || candidate > peak) {
      peak = candidate;
      peakDate = times[i];
      peakIndex = i;
    }
  }

  // Ensemble median peak: the central scenario.
  let medianPeak = null;
  if (members.length) {
    const peaks = members
      .map((m) => Math.max(...m.slice(todayIndex).filter((v) => v !== null)))
      .filter(Number.isFinite);
    medianPeak = median(peaks);
  }

  const ratio =
    peak !== null && baseline !== null && baseline > 0 ? peak / baseline : null;

  const rating = ratingForLocation(location, siteRating);
  const noData = current === null && peak === null;
  let severity;
  let unratedReason = null;
  let levels = [];
  let reachedKey = null;
  let reachedDayIndex = null;
  let validMembers = 0;
  if (noData) {
    severity = 'unknown';
  } else if (!rating) {
    severity = 'unrated';
    unratedReason = siteRating?.thresholds ? 'cell-mismatch' : 'no-thresholds';
  } else {
    // An ensemble max is one member, not a probability: classifyEnsemble
    // returns `unrated` with a reason when members are missing or sparse.
    const c = classifyEnsemble(members, todayIndex, rating);
    severity = c.severity;
    unratedReason = c.unratedReason;
    levels = c.levels;
    reachedKey = c.reachedKey;
    reachedDayIndex = c.reachedDayIndex;
    validMembers = c.validMembers;
  }
  const reachedInDays =
    reachedDayIndex === null ? null : reachedDayIndex - todayIndex;
  const peakReturnPeriod =
    rating?.gumbel && peak !== null
      ? gumbelReturnPeriod(rating.gumbel.mu, rating.gumbel.beta, peak)
      : null;
  const medianPeakReturnPeriod =
    rating?.gumbel && medianPeak !== null
      ? gumbelReturnPeriod(rating.gumbel.mu, rating.gumbel.beta, medianPeak)
      : null;

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
    pastDays,
    forecastDays,
    peak,
    peakDate,
    peakInDays: peakIndex >= 0 ? peakIndex - todayIndex : null,
    medianPeak,
    ratio,
    severity,
    unratedReason,
    rated: Boolean(rating),
    memberCount: members.length,
    validMembers,
    levels,
    reachedKey,
    reachedInDays,
    soon: reachedInDays !== null && reachedInDays < SOON_DAYS,
    thresholds: rating?.thresholds || null,
    thresholdPeriod: rating?.period
      ? {
          start: rating.period.start,
          end: rating.period.end,
          years: rating.period.years,
        }
      : null,
    peakReturnPeriod,
    medianPeakReturnPeriod,
    days,
  };
}

/**
 * Normalize a whole snapshot. Rows keep the site order; a site whose entry is
 * unusable is dropped rather than failing the snapshot, but a payload with no
 * usable entries at all, or with a shape that is not Open-Meteo's, is `null`.
 * @param {object|object[]} payload API response.
 * @param {readonly object[]} sites Requested sites, in request order.
 * @param {{todayIso?:string, thresholds?:Record<string,object>}} [options]
 *   `thresholds` is the `sites` map of thresholds.json.
 * @returns {object[]|null}
 */
export function normalizeFloodSnapshot(
  payload,
  sites,
  { todayIso, thresholds = null } = {},
) {
  const locations = locationsFromPayload(payload);
  if (!locations || !Array.isArray(sites)) return null;
  if (locations.length !== sites.length) return null;
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const rows = [];
  locations.forEach((location, index) => {
    const site = sites[index];
    const row = gaugeRowFromLocation(
      location,
      site,
      today,
      thresholds?.[site.id] || null,
    );
    if (row) rows.push(row);
  });
  return rows.length ? rows : null;
}

/**
 * Pick, for each site, the neighbourhood cell with the largest mean past flow:
 * that is the cell GloFAS routes the river through. Used by the offline
 * thresholds script, and by the browser only for sites without a bundled cell.
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

/** Threshold key helper re-export so callers do not import returnPeriods. */
export { thresholdKey };
