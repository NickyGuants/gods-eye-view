import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenMeteoFloodSource,
  buildFloodUrl,
  snapCandidates,
  FLOOD_API_URL,
} from './source.js';

const SITES = [
  {
    id: 'a',
    name: 'A',
    river: 'A',
    county: 'X',
    lat: -1.0,
    lon: 36.0,
    note: '',
  },
  {
    id: 'b',
    name: 'B',
    river: 'B',
    county: 'Y',
    lat: 0.5,
    lon: 34.0,
    note: '',
  },
];
const TODAY = Date.UTC(2026, 8, 19, 9, 0, 0);

function dailyFor(values, todayIso = '2026-09-19') {
  const start = new Date(`${todayIso}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 2);
  const time = values.map((_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  return { time, river_discharge: values };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

test('URLs carry every coordinate, the daily variables and both day windows', () => {
  const url = new URL(
    buildFloodUrl(SITES, {
      pastDays: 30,
      forecastDays: 10,
      daily: ['river_discharge', 'river_discharge_max'],
    }),
  );
  assert.equal(`${url.origin}${url.pathname}`, FLOOD_API_URL);
  assert.equal(url.searchParams.get('latitude'), '-1.0000,0.5000');
  assert.equal(url.searchParams.get('longitude'), '36.0000,34.0000');
  assert.equal(
    url.searchParams.get('daily'),
    'river_discharge,river_discharge_max',
  );
  assert.equal(url.searchParams.get('past_days'), '30');
  assert.equal(url.searchParams.get('forecast_days'), '10');
});

test('snap candidates are the 3×3 neighbourhood in site order', () => {
  const candidates = snapCandidates(SITES, 0.05);
  assert.equal(candidates.length, 18);
  assert.equal(candidates[0].siteId, 'a');
  assert.ok(Math.abs(candidates[0].lat - -1.05) < 1e-9);
  assert.ok(Math.abs(candidates[4].lat - -1.0) < 1e-9);
  assert.equal(candidates[9].siteId, 'b');
});

test('first snapshot probes, snaps to the wettest cell, caches, then fetches rows', async () => {
  const calls = [];
  const cache = new Map();
  const fetchImpl = async (url) => {
    calls.push(new URL(url));
    const lat = calls.at(-1).searchParams.get('latitude').split(',');
    if (lat.length === 18) {
      // Probe: make the north-east neighbour of "a" the river cell.
      return jsonResponse(
        lat.map((value, index) => ({
          latitude: Number(value),
          longitude: Number(
            calls.at(-1).searchParams.get('longitude').split(',')[index],
          ),
          daily: { river_discharge: index === 8 ? [50, 60] : [1, 1] },
        })),
      );
    }
    return jsonResponse(
      lat.map((value) => ({
        latitude: Number(value),
        daily: dailyFor([10, 10, 12, 30, 50]),
      })),
    );
  };
  const source = createOpenMeteoFloodSource({
    fetchImpl,
    sites: SITES,
    now: () => TODAY,
    cache: {
      get: (k) => cache.get(k) ?? null,
      set: (k, v) => cache.set(k, v),
    },
  });
  const rows = await source.getSnapshot();
  assert.equal(calls.length, 3, 'probe, control run, ensemble members');
  assert.equal(calls[2].searchParams.get('ensemble'), 'true');
  assert.equal(calls[2].searchParams.get('past_days'), '0');
  assert.equal(rows.length, 2);
  const snapped = source.getSnappedSites();
  assert.ok(Math.abs(snapped.get('a').lat - -0.95) < 1e-9, 'snapped north');
  assert.ok(Math.abs(snapped.get('a').lon - 36.05) < 1e-9, 'snapped east');
  assert.equal(snapped.get('b').lat, 0.5, 'unchanged when no cell stands out');
  assert.equal(cache.size, 1, 'snap persisted');

  await source.getSnapshot();
  assert.equal(calls.length, 5, 'second snapshot does not re-probe');

  const warm = createOpenMeteoFloodSource({
    fetchImpl,
    sites: SITES,
    now: () => TODAY,
    cache: {
      get: (k) => cache.get(k) ?? null,
      set: (k, v) => cache.set(k, v),
    },
  });
  await warm.getSnapshot();
  assert.equal(calls.length, 7, 'a fresh source reads the cached snap');
});

test('a failed probe falls back to the raw sites instead of failing', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return { ok: false, status: 500 };
    return jsonResponse(
      SITES.map((site) => ({
        latitude: site.lat,
        daily: dailyFor([1, 2, 3, 4, 5]),
      })),
    );
  };
  const source = createOpenMeteoFloodSource({
    fetchImpl,
    sites: SITES,
    now: () => TODAY,
  });
  const rows = await source.getSnapshot();
  assert.equal(rows.length, 2);
  assert.equal(source.getSnappedSites().get('a').lat, -1.0);
});

test('HTTP errors and malformed bodies reject', async () => {
  const bad = createOpenMeteoFloodSource({
    fetchImpl: async () => ({ ok: false, status: 429 }),
    sites: SITES,
    snap: false,
  });
  await assert.rejects(bad.getSnapshot(), /HTTP 429/);
  const malformed = createOpenMeteoFloodSource({
    fetchImpl: async () => jsonResponse({ nope: true }),
    sites: SITES,
    snap: false,
  });
  await assert.rejects(malformed.getSnapshot(), /Malformed/);
});

test('an aborted signal rejects before any network call', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const source = createOpenMeteoFloodSource({
    fetchImpl: async () => {
      called = true;
      return jsonResponse([]);
    },
    sites: SITES,
  });
  await assert.rejects(source.getSnapshot({ signal: controller.signal }));
  assert.equal(called, false);
});
