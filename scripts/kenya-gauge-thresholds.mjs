#!/usr/bin/env node
/**
 * Derive flood return-level thresholds for the Kenya river sites from the
 * GloFAS v4 consolidated reanalysis served by the Open-Meteo Flood API, the
 * way GloFAS itself derives its 2-, 5- and 20-year thresholds: annual maxima
 * of daily discharge, Gumbel distribution fitted by L-moments.
 *
 * Runs offline (never in the browser: a 42-year daily series is ~300 KB per
 * cell and Open-Meteo rate-limits heavy history calls). Writes
 * src/layers/kenyaRiverGauges/thresholds.json, which the layer bundles.
 * Anyone can re-run this and diff the file.
 *
 * Usage: node scripts/kenya-gauge-thresholds.mjs [--start 1984] [--end 2025]
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { KENYA_GAUGE_SITES } from '../src/layers/kenyaRiverGauges/sites.js';
import {
  snapCandidates,
  buildFloodUrl,
  FLOOD_API_URL,
} from '../src/layers/kenyaRiverGauges/source.js';
import { snapSitesFromProbe } from '../src/layers/kenyaRiverGauges/records.js';
import { gumbelFromAnnualMaxima } from '../src/layers/kenyaRiverGauges/returnPeriods.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const START = Number(opt('start', 1997));
const END = Number(opt('end', 2024));
/** A year with fewer valid (non-null) days than this is incomplete and is dropped. */
const MIN_DAYS_PER_YEAR = 360;
const OUT = new URL('../src/layers/kenyaRiverGauges/thresholds.json', import.meta.url);
/** Partial results survive a rate-limit death; re-run to resume. */
const PARTIAL = new URL('../.kenya-thresholds.partial.json', import.meta.url);
const MODEL = 'consolidated_v4';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, attempts = 12) {
  for (let a = 0; a < attempts; a++) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    } catch (error) {
      console.error(`  ${error?.cause?.code || error?.name || 'fetch failed'}; waiting 30s`);
      await sleep(30000);
      continue;
    }
    if (res.ok) return res.json();
    const wait = res.status === 429 ? 65000 + 15000 * a : 5000;
    console.error(`  HTTP ${res.status}; waiting ${wait / 1000}s`);
    await sleep(wait);
  }
  throw new Error(`gave up on ${url.slice(0, 120)}`);
}

// 1. Snap exactly as the browser does, so thresholds belong to the same cell.
const candidates = snapCandidates(KENYA_GAUGE_SITES);
const probe = await getJson(
  buildFloodUrl(candidates, { pastDays: 30, forecastDays: 1, daily: ['river_discharge'] }),
);
const snapped = snapSitesFromProbe(probe, candidates);
if (!snapped) throw new Error('probe failed');

// 2. History per site, gently; resume from the partial file if present.
const sites = existsSync(PARTIAL)
  ? JSON.parse(readFileSync(PARTIAL, 'utf8'))
  : {};
for (const [index, site] of KENYA_GAUGE_SITES.entries()) {
  const cell = snapped.get(site.id) || { lat: site.lat, lon: site.lon };
  const done = sites[site.id];
  if (
    done &&
    done.period?.end === END &&
    done.annualMaxima?.[0]?.year === 1997 &&
    Math.abs(done.cell.lat - cell.lat) < 0.01 &&
    Math.abs(done.cell.lon - cell.lon) < 0.01
  ) {
    console.error(`[${index + 1}/${KENYA_GAUGE_SITES.length}] ${site.id} (cached)`);
    continue;
  }
  const params = new URLSearchParams({
    latitude: cell.lat.toFixed(4),
    longitude: cell.lon.toFixed(4),
    daily: 'river_discharge',
    models: MODEL,
    start_date: `${START}-01-01`,
    end_date: `${END}-12-31`,
  });
  console.error(`[${index + 1}/${KENYA_GAUGE_SITES.length}] ${site.id} @ ${cell.lat.toFixed(3)},${cell.lon.toFixed(3)}`);
  const data = await getJson(`${FLOOD_API_URL}?${params}`);
  const time = data?.daily?.time || [];
  const flow = data?.daily?.river_discharge || [];
  const byYear = new Map();
  const daysByYear = new Map();
  let valid = 0;
  time.forEach((t, i) => {
    // `Number(null)` is 0: reject missing values before any conversion.
    if (flow[i] === null || flow[i] === undefined || flow[i] === '') return;
    const v = Number(flow[i]);
    if (!Number.isFinite(v)) return;
    valid++;
    const y = t.slice(0, 4);
    byYear.set(y, Math.max(byYear.get(y) ?? -Infinity, v));
    daysByYear.set(y, (daysByYear.get(y) || 0) + 1);
  });
  const rejectedYears = [...daysByYear.entries()]
    .filter(([, days]) => days < MIN_DAYS_PER_YEAR)
    .map(([year]) => Number(year));
  const annualMaxima = [...byYear.entries()]
    .filter(([year]) => daysByYear.get(year) >= MIN_DAYS_PER_YEAR)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, max]) => ({ year: Number(year), max: Math.round(max * 100) / 100 }));
  const fit = gumbelFromAnnualMaxima(annualMaxima.map((a) => a.max));
  sites[site.id] = {
    cell: { lat: Number(data.latitude), lon: Number(data.longitude) },
    requested: { lat: site.lat, lon: site.lon },
    period: { start: START, end: END, dailyValues: valid, years: annualMaxima.length, rejectedYears },
    annualMaxima,
    gumbel: fit ? { mu: fit.mu, beta: fit.beta } : null,
    thresholds: fit ? fit.thresholds : null,
  };
  console.error(
    `    n=${annualMaxima.length} rejected=[${rejectedYears.join(',')}] first=${annualMaxima[0]?.year}` +
      (fit
        ? ` Q1.5=${fit.thresholds.q1_5.toFixed(1)} Q2=${fit.thresholds.q2.toFixed(1)} Q5=${fit.thresholds.q5.toFixed(1)} Q20=${fit.thresholds.q20.toFixed(1)}`
        : ' no fit'),
  );
  writeFileSync(PARTIAL, JSON.stringify(sites));
  await sleep(8000);
}

const doc = {
  generatedAt: new Date().toISOString(),
  method:
    'Annual maxima of GloFAS v4 consolidated daily river discharge (Open-Meteo Flood API, models=consolidated_v4), complete years only (a year needs 360 valid days; the consolidated series is null before 1997), Gumbel distribution fitted by L-moments (stationary fit); return levels are the fitted quantiles. Same method family as the CEMS GloFAS thresholds (which use 1979-2022), so these are our estimates for this period, not the official GloFAS thresholds.',
  source: 'https://open-meteo.com/en/docs/flood-api (CC BY 4.0; GloFAS © Copernicus Emergency Management Service)',
  model: MODEL,
  period: { start: START, end: END },
  sites,
};
writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
console.error(`wrote ${OUT.pathname}`);
