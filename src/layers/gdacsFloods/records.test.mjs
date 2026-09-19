import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGdacsEvents, gdacsRowFromFeature, alertRank } from './records.js';
import { buildGdacsUrl } from './source.js';

const feature = (over = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [39.6, -0.45] },
  properties: {
    eventtype: 'FL',
    eventid: 1102604,
    episodeid: 3,
    name: 'Flood in Kenya',
    country: 'Kenya',
    iso3: 'KEN',
    alertlevel: 'Orange',
    alertscore: 2,
    iscurrent: 'true',
    fromdate: '2026-04-12T18:00:00',
    todate: '2026-05-06T18:00:00',
    datemodified: '2026-05-06T20:00:00',
    url: { report: 'https://www.gdacs.org/report.aspx?eventid=1102604' },
    affectedcountries: [{ iso3: 'KEN' }, { iso3: 'SOM' }],
    ...over,
  },
});

test('a GDACS feature becomes a row with dates, level and link', () => {
  const row = gdacsRowFromFeature(feature());
  assert.equal(row.id, 'FL-1102604');
  assert.equal(row.lat, -0.45);
  assert.equal(row.alertLevel, 'Orange');
  assert.equal(row.fromDate, '2026-04-12T18:00:00.000Z');
  assert.equal(row.reportUrl, 'https://www.gdacs.org/report.aspx?eventid=1102604');
  assert.deepEqual(row.affectedIso3, ['KEN', 'SOM']);
  assert.equal(gdacsRowFromFeature({ properties: {} }), null);
});

test('only East African events are kept, most alarming first; empty is [] not null', () => {
  const rows = normalizeGdacsEvents({
    type: 'FeatureCollection',
    features: [
      feature({ eventid: 1, iso3: 'IND', country: 'India', affectedcountries: [] }),
      feature({ eventid: 2, alertlevel: 'Green' }),
      feature({ eventid: 3, iso3: 'ETH', alertlevel: 'Red' }),
      feature({ eventid: 4, iso3: 'IND', affectedcountries: [{ iso3: 'UGA' }] }),
    ],
  });
  assert.deepEqual(rows.map((r) => r.eventId), [3, 4, 2]);
  assert.deepEqual(normalizeGdacsEvents({ features: [] }), []);
  assert.equal(normalizeGdacsEvents({}), null);
  assert.equal(alertRank('red'), 3);
});

test('the search URL covers the requested window', () => {
  const url = new URL(buildGdacsUrl({ now: Date.parse('2026-09-19T12:00:00Z'), days: 90 }));
  assert.equal(url.searchParams.get('eventlist'), 'FL');
  assert.equal(url.searchParams.get('fromDate'), '2026-06-21');
  assert.equal(url.searchParams.get('toDate'), '2026-09-19');
});
