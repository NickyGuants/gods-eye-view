import * as Cesium from 'cesium';
export {
  GAUGE_SEVERITIES,
  BAND_BY_RETURN_PERIOD,
  PROB_ALERT,
} from './records.js';

export const KENYA_GAUGE_OVERLAY_SOURCE_ID = 'kenya-river-gauges';
export const KENYA_GAUGE_OVERLAY_COHORT_LIMIT = 48;
export const KENYA_GAUGE_OVERLAY_COLLISION_CAPACITY = 32;

/** Severity → colour. Calm blue, then the GloFAS yellow/orange/red ramp. */
const SEVERITY_COLORS = Object.freeze({
  unknown: Cesium.Color.fromCssColorString('#6b7280'),
  unrated: Cesium.Color.fromCssColorString('#8fa3b8'),
  normal: Cesium.Color.fromCssColorString('#3fb9d8'),
  watch: Cesium.Color.fromCssColorString('#f2c14e'),
  moderate: Cesium.Color.fromCssColorString('#f28c28'),
  high: Cesium.Color.fromCssColorString('#e5383b'),
  severe: Cesium.Color.fromCssColorString('#9d0208'),
});

/** @param {string} severity */
export function severityColor(severity) {
  return SEVERITY_COLORS[severity] || SEVERITY_COLORS.unknown;
}

/** Rank used for label priority and cohort selection. */
export function severityRank(severity) {
  switch (severity) {
    case 'severe':
      return 4;
    case 'high':
      return 3;
    case 'moderate':
      return 2;
    case 'watch':
      return 1;
    default:
      return 0;
  }
}

/** Why a row is unrated, in card words. */
export function unratedLabel(reason) {
  switch (reason) {
    case 'no-ensemble':
      return 'ENSEMBLE UNAVAILABLE';
    case 'low-coverage':
      return 'ENSEMBLE INCOMPLETE';
    case 'cell-mismatch':
      return 'THRESHOLD CELL MISMATCH';
    default:
      return 'THRESHOLD UNAVAILABLE';
  }
}

/** Card wording for a band (Codex/Claude review, 19 Sep 2026). */
export function severityLabel(severity, unratedReason = null) {
  switch (severity) {
    case 'severe':
      return 'SEVERE FLOOD POTENTIAL';
    case 'high':
      return 'HIGH FLOOD POTENTIAL';
    case 'moderate':
      return 'MODERATE FLOOD POTENTIAL';
    case 'watch':
      return 'RIVER WATCH';
    case 'normal':
      return 'NO ELEVATED SIGNAL';
    case 'unrated':
      return unratedLabel(unratedReason);
    default:
      return 'DATA UNAVAILABLE';
  }
}

