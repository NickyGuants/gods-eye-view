import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFloodSnapshot,
  gaugeRowFromLocation,
  severityForRatio,
  snapSitesFromProbe,
} from './records.js';
import { KENYA_GAUGE_SITES } from './sites.js';

const SITE = {
  id: 'test-river',
  name: 'Test River at Bridge',
  river: 'Test',
  county: 'Testland',
  lat: -1.0,
  lon: 36.0,
  note: 'unit test',
};

/** Build an Open-Meteo-shaped location: 5 past days, today, 4 forecast days. */
function location({
  past = [10, 12, 11, 10, 12],
  today = 13,
  future = [14, 40, 55, 30],
}) {
  const days = [...past, today, ...future];
  const time = [];
  for (let i = 0; i < days.length; i++) {
    time.push(`2026-09-${String(14 + i).padStart(2, '0')}`);
  }
  return {
    latitude: -1.025,
    longitude: 36.025,
    daily_units: { river_discharge: 'm³/s' },
    daily: {
      time,
      river_discharge: days,
      river_discharge_max: days.map((v) => v * 1.2),
      river_discharge_min: days.map((v) => v * 0.8),
      river_discharge_mean: days,
    },
  };
}

test('every bundled site is well formed and inside Kenya', () => {
  const ids = new Set();
  for (const site of KENYA_GAUGE_SITES) {
    assert.ok(site.id && !ids.has(site.id), `duplicate or empty id ${site.id}`);
    ids.add(site.id);
    assert.ok(site.lat > -5 && site.lat < 5.2, `${site.id} lat ${site.lat}`);
    assert.ok(site.lon > 33.8 && site.lon < 42, `${site.id} lon ${site.lon}`);
    assert.ok(site.name && site.river && site.county && site.note);
  }
  assert.ok(KENYA_GAUGE_SITES.length >= 20);
});

test('severity bands follow the peak-to-baseline ratio', () => {
  assert.equal(severityForRatio(1.0), 'steady');
  assert.equal(severityForRatio(1.3), 'rising');
  assert.equal(severityForRatio(2.0), 'high');
  assert.equal(severityForRatio(4.0), 'severe');
  assert.equal(severityForRatio(NaN), 'steady');
});

test('a row splits past from forecast at today and finds the ensemble peak', () => {
  const row = gaugeRowFromLocation(location({}), SITE, '2026-09-19');
  assert.equal(row.todayIso, '2026-09-19');
  assert.equal(row.baseline, 11); // median of 10,12,11,10,12
  assert.equal(row.current, 13);
  assert.equal(row.peak, 66); // 55 × 1.2 from river_discharge_max
  assert.equal(row.peakDate, '2026-09-22');
  assert.equal(row.peakInDays, 3);
  assert.equal(row.severity, 'severe');
  assert.equal(row.lat, -1.025); // the grid cell the API answered for
  assert.equal(row.requestedLat, -1.0);
  assert.equal(row.days.filter((d) => d.past).length, 5);
});

test('a near-dry channel is not shouted about because of a tiny ratio', () => {
  const row = gaugeRowFromLocation(
    location({
      past: [0.1, 0.2, 0.1, 0.1, 0.2],
      today: 0.2,
      future: [0.5, 0.9, 0.4, 0.3],
    }),
    SITE,
    '2026-09-19',
  );
  assert.equal(row.lowBaseline, true);
  assert.equal(row.severity, 'steady');
});

test('nulls in the series are tolerated', () => {
  const loc = location({});
  loc.daily.river_discharge[9] = null;
  loc.daily.river_discharge_max[9] = null;
  const row = gaugeRowFromLocation(loc, SITE, '2026-09-19');
  assert.ok(row);
  assert.equal(row.days[9].discharge, null);
});

test('normalizeFloodSnapshot accepts array and object payloads, rejects mismatches', () => {
  const single = normalizeFloodSnapshot(location({}), [SITE], {
    todayIso: '2026-09-19',
  });
  assert.equal(single.length, 1);
  const multi = normalizeFloodSnapshot(
    [location({}), location({})],
    [SITE, { ...SITE, id: 'b' }],
    {
      todayIso: '2026-09-19',
    },
  );
  assert.equal(multi.length, 2);
  assert.equal(multi[1].id, 'b');
  assert.equal(normalizeFloodSnapshot([location({})], [SITE, SITE]), null);
  assert.equal(normalizeFloodSnapshot('nope', [SITE]), null);
  assert.equal(normalizeFloodSnapshot({ daily: {} }, [SITE]), null);
});

test('snap picks the wettest neighbourhood cell per site', () => {
  const candidates = [
    { siteId: 'a', lat: 0, lon: 0 },
    { siteId: 'a', lat: 0, lon: 0.05 },
    { siteId: 'b', lat: 1, lon: 1 },
  ];
  const payload = [
    { latitude: 0, longitude: 0, daily: { river_discharge: [1, 1, 1] } },
    { latitude: 0, longitude: 0.05, daily: { river_discharge: [9, 11, null] } },
    { latitude: 1, longitude: 1, daily: { river_discharge: [2] } },
  ];
  const best = snapSitesFromProbe(payload, candidates);
  assert.equal(best.get('a').lon, 0.05);
  assert.equal(best.get('a').meanFlow, 10);
  assert.equal(best.get('b').meanFlow, 2);
  assert.equal(snapSitesFromProbe(payload.slice(0, 2), candidates), null);
});
