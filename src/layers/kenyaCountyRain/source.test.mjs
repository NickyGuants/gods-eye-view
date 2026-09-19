import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenMeteoRainSource,
  buildForecastUrl,
  localDateIso,
  FORECAST_API_URL,
} from './source.js';
import { normalizeRainSnapshot, rainBand } from './records.js';
import { KENYA_COUNTIES } from './counties.js';

const TODAY = Date.UTC(2026, 8, 19, 9, 0, 0); // 12:00 in Nairobi

function locationFor(county, mm) {
  const time = [];
  const start = new Date('2026-09-12T00:00:00Z');
  for (let i = 0; i < mm.length; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    time.push(d.toISOString().slice(0, 10));
  }
  return {
    latitude: county.lat,
    longitude: county.lon,
    daily: {
      time,
      precipitation_sum: mm,
      precipitation_probability_max: mm.map((v) => Math.min(100, v * 2)),
    },
  };
}

test('all 47 counties are present with centroids inside Kenya', () => {
  assert.equal(KENYA_COUNTIES.length, 47);
  const names = new Set(KENYA_COUNTIES.map((c) => c.name));
  assert.ok(
    names.has('Nairobi') && names.has('Turkana') && names.has('Mombasa'),
  );
  assert.ok(names.has('Tharaka-Nithi'));
  for (const c of KENYA_COUNTIES) {
    assert.ok(c.lat > -5 && c.lat < 5.5, `${c.name} lat`);
    assert.ok(c.lon > 33.5 && c.lon < 42, `${c.name} lon`);
  }
});

test('the forecast URL asks for every centroid in one call, Nairobi time', () => {
  const url = new URL(buildForecastUrl(KENYA_COUNTIES));
  assert.equal(`${url.origin}${url.pathname}`, FORECAST_API_URL);
  assert.equal(url.searchParams.get('latitude').split(',').length, 47);
  assert.equal(url.searchParams.get('timezone'), 'Africa/Nairobi');
  assert.match(url.searchParams.get('daily'), /precipitation_sum/);
});

test('local date resolves in the Nairobi timezone', () => {
  assert.equal(localDateIso(Date.UTC(2026, 8, 19, 22, 30)), '2026-09-20');
  assert.equal(localDateIso(Date.UTC(2026, 8, 19, 9, 0)), '2026-09-19');
});

test('rain bands step with the 7-day total', () => {
  assert.equal(rainBand(3), 'dry');
  assert.equal(rainBand(20), 'light');
  assert.equal(rainBand(60), 'moderate');
  assert.equal(rainBand(120), 'heavy');
  assert.equal(rainBand(300), 'extreme');
});

test('rows sum past and future windows around today', () => {
  const county = KENYA_COUNTIES.find((c) => c.name === 'Nairobi');
  // 7 past days (12..18 Sep), then 19 Sep onward.
  const mm = [1, 2, 3, 4, 5, 6, 7, 10, 20, 30, 0, 0, 0, 0, 99, 99, 99];
  const rows = normalizeRainSnapshot([locationFor(county, mm)], [county], {
    todayIso: '2026-09-19',
  });
  const row = rows[0];
  assert.equal(row.past7Mm, 28);
  assert.equal(row.next3Mm, 60);
  assert.equal(row.next7Mm, 60);
  assert.equal(row.wettestDay, '2026-09-21');
  assert.equal(row.wettestMm, 30);
  assert.equal(row.band, 'moderate');
  assert.equal(row.todayMm, 10);
});

test('the source fetches once and normalizes; errors reject', async () => {
  const counties = KENYA_COUNTIES.slice(0, 3);
  let calls = 0;
  const source = createOpenMeteoRainSource({
    counties,
    now: () => TODAY,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () =>
          counties.map((c) =>
            locationFor(c, [0, 0, 0, 0, 0, 0, 0, 5, 5, 5, 5, 5, 5, 5, 0, 0, 0]),
          ),
      };
    },
  });
  const rows = await source.getSnapshot();
  assert.equal(calls, 1);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].next7Mm, 35);
  const failing = createOpenMeteoRainSource({
    counties,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(failing.getSnapshot(), /HTTP 503/);
});
