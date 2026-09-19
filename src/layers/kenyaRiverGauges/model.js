import * as Cesium from 'cesium';
export { GAUGE_SEVERITIES, severityForRatio } from './records.js';

export const KENYA_GAUGE_OVERLAY_SOURCE_ID = 'kenya-river-gauges';
export const KENYA_GAUGE_OVERLAY_COHORT_LIMIT = 48;
export const KENYA_GAUGE_OVERLAY_COLLISION_CAPACITY = 32;

/** Severity → colour. One hue family, ramping from calm to alarm. */
const SEVERITY_COLORS = Object.freeze({
  steady: Cesium.Color.fromCssColorString('#3fb9d8'),
  rising: Cesium.Color.fromCssColorString('#f2c14e'),
  high: Cesium.Color.fromCssColorString('#f28c28'),
  severe: Cesium.Color.fromCssColorString('#e5383b'),
});

/** @param {string} severity */
export function severityColor(severity) {
  return SEVERITY_COLORS[severity] || SEVERITY_COLORS.steady;
}

/** Rank used for label priority and cohort selection. */
export function severityRank(severity) {
  switch (severity) {
    case 'severe':
      return 3;
    case 'high':
      return 2;
    case 'rising':
      return 1;
    default:
      return 0;
  }
}

/** Human wording for a severity band. */
export function severityLabel(severity) {
  switch (severity) {
    case 'severe':
      return 'SEVERE RISE';
    case 'high':
      return 'HIGH';
    case 'rising':
      return 'RISING';
    default:
      return 'STEADY';
  }
}

/** Format a discharge value for cards: "412 m³/s", "3.2 m³/s". */
export function formatFlow(value, unit = 'm³/s') {
  if (!Number.isFinite(value)) return '—';
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}

/** "×2.4" style multiplier text. */
export function formatRatio(ratio) {
  if (!Number.isFinite(ratio)) return '—';
  return `×${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Tue 23 Sep" from an ISO date; pure string work, UTC. */
export function formatDay(iso) {
  if (typeof iso !== 'string' || iso.length < 10) return '—';
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  const month = date.toLocaleString('en-GB', {
    month: 'short',
    timeZone: 'UTC',
  });
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${month}`;
}

/** Radius (m) of the ground disc: grows with the forecast peak, gently. */
export function discRadiusMeters(row) {
  const peak = Number.isFinite(row?.peak) ? row.peak : 0;
  const base = 1500;
  return base + Math.sqrt(Math.max(peak, 0)) * 450;
}

/** The one-line ambient detail under a gauge's name. */
export function gaugeAmbientDetail(row) {
  if (row.lowBaseline) {
    return row.peak > 0
      ? `dry channel · peak ${formatFlow(row.peak, row.unit)}`
      : 'dry channel';
  }
  const when =
    row.peakInDays === 0
      ? 'today'
      : row.peakInDays === 1
        ? 'tomorrow'
        : `in ${row.peakInDays}d`;
  return `${severityLabel(row.severity)} ${formatRatio(row.ratio)} · peak ${formatFlow(row.peak, row.unit)} ${when}`;
}

/** Card lines for the click readout. Pure. */
export function gaugeReadoutDetails(row) {
  const lines = [];
  lines.push(`${row.river} · ${row.county}`);
  lines.push(
    `${severityLabel(row.severity)} · peak ${formatRatio(row.ratio)} the 30-day median`,
  );
  lines.push(
    `Now ${formatFlow(row.current, row.unit)} · median ${formatFlow(row.baseline, row.unit)}`,
  );
  lines.push(
    `Peak ${formatFlow(row.peak, row.unit)} · ${formatDay(row.peakDate)}`,
  );
  if (row.note) lines.push(row.note);
  lines.push('GloFAS v4 via Open-Meteo · 5 km grid cell, not a physical gauge');
  return lines;
}

/**
 * Build the ambient card entry for one gauge.
 * @param {object} input
 * @param {object} input.row Gauge row.
 * @param {Cesium.Cartesian3} input.position Anchor.
 * @returns {object}
 */
export function createGaugeOverlayEntry({ row, position }) {
  const color = severityColor(row.severity);
  return {
    id: String(row.id),
    source: KENYA_GAUGE_OVERLAY_SOURCE_ID,
    position,
    variant: 'card',
    title: row.name,
    details: [gaugeAmbientDetail(row)],
    accent: color.toCssColorString(),
    priority:
      severityRank(row.severity) * 100000 +
      Math.round(Math.min(row.ratio || 0, 99) * 1000),
    collisionGroup: 'ambient-card',
    zIndex: 30,
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

/** Keep the most alarming gauges first; identity breaks ties. */
export function selectGaugeOverlayCohort(
  entries,
  limit = KENYA_GAUGE_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(KENYA_GAUGE_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
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

/** JSON-safe record for the voice analyst. */
export function mapGaugeAnalystRecord(row) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    id: String(row.id),
    name: row.name,
    river: row.river,
    county: row.county,
    lat: num(row.lat),
    lon: num(row.lon),
    severity: row.severity,
    currentM3s: num(row.current),
    baselineM3s: num(row.baseline),
    peakM3s: num(row.peak),
    peakDate: row.peakDate || null,
    peakRatio: num(row.ratio),
  };
}
