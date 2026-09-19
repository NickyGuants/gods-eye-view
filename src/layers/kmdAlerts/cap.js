/**
 * @module kmdAlerts/cap
 * @description Pure parsing of the Kenya Meteorological Department CAP 1.2
 * feed (RSS index plus one CAP alert document per item) into plain records.
 * Regex-based on purpose: the documents are small, flat and namespaced
 * `cap:`; no DOM, so the offline fetch script and tests share this.
 */

const unescapeXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Text of the first `<cap:tag>` (or `<tag>`) in a fragment, trimmed. */
export function capText(fragment, tag) {
  const m = new RegExp(`<(?:cap:)?${tag}>([\\s\\S]*?)</(?:cap:)?${tag}>`).exec(
    fragment,
  );
  return m ? unescapeXml(m[1]).replace(/\s+/g, ' ').trim() : null;
}

/** All `<cap:tag>…</cap:tag>` fragments. */
export function capBlocks(fragment, tag) {
  const out = [];
  const re = new RegExp(`<(?:cap:)?${tag}>([\\s\\S]*?)</(?:cap:)?${tag}>`, 'g');
  let m;
  while ((m = re.exec(fragment))) out.push(m[1]);
  return out;
}

/**
 * Parse the RSS index: items with title and link, plus the feed build time.
 * @param {string} xml
 * @returns {{builtAt:string|null, items:Array<{title:string,link:string}>}}
 */
export function parseKmdCapRss(xml) {
  const built = /<lastBuildDate>([^<]*)<\/lastBuildDate>/.exec(xml);
  const builtAt = built ? new Date(built[1]).toISOString() : null;
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const title = /<title>([\s\S]*?)<\/title>/.exec(m[1]);
    const link = /<link>([\s\S]*?)<\/link>/.exec(m[1]);
    if (link)
      items.push({
        title: title ? unescapeXml(title[1]).trim() : '',
        link: link[1].trim(),
      });
  }
  return { builtAt, items };
}

/** Vertices kept per ring; KMD traces county borders at survey detail. */
export const MAX_RING_VERTICES = 160;

/**
 * "lat,lon lat,lon …" → [[lon,lat], …] (GeoJSON order), closed ring, thinned
 * to at most `maxVertices` by even decimation and rounded to 3 decimals
 * (about 100 m), which is all a warning polygon needs on a globe.
 */
export function parseCapPolygon(text, maxVertices = MAX_RING_VERTICES) {
  const raw = [];
  for (const pair of String(text).trim().split(/\s+/)) {
    const [lat, lon] = pair.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) raw.push([lon, lat]);
  }
  if (raw.length < 3) return null;
  const step = Math.max(1, Math.ceil(raw.length / maxVertices));
  const ring = raw
    .filter((_, i) => i % step === 0)
    .map(([lon, lat]) => [
      Math.round(lon * 1000) / 1000,
      Math.round(lat * 1000) / 1000,
    ]);
  if (ring.length < 3) return null;
  const [f, l] = [ring[0], ring[ring.length - 1]];
  if (f[0] !== l[0] || f[1] !== l[1]) ring.push([...f]);
  return ring;
}

/** Centroid of a ring (mean of vertices; fine for county-sized areas). */
export function ringCentroid(ring) {
  const pts = ring.slice(0, -1);
  const n = pts.length || 1;
  return [
    pts.reduce((a, p) => a + p[0], 0) / n,
    pts.reduce((a, p) => a + p[1], 0) / n,
  ];
}

/**
 * Parse one CAP 1.2 alert document.
 * @param {string} xml
 * @param {string} [url] Where it came from.
 * @returns {object|null}
 */
export function parseKmdCapAlert(xml, url = null) {
  if (!/<(?:cap:)?alert[\s>]/.test(xml)) return null;
  const info = capBlocks(xml, 'info')[0] || xml;
  const areas = capBlocks(info, 'area').map((block) => {
    const polygons = capBlocks(block, 'polygon')
      .map((text) => parseCapPolygon(text))
      .filter(Boolean);
    return {
      description: capText(block, 'areaDesc'),
      polygons,
      centroid: polygons.length ? ringCentroid(polygons[0]) : null,
    };
  });
  const iso = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  // CAP references: "sender,identifier,sent" triplets, whitespace separated.
  const references = (capText(xml, 'references') || '')
    .split(/\s+/)
    .map((triplet) => triplet.split(',')[1])
    .filter(Boolean);
  return {
    identifier: capText(xml, 'identifier'),
    url,
    sent: iso(capText(xml, 'sent')),
    status: capText(xml, 'status'),
    msgType: capText(xml, 'msgType'),
    references,
    event: capText(info, 'event'),
    headline: capText(info, 'headline'),
    description: capText(info, 'description'),
    instruction: capText(info, 'instruction'),
    urgency: capText(info, 'urgency'),
    severity: capText(info, 'severity'),
    certainty: capText(info, 'certainty'),
    effective: iso(capText(info, 'effective')),
    onset: iso(capText(info, 'onset')),
    expires: iso(capText(info, 'expires')),
    web: capText(info, 'web'),
    areas,
  };
}

/** Identifiers superseded by a later Update or Cancel in the same list. */
export function supersededIdentifiers(alerts) {
  const out = new Set();
  for (const a of alerts || []) {
    if (!a || (a.msgType !== 'Update' && a.msgType !== 'Cancel')) continue;
    for (const id of a.references || []) out.add(id);
  }
  return out;
}

const ms = (iso) => (iso ? new Date(iso).getTime() : NaN);

/**
 * Alerts in force at `nowMs`: status Actual, msgType Alert or Update, not
 * superseded by a later Update/Cancel, effective (or onset, or sent) at or
 * before now, and expiry after now. A missing expiry never keeps an alert
 * alive for ever: it counts only while its `sent` is under 7 days old.
 */
export function activeAlerts(alerts, nowMs = Date.now()) {
  const superseded = supersededIdentifiers(alerts);
  return (alerts || []).filter((a) => {
    if (!a || a.status !== 'Actual') return false;
    if (a.msgType !== 'Alert' && a.msgType !== 'Update') return false;
    if (superseded.has(a.identifier)) return false;
    const start = ms(a.effective) || ms(a.onset) || ms(a.sent);
    if (Number.isFinite(start) && start > nowMs) return false;
    const end = ms(a.expires);
    if (Number.isFinite(end)) return end > nowMs;
    const sent = ms(a.sent);
    return Number.isFinite(sent) && nowMs - sent < 7 * 24 * 3600 * 1000;
  });
}

/** Actual Alert/Update messages that expired within `windowMs` before now. */
export function recentlyExpiredAlerts(
  alerts,
  nowMs = Date.now(),
  windowMs = 30 * 24 * 3600 * 1000,
) {
  return (alerts || []).filter((a) => {
    if (!a || a.status !== 'Actual') return false;
    if (a.msgType !== 'Alert' && a.msgType !== 'Update') return false;
    const end = ms(a.expires);
    if (!Number.isFinite(end)) return false;
    const age = nowMs - end;
    return age >= 0 && age < windowMs;
  });
}