/** Short band word for stats and analyst text. */
export function severityShort(severity) {
  switch (severity) {
    case 'severe':
      return 'severe';
    case 'high':
      return 'high';
    case 'moderate':
      return 'moderate';
    case 'watch':
      return 'watch';
    case 'normal':
      return 'normal';
    case 'unrated':
      return 'unrated';
    default:
      return 'unknown';
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

/** "1-in-3-yr" style return period text. */
export function formatReturnPeriod(years) {
  if (years === Infinity) return '>1-in-100-yr';
  if (!Number.isFinite(years)) return '—';
  if (years < 1.05) return '<1-in-1-yr';
  if (years >= 100) return '>1-in-100-yr';
  return `1-in-${years >= 10 ? years.toFixed(0) : years.toFixed(1)}-yr`;
}

/** "31%" from a fraction. */
export function formatFraction(fraction) {
  if (!Number.isFinite(fraction)) return '—';
  return `${Math.round(fraction * 100)}%`;
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

function whenText(days) {
  if (days === null || days === undefined) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days}d`;
}

/** The reached level's line: "31% of 50 members peak ≥ Q2 (410 m³/s) · by tomorrow". */
export function reachedLevelText(row) {
  const level = row.levels?.find((l) => l.key === row.reachedKey);
  if (!level) return null;
  const band = level.probabilityBand ? ` (${level.probabilityBand})` : '';
  return `${formatFraction(level.fraction)} of ${level.members} members peak ≥ Q${level.returnPeriod} (${formatFlow(level.threshold, row.unit)})${band} · 30% by ${whenText(row.reachedInDays) || '—'}`;
}

/** The one-line ambient detail under a site's name. */
export function gaugeAmbientDetail(row) {
  switch (row.severity) {
    case 'unknown':
      return 'no data from GloFAS';
    case 'unrated':
      return `${unratedLabel(row.unratedReason).toLowerCase()} · upper scenario ${formatFlow(row.peak, row.unit)} ${whenText(row.peakInDays)}`;
    case 'normal':
      return `no elevated signal · peak ${formatFlow(row.medianPeak ?? row.peak, row.unit)}`;
    default: {
      const level = row.levels?.find((l) => l.key === row.reachedKey);
      const soon = row.soon ? ' · within 3 days' : '';
      return `${severityLabel(row.severity)} · ${formatFraction(level?.fraction)} ≥ Q${level?.returnPeriod} ${whenText(row.reachedInDays)}${soon}`;
    }
  }
}

/** Card lines for the click readout. Pure. */
export function gaugeReadoutDetails(row) {
  const lines = [];
  lines.push(`${row.river} · ${row.county}`);
  lines.push(
    severityLabel(row.severity) + (row.soon ? ' · WITHIN 3 DAYS' : ''),
  );
  const reached = reachedLevelText(row);
  if (reached) lines.push(reached);
  if (row.severity === 'normal' && row.levels?.length) {
    const watch = row.levels.find((l) => l.key === 'q1_5');
    lines.push(
      `${formatFraction(watch?.fraction ?? 0)} of ${watch?.members ?? row.validMembers} members peak ≥ Q1.5 (${formatFlow(watch?.threshold, row.unit)})`,
    );
  }
  lines.push(
    `Now ${formatFlow(row.current, row.unit)} · 30-day median ${formatFlow(row.baseline, row.unit)}`,
  );
  if (row.medianPeak !== null && row.medianPeak !== undefined) {
    lines.push(
      `Central peak ${formatFlow(row.medianPeak, row.unit)} (${formatReturnPeriod(row.medianPeakReturnPeriod)}) · upper ${formatFlow(row.peak, row.unit)} (${formatReturnPeriod(row.peakReturnPeriod)}) ${formatDay(row.peakDate)}`,
    );
  } else {
    lines.push(
      `Upper scenario ${formatFlow(row.peak, row.unit)} · ${formatDay(row.peakDate)}${row.unratedReason === 'no-ensemble' || row.unratedReason === 'low-coverage' ? ' · ensemble members missing' : ''}`,
    );
  }
  if (row.thresholds) {
    lines.push(
      `Q2 ${formatFlow(row.thresholds.q2, row.unit)} · Q5 ${formatFlow(row.thresholds.q5, row.unit)} · Q20 ${formatFlow(row.thresholds.q20, row.unit)} (Gumbel, ${row.thresholdPeriod?.start}–${row.thresholdPeriod?.end})`,
    );
  } else {
    lines.push('No return-level thresholds for this cell');
  }
  if (row.note) lines.push(row.note);
  lines.push(
    'GloFAS v4 via Open-Meteo · modelled 5 km cell, not a physical gauge',
  );
  return lines;
}

/**
 * Build the ambient card entry for one site.
 * @param {object} input
 * @param {object} input.row Site row.
 * @param {Cesium.Cartesian3} input.position Anchor.
 * @returns {object}
 */
export function createGaugeOverlayEntry({ row, position }) {
  const color = severityColor(row.severity);
  const level = row.levels?.find((l) => l.key === row.reachedKey);
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
      Math.round(Math.min(level?.fraction || 0, 1) * 1000),
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

/** Keep the most alarming sites first; identity breaks ties. */
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
  const level = row.levels?.find((l) => l.key === row.reachedKey) || null;
  return {
    id: String(row.id),
    name: row.name,
    river: row.river,
    county: row.county,
    lat: num(row.lat),
    lon: num(row.lon),
    severity: row.severity,
    severityLabel: severityLabel(row.severity, row.unratedReason),
    unratedReason: row.unratedReason || null,
    withinThreeDays: Boolean(row.soon),
    reachedReturnPeriod: level ? level.returnPeriod : null,
    reachedFraction: level ? num(level.fraction) : null,
    reachedProbabilityBand: level?.probabilityBand || null,
    ensembleMembers: row.validMembers ?? 0,
    currentM3s: num(row.current),
    medianM3s: num(row.baseline),
    centralPeakM3s: num(row.medianPeak),
    upperPeakM3s: num(row.peak),
    peakDate: row.peakDate || null,
    upperPeakReturnPeriodYears:
      row.peakReturnPeriod === Infinity ? 1000 : num(row.peakReturnPeriod),
    thresholdsM3s: row.thresholds || null,
  };
}

/** Count rows per band for stats lines. */
export function severityCounts(rows) {
  const counts = {};
  for (const row of rows || [])
    counts[row.severity] = (counts[row.severity] || 0) + 1;
  return counts;
}
