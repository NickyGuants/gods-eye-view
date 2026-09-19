import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gaugeRowFromLocation,
  normalizeFloodSnapshot,
  snapSitesFromProbe,
  exceedance,
  classifyEnsemble,
  PROB_ALERT,
} from './records.js';
import { KENYA_GAUGE_SITES } from './sites.js';
import { gumbelFromAnnualMaxima } from './returnPeriods.js';

const SITE = { id: 'x', name: 'X', river: 'R', county: 'C', lat: 1, lon: 2 };
const days = (n, start = '2026-09-10') =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });

/** Rating with Q1.5=100, Q2≈?, from a synthetic Gumbel(80, 20). */
function rating(cell = { lat: 1, lon: 2 }) {
  const fit = gumbelFromAnnualMaxima(
    Array.from(
      { length: 30 },
      (_, i) => 80 - 20 * Math.log(-Math.log((i + 0.56) / 30.12)),
    ),
  );
  return {
    cell,
    gumbel: { mu: fit.mu, beta: fit.beta },
    thresholds: fit.thresholds,
    period: { start: 1984, end: 2024, years: 30 },
  };
}

/** Payload with 10 past + 10 forecast days and `members` ensemble series. */
function payload({
  members = [],
  control = null,
  max = null,
  lat = 1,
  lon = 2,
} = {}) {
  const time = days(20);
  const daily = {
    time,
    river_discharge: control || time.map((_, i) => (i < 10 ? 50 : 60)),
  };
  if (max) daily.river_discharge_max = max;
  members.forEach((series, i) => {
    daily[`river_discharge_member${String(i + 1).padStart(2, '0')}`] = series;
  });
  return { latitude: lat, longitude: lon, daily };
}

test('every bundled site is well formed and inside Kenya', () => {
  const ids = new Set();
  for (const site of KENYA_GAUGE_SITES) {
    assert.ok(site.id && !ids.has(site.id));
    ids.add(site.id);
    assert.ok(site.lat > -5 && site.lat < 5.5, site.id);
    assert.ok(site.lon > 33.5 && site.lon < 42, site.id);
  }
  assert.ok(KENYA_GAUGE_SITES.length >= 20);
});

test('exceedance is the day-maximum fraction of members at or above a threshold', () => {
  const members = [
    [0, 0, 5, 9, 1],
    [0, 0, 1, 9, 1],
    [0, 0, 1, 1, 1],
    [0, 0, 1, 1, null],
  ];
  const ex = exceedance(members, 2, 9);
  assert.equal(ex.fraction, 0.5);
  assert.equal(ex.dayIndex, 3);
  assert.equal(ex.members, 4);
  assert.equal(exceedance(members, 2, 100).fraction, 0);
  assert.equal(exceedance(members, 2, 100).dayIndex, null);
});

test('classification takes the highest level reached by 30% of members', () => {
  const r = rating();
  const q = r.thresholds;
  const total = 51;
  const build = (aboveQ5, aboveQ2) =>
    Array.from({ length: total }, (_, i) => {
      const v = i < aboveQ5 ? q.q5 + 1 : i < aboveQ2 ? q.q2 + 1 : q.q1_5 - 1;
      return [0, v];
    });
  assert.equal(classifyEnsemble(build(16, 30), 1, r).severity, 'high');
  assert.equal(classifyEnsemble(build(15, 30), 1, r).severity, 'moderate');
  assert.equal(classifyEnsemble(build(0, 15), 1, r).severity, 'normal');
  assert.equal(classifyEnsemble(build(0, 0), 1, r).severity, 'normal');
  assert.equal(classifyEnsemble(build(0, 0), 1, null).severity, 'unrated');
  assert.equal(PROB_ALERT, 0.3);
});

test('a rated row with members carries level fractions, timing and the soon badge', () => {
  const r = rating();
  const q = r.thresholds;
  const members = Array.from({ length: 51 }, (_, i) =>
    days(20).map((_, d) => (d === 11 && i < 20 ? q.q2 + 5 : 30)),
  );
  const row = gaugeRowFromLocation(payload({ members }), SITE, '2026-09-20', r);
  assert.equal(row.severity, 'moderate');
  assert.equal(row.reachedKey, 'q2');
  assert.equal(row.reachedInDays, 1);
  assert.equal(row.soon, true);
  assert.equal(row.memberCount, 51);
  assert.equal(row.rated, true);
  assert.ok(
    Math.abs(row.levels.find((l) => l.key === 'q2').fraction - 20 / 51) < 1e-9,
  );
  assert.ok(row.medianPeak !== null);
  assert.ok(row.peakReturnPeriod > 1);
});

test('exceedance follows the CEMS rule: members whose window maximum crosses, timed by the 30% crossing day', () => {
  // 4 of 10 members cross: two today, one tomorrow, one on day 4; 30% of 10 = 3 members → tomorrow.
  const members = Array.from({ length: 10 }, (_, i) => [
    0,
    0,
    i < 2 ? 50 : 1,
    i === 2 ? 50 : 1,
    1,
    i === 3 ? 50 : 1,
  ]);
  const ex = exceedance(members, 2, 50);
  assert.equal(ex.fraction, 0.4);
  assert.equal(ex.members, 10);
  assert.equal(ex.dayIndex, 3);
  // Fifteen different members crossing on each of two days pool to 30 of 51.
  const pooled = Array.from({ length: 51 }, (_, i) => [
    0,
    i < 15 ? 9 : 1,
    i >= 15 && i < 30 ? 9 : 1,
  ]);
  assert.ok(Math.abs(exceedance(pooled, 1, 9).fraction - 30 / 51) < 1e-9);
});

