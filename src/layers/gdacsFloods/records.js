/**
 * @module gdacsFloods/records
 * @description Pure normalization of GDACS event-list GeoJSON (flood events)
 * into plain alert rows for East Africa. No fetch, no Cesium.
 * GDACS: Global Disaster Alert and Coordination System (EC JRC / UN OCHA).
 */

/** ISO3 codes we keep: Kenya and the basins it shares. */
export const EAST_AFRICA_ISO3 = Object.freeze([
  'KEN',
  'UGA',
  'TZA',
  'ETH',
  'SOM',
  'SSD',
  'RWA',
  'BDI',
]);

/** GDACS alert level → rank. */
export function alertRank(level) {
  switch (String(level || '').toLowerCase()) {
    case 'red':
      return 3;
    case 'orange':
      return 2;
    case 'green':
      return 1;
    default:
      return 0;
  }
}

/** GDACS stamps are UTC without a zone designator; say so before parsing. */
function iso(value) {
  if (!value) return null;
  const text = String(value);
  const zoned = /[zZ]$|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`;
  const d = new Date(zoned);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {object} feature One GeoJSON feature from the GDACS event list.
 * @returns {object|null}
 */
export function gdacsRowFromFeature(feature) {
  const p = feature?.properties;
  const g = feature?.geometry;
  if (!p || g?.type !== 'Point' || !Array.isArray(g.coordinates)) return null;
  const [lon, lat] = g.coordinates.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const iso3 = String(p.iso3 || '').toUpperCase();
  const affected = Array.isArray(p.affectedcountries)
    ? p.affectedcountries.map((c) => String(c?.iso3 || '').toUpperCase())
    : [];
  return {
    id: `${p.eventtype || 'FL'}-${p.eventid}`,
    eventId: Number(p.eventid),
    episodeId: Number(p.episodeid) || null,
    name: String(p.name || p.eventname || 'Flood'),
    country: String(p.country || ''),
    iso3,
    affectedIso3: affected,
    alertLevel: String(p.alertlevel || p.episodealertlevel || 'Green'),
    alertScore: Number(p.alertscore) || 0,
    current: String(p.iscurrent) === 'true',
    fromDate: iso(p.fromdate),
    toDate: iso(p.todate),
    modified: iso(p.datemodified),
    severityText: p.severitydata?.severitytext || null,
    reportUrl: p.url?.report || null,
    lat,
    lon,
  };
}

/**
 * Normalize an event list to East African flood rows, most alarming first.
 * @param {object} payload GeoJSON FeatureCollection.
 * @param {{iso3?:string[]}} [options]
 * @returns {object[]|null} null on a malformed payload; [] when nothing matches.
 */
export function normalizeGdacsEvents(
  payload,
  { iso3 = EAST_AFRICA_ISO3 } = {},
) {
  const features = payload?.features;
  if (!Array.isArray(features)) return null;
  const keep = new Set(iso3);
  const rows = [];
  for (const feature of features) {
    const row = gdacsRowFromFeature(feature);
    if (!row) continue;
    if (!keep.has(row.iso3) && !row.affectedIso3.some((c) => keep.has(c)))
      continue;
    rows.push(row);
  }
  rows.sort(
    (a, b) =>
      alertRank(b.alertLevel) - alertRank(a.alertLevel) ||
      String(b.modified || '').localeCompare(String(a.modified || '')),
  );
  return rows;
}
