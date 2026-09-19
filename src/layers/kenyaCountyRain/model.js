import * as Cesium from 'cesium';
export { RAIN_BANDS, rainBand } from './records.js';

export const KENYA_RAIN_OVERLAY_SOURCE_ID = 'kenya-county-rain';
export const KENYA_RAIN_OVERLAY_COHORT_LIMIT = 47;
export const KENYA_RAIN_OVERLAY_COLLISION_CAPACITY = 32;

/** Band → colour: a single blue ramp so the map reads as one quantity. */
const BAND_COLORS = Object.freeze({
  unknown: Cesium.Color.fromCssColorString('#6b7280'),
  dry: Cesium.Color.fromCssColorString('#d9c9a3'),
  light: Cesium.Color.fromCssColorString('#9ecae1'),
  moderate: Cesium.Color.fromCssColorString('#4292c6'),
  heavy: Cesium.Color.fromCssColorString('#08519c'),
  extreme: Cesium.Color.fromCssColorString('#5b0f8f'),
});

/** @param {string} band */
export function bandColor(band) {
  return BAND_COLORS[band] || BAND_COLORS.dry;
}

/** Fill alpha grows with the band so wet counties dominate the picture. */
export function bandFillAlpha(band) {
  switch (band) {
    case 'extreme':
      return 0.62;
    case 'heavy':
      return 0.52;
    case 'moderate':
      return 0.4;
    case 'light':
      return 0.26;
    default:
      return 0.12;
  }
}

export function bandRank(band) {
  return ['unknown', 'dry', 'light', 'moderate', 'heavy', 'extreme'].indexOf(
    band,
  );
}

/** "128 mm" */
export function formatMm(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} mm`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function formatDay(iso) {
  if (typeof iso !== 'string' || iso.length < 10) return '—';
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()}`;
}

/** One-line ambient detail: the 7-day total and the wettest day. */
export function rainAmbientDetail(row) {
  if (row.band === 'unknown') return 'no forecast data';
  const wettest =
    row.wettestMm > 0
      ? ` · ${formatDay(row.wettestDay)} ${formatMm(row.wettestMm)}`
      : '';
  return `${formatMm(row.next7Mm)} next 7d${wettest}`;
}

/** "1.2 M" / "316 k" population text. */
export function formatPopulation(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} k`;
  return String(Math.round(n));
}

/** Click readout lines. */
export function rainReadoutDetails(row) {
  const lines = [
    `Next 7 days ${formatMm(row.next7Mm)} · next 3 days ${formatMm(row.next3Mm)}` +
      (row.next7Days !== undefined && row.next7Days < 7
        ? ` · ${row.next7Days}/7 days of data`
        : ''),
    `Past 7 days ${formatMm(row.past7Mm)} · today ${formatMm(row.todayMm)}`,
  ];
  if (Number.isFinite(row.population2019))
    lines.push(
      `Residents ${formatPopulation(row.population2019)} (2019 census)`,
    );
  if (row.wettestDay)
    lines.push(
      `Wettest day ${formatDay(row.wettestDay)} · ${formatMm(row.wettestMm)}`,
    );
  const upcoming = row.days
    .filter((d) => !d.past)
    .slice(0, 7)
    .map((d) => `${formatDay(d.time).slice(0, 3)} ${Math.round(d.mm || 0)}`)
    .join(' · ');
  if (upcoming) lines.push(upcoming);
  lines.push('Open-Meteo forecast at the county centroid');
  return lines;
}

export function createRainOverlayEntry({ row, position }) {
  const color = bandColor(row.band);
  return {
    id: String(row.id),
    source: KENYA_RAIN_OVERLAY_SOURCE_ID,
    position,
    variant: 'card',
    title: row.name,
    details: [rainAmbientDetail(row)],
    accent: color.toCssColorString(),
    priority: bandRank(row.band) * 100000 + Math.round((row.next7Mm || 0) * 10),
    collisionGroup: 'ambient-card',
    zIndex: 28,
    interactive: false,
    minDistance: 0,
    maxDistance: 14000000,
    distanceFadeStartRatio: 250000 / 14000000,
    distanceScale: { near: 250000, nearValue: 1, far: 9000000, farValue: 0.7 },
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    placement: 'above',
  };
}

export function selectRainOverlayCohort(
  entries,
  limit = KENYA_RAIN_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(KENYA_RAIN_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

export function mapRainAnalystRecord(row) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    id: String(row.id),
    county: row.name,
    lat: num(row.lat),
    lon: num(row.lon),
    band: row.band,
    next7Mm: num(row.next7Mm),
    population2019: num(row.population2019),
    next3Mm: num(row.next3Mm),
    past7Mm: num(row.past7Mm),
    wettestDay: row.wettestDay || null,
    wettestMm: num(row.wettestMm),
  };
}