test('sparse or all-null members never become a probability', () => {
  const r = rating();
  const q = r.thresholds;
  const mostlyNull = Array.from({ length: 50 }, (_, i) =>
    days(20).map(() => (i === 0 ? q.q20 + 1 : null)),
  );
  const row = gaugeRowFromLocation(
    payload({ members: mostlyNull }),
    SITE,
    '2026-09-20',
    r,
  );
  assert.equal(row.severity, 'unrated');
  assert.equal(row.unratedReason, 'low-coverage');
  assert.equal(row.validMembers, 1);
  const allNull = Array.from({ length: 50 }, () => days(20).map(() => null));
  const row2 = gaugeRowFromLocation(
    payload({ members: allNull }),
    SITE,
    '2026-09-20',
    r,
  );
  assert.equal(row2.severity, 'unrated');
  assert.equal(row2.unratedReason, 'low-coverage');
});

test('without ensemble members a rated row is unrated, never classified from the max', () => {
  const r = rating();
  const max = days(20).map(() => r.thresholds.q20 + 100);
  const row = gaugeRowFromLocation(payload({ max }), SITE, '2026-09-20', r);
  assert.equal(row.severity, 'unrated');
  assert.equal(row.unratedReason, 'no-ensemble');
  assert.equal(row.peak, r.thresholds.q20 + 100);
  assert.equal(row.memberCount, 0);
});

test('a returned cell that is not the threshold cell is unrated', () => {
  const r = rating({ lat: 1.05, lon: 2 });
  const members = Array.from({ length: 51 }, () => days(20).map(() => 1000));
  const row = gaugeRowFromLocation(payload({ members }), SITE, '2026-09-20', r);
  assert.equal(row.severity, 'unrated');
  assert.equal(row.unratedReason, 'cell-mismatch');
  assert.equal(row.rated, false);
});

test('all-null series are unknown, never normal', () => {
  const control = days(20).map(() => null);
  const row = gaugeRowFromLocation(
    payload({ control }),
    SITE,
    '2026-09-20',
    rating(),
  );
  assert.equal(row.severity, 'unknown');
  assert.equal(row.current, null);
  assert.equal(row.peak, null);
});

test('a row splits past from forecast at today and keeps the upper scenario', () => {
  const max = days(20).map((_, i) => (i === 15 ? 90 : 60));
  const row = gaugeRowFromLocation(payload({ max }), SITE, '2026-09-20', null);
  assert.equal(row.todayIso, '2026-09-20');
  assert.equal(row.pastDays, 10);
  assert.equal(row.baseline, 50);
  assert.equal(row.current, 60);
  assert.equal(row.peak, 90);
  assert.equal(row.peakInDays, 5);
  assert.equal(row.severity, 'unrated');
  assert.equal(row.days.length, 20);
});

test('normalizeFloodSnapshot accepts array and object payloads, rejects mismatches', () => {
  const site2 = { ...SITE, id: 'y' };
  const rows = normalizeFloodSnapshot([payload(), payload()], [SITE, site2], {
    todayIso: '2026-09-20',
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].id, 'y');
  const one = normalizeFloodSnapshot(payload(), [SITE], {
    todayIso: '2026-09-20',
  });
  assert.equal(one.length, 1);
  assert.equal(normalizeFloodSnapshot([payload()], [SITE, site2]), null);
  assert.equal(normalizeFloodSnapshot('nope', [SITE]), null);
  assert.equal(normalizeFloodSnapshot({ daily: {} }, [SITE]), null);
});

test('thresholds are matched by site id and applied through the snapshot', () => {
  const r = rating();
  const members = Array.from({ length: 51 }, () =>
    days(20).map(() => r.thresholds.q20 + 1),
  );
  const rows = normalizeFloodSnapshot([payload({ members })], [SITE], {
    todayIso: '2026-09-20',
    thresholds: { x: r },
  });
  assert.equal(rows[0].severity, 'severe');
  assert.equal(rows[0].reachedKey, 'q20');
});

test('snap picks the wettest neighbourhood cell per site', () => {
  const candidates = [
    { siteId: 'a', lat: 0, lon: 0, center: false },
    { siteId: 'a', lat: 0.05, lon: 0, center: true },
    { siteId: 'a', lat: 0.1, lon: 0, center: false },
  ];
  const probe = [
    { latitude: 0, longitude: 0, daily: { river_discharge: [1, 1] } },
    { latitude: 0.05, longitude: 0, daily: { river_discharge: [5, 5] } },
    { latitude: 0.1, longitude: 0, daily: { river_discharge: [5, 5] } },
  ];
  const best = snapSitesFromProbe(probe, candidates);
  assert.equal(best.get('a').lat, 0.05); // tie goes to the centre
  assert.equal(snapSitesFromProbe(probe.slice(1), candidates), null);
});
