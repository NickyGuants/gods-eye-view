import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKmdCapRss,
  parseKmdCapAlert,
  parseCapPolygon,
  activeAlerts,
  recentlyExpiredAlerts,
  supersededIdentifiers,
} from './cap.js';

const RSS = `<?xml version="1.0"?><rss><channel><lastBuildDate>Thu, 07 May 2026 14:45:00 +0000</lastBuildDate>
<item><title>Heavy Rainfall Advisory</title><link>https://meteo.go.ke/api/cap/a.xml</link></item>
<item><title>Large Waves</title><link>https://meteo.go.ke/api/cap/b.xml</link></item></channel></rss>`;

const CAP = `<?xml version='1.0'?><cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"><cap:identifier>urn:oid:1</cap:identifier><cap:sent>2026-05-07T17:45:00+03:00</cap:sent><cap:status>Actual</cap:status><cap:msgType>Alert</cap:msgType><cap:info><cap:event>Heavy rainfall</cap:event><cap:urgency>Expected</cap:urgency><cap:severity>Moderate</cap:severity><cap:certainty>Likely</cap:certainty><cap:effective>2026-05-07T18:00:00+03:00</cap:effective><cap:expires>2026-05-14T19:00:00+03:00</cap:expires><cap:headline>Heavy Rainfall Advisory</cap:headline><cap:description>Rain &amp; more rain
over two lines.</cap:description><cap:web>https://meteo.go.ke/weather-warnings/</cap:web><cap:area><cap:areaDesc>Migori</cap:areaDesc><cap:polygon>-0.6,34.6 -0.7,34.6 -0.7,34.5 -0.6,34.5</cap:polygon></cap:area><cap:area><cap:areaDesc>Coast</cap:areaDesc></cap:area></cap:info></cap:alert>`;

test('rss index lists items and build time', () => {
  const feed = parseKmdCapRss(RSS);
  assert.equal(feed.builtAt, '2026-05-07T14:45:00.000Z');
  assert.deepEqual(feed.items.map((i) => i.title), ['Heavy Rainfall Advisory', 'Large Waves']);
  assert.equal(feed.items[1].link, 'https://meteo.go.ke/api/cap/b.xml');
});

test('a CAP alert parses with areas, polygons in GeoJSON order, and ISO times', () => {
  const a = parseKmdCapAlert(CAP, 'https://x/a.xml');
  assert.equal(a.identifier, 'urn:oid:1');
  assert.equal(a.event, 'Heavy rainfall');
  assert.equal(a.severity, 'Moderate');
  assert.equal(a.sent, '2026-05-07T14:45:00.000Z');
  assert.equal(a.expires, '2026-05-14T16:00:00.000Z');
  assert.equal(a.description, 'Rain & more rain over two lines.');
  assert.equal(a.areas.length, 2);
  assert.equal(a.areas[0].description, 'Migori');
  assert.deepEqual(a.areas[0].polygons[0][0], [34.6, -0.6]);
  assert.equal(a.areas[0].polygons[0].length, 5); // closed
  assert.ok(Math.abs(a.areas[0].centroid[1] + 0.65) < 1e-9);
  assert.equal(a.areas[1].polygons.length, 0);
  assert.equal(a.areas[1].centroid, null);
  assert.equal(parseKmdCapAlert('<rss/>'), null);
});

test('polygons are thinned to the vertex budget and rounded', () => {
  const text = Array.from({ length: 1000 }, (_, i) => `${(i / 1000).toFixed(5)},34.123456`).join(' ');
  const ring = parseCapPolygon(text, 100);
  assert.ok(ring.length <= 102);
  assert.equal(ring[0][0], 34.123);
  assert.equal(parseCapPolygon('1,2 3,4'), null);
});

test('active alerts are Actual Alert/Update, effective, unexpired and not superseded', () => {
  const now = Date.parse('2026-05-10T00:00:00Z');
  const alerts = [
    { identifier: 'a', status: 'Actual', msgType: 'Alert', effective: '2026-05-07T00:00:00Z', expires: '2026-05-14T00:00:00Z' },
    { identifier: 'b', status: 'Actual', msgType: 'Alert', effective: '2026-04-20T00:00:00Z', expires: '2026-05-01T00:00:00Z' },
    { identifier: 'c', status: 'Actual', msgType: 'Cancel', references: ['a'], expires: '2026-05-14T00:00:00Z' },
    { identifier: 'd', status: 'Test', msgType: 'Alert', expires: null },
    { identifier: 'e', status: 'Actual', msgType: 'Update', sent: '2026-05-09T00:00:00Z', expires: null },
    { identifier: 'f', status: 'Actual', msgType: 'Alert', effective: '2026-05-12T00:00:00Z', expires: '2026-05-20T00:00:00Z' },
    { identifier: 'g', status: 'Actual', msgType: 'Alert', sent: '2026-04-01T00:00:00Z', expires: null },
  ];
  assert.deepEqual(supersededIdentifiers(alerts), new Set(['a']));
  assert.deepEqual(activeAlerts(alerts, now).map((a) => a.identifier), ['e']);
  assert.deepEqual(recentlyExpiredAlerts(alerts, now).map((a) => a.identifier), ['b']);
});

test('references parse into superseded identifiers', () => {
  const xml = CAP.replace('<cap:msgType>Alert</cap:msgType>', '<cap:msgType>Update</cap:msgType><cap:references>director@meteo.go.ke,urn:oid:0,2026-05-06T00:00:00+03:00 director@meteo.go.ke,urn:oid:9,2026-05-06T00:00:00+03:00</cap:references>');
  const a = parseKmdCapAlert(xml);
  assert.deepEqual(a.references, ['urn:oid:0', 'urn:oid:9']);
  assert.deepEqual(parseKmdCapAlert(CAP).references, []);
});
