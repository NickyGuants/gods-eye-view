#!/usr/bin/env node
/**
 * Fetch the Kenya feeds the browser cannot read directly (no CORS header) and
 * write same-origin JSON extracts under public/data/kenya/, which the static
 * build serves next to the app. Runs in the Pages workflow on a schedule and
 * on demand locally. Every extract carries `fetchedAt` and the source URL so
 * a stale file is visibly stale, never silently "no alerts".
 *
 *   node scripts/fetch-kenya-feeds.mjs            # writes public/data/kenya/kmd-cap.json
 *
 * KMD publishes Common Alerting Protocol (CAP 1.2) alerts, registered with the
 * WMO Register of Alerting Authorities: https://meteo.go.ke/api/cap/rss.xml
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { parseKmdCapRss, parseKmdCapAlert } from '../src/layers/kmdAlerts/cap.js';

const RSS_URL = 'https://meteo.go.ke/api/cap/rss.xml';
const OUT_DIR = new URL('../public/data/kenya/', import.meta.url);
const OUT = new URL('kmd-cap.json', OUT_DIR);
const TIMEOUT_MS = 30000;

async function getText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': 'gods-eye-view-kenya-fork (github.com/NickyGuants/gods-eye-view)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

const fetchedAt = new Date().toISOString();
const alerts = [];
const skipped = [];
let error = null;
let feedBuiltAt = null;
try {
  const rss = await getText(RSS_URL);
  const feed = parseKmdCapRss(rss);
  feedBuiltAt = feed.builtAt;
  for (const item of feed.items) {
    try {
      const xml = await getText(item.link);
      const alert = parseKmdCapAlert(xml, item.link);
      if (alert) alerts.push(alert);
      else skipped.push(item.link);
    } catch (e) {
      skipped.push(item.link);
      console.error(`  skip ${item.link}: ${e.message}`);
    }
  }
} catch (e) {
  error = e.message;
  console.error(`feed failed: ${e.message}`);
}

// Never replace a good extract with a worse one: a failed or incomplete
// refresh keeps the committed file (whose fetchedAt then reads as stale).
if (error || skipped.length) {
  const kept = existsSync(OUT) ? 'kept the previous extract' : 'no previous extract to keep';
  console.error(
    `refresh incomplete (${error ? `feed: ${error}` : `${skipped.length} alert(s) unreadable`}); ${kept}`,
  );
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const doc = {
  source: RSS_URL,
  publisher: 'Kenya Meteorological Department (CAP 1.2, public domain)',
  fetchedAt,
  feedBuiltAt,
  error: null,
  alerts,
};
writeFileSync(OUT, `${JSON.stringify(doc, null, 1)}\n`);
console.error(`wrote ${alerts.length} alerts to ${OUT.pathname}`);
