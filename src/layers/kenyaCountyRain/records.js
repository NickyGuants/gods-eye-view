/**
 * @module kenyaCountyRain/records
 * @description Pure normalization of Open-Meteo forecast payloads into one
 * rainfall row per county. No Cesium, no browser globals.
 */

/** Rainfall bands for the 7-day forecast total (mm). */
export const RAIN_BANDS = Object.freeze([
  { id: 'dry', max: 10, label: 'Dry' },
  { id: 'light', max: 40, label: 'Light' },
  { id: 'moderate', max: 90, label: 'Moderate' },
  { id: 'heavy', max: 160, label: 'Heavy' },
  { id: 'extreme', max: Infinity, label: 'Extreme' },
]);

/** @param {number} totalMm */
export function rainBand(totalMm) {
  const value = Number.isFinite(totalMm) ? totalMm : 0;
  for (const band of RAIN_BANDS) if (value < band.max) return band.id;
  return 'extreme';
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function locations(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') return [payload];
  return null;
}

/**
 * @param {object} location One Open-Meteo forecast entry.
 * @param {object} county Requested county.
 * @param {string} todayIso Local `YYYY-MM-DD`.
 */
export function rainRowFromLocation(location, county, todayIso) {
  const daily = location?.daily;
  if (!daily || !Array.isArray(daily.time) || !daily.time.length) return null;
  const times = daily.time.map(String);
  const sums = Array.isArray(daily.precipitation_sum)
    ? daily.precipitation_sum.map(finiteOrNull)
    : null;
  if (!sums || sums.length !== times.length) return null;
  const probs = Array.isArray(daily.precipitation_probability_max)
    ? daily.precipitation_probability_max.map(finiteOrNull)
    : null;

  let todayIndex = times.findIndex((t) => t >= todayIso);
  if (todayIndex < 0) todayIndex = times.length - 1;

  let past7 = 0;
  for (let i = Math.max(0, todayIndex - 7); i < todayIndex; i++)
    past7 += sums[i] || 0;
  let next7 = 0;
  let wettestDay = null;
  let wettestMm = -1;
  for (let i = todayIndex; i < Math.min(times.length, todayIndex + 7); i++) {
    const mm = sums[i] || 0;
    next7 += mm;
    if (mm > wettestMm) {
      wettestMm = mm;
      wettestDay = times[i];
    }
  }
  let next3 = 0;
  for (let i = todayIndex; i < Math.min(times.length, todayIndex + 3); i++)
    next3 += sums[i] || 0;

  const days = times.map((time, i) => ({
    time,
    mm: sums[i],
    probability: probs ? probs[i] : null,
    past: i < todayIndex,
  }));

  return {
    id: county.id,
    name: county.name,
    iso: county.iso,
    lat: finiteOrNull(location.latitude) ?? county.lat,
    lon: finiteOrNull(location.longitude) ?? county.lon,
    todayIso: times[todayIndex],
    past7Mm: Math.round(past7 * 10) / 10,
    next3Mm: Math.round(next3 * 10) / 10,
    next7Mm: Math.round(next7 * 10) / 10,
    todayMm: sums[todayIndex],
    wettestDay,
    wettestMm: wettestMm >= 0 ? Math.round(wettestMm * 10) / 10 : null,
    band: rainBand(next7),
    days,
  };
}

/**
 * @param {object|object[]} payload
 * @param {readonly object[]} counties Requested counties in request order.
 * @param {{todayIso?:string}} [options]
 * @returns {object[]|null}
 */
export function normalizeRainSnapshot(payload, counties, { todayIso } = {}) {
  const entries = locations(payload);
  if (!entries || !Array.isArray(counties)) return null;
  if (entries.length !== counties.length) return null;
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const rows = [];
  entries.forEach((entry, index) => {
    const row = rainRowFromLocation(entry, counties[index], today);
    if (row) rows.push(row);
  });
  return rows.length ? rows : null;
}
