#!/usr/bin/env node
/**
 * Render the Kenya layers from an oblique camera in headless Chrome and save
 * a PNG, with the footprint records printed so the picture can be checked
 * against numbers. Live data (no fixtures).
 *
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/shot-kenya-3d.mjs --out docs/media/kenya-flood-footprint-3d.png \
 *     --view '{"lat":0.06,"lon":33.98,"height":9000,"heading":35,"pitch":-32}' \
 *     --layers kenya-river-gauges,kenya-flood-footprints,nasa-flood-water
 */
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BASE = process.env.QA_BASE_URL || 'http://localhost:4173';
const OUT = opt('out', 'kenya-3d.png');
const view = JSON.parse(
  opt('view', '{"lat":0.06,"lon":33.98,"height":9000,"heading":35,"pitch":-32}'),
);
const layers = opt('layers', 'kenya-river-gauges,kenya-flood-footprints,nasa-flood-water').split(',');

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const log = [];
page.on('console', (m) => {
  const t = m.text();
  if (/Footprints|Gauges|error/i.test(t)) log.push(t);
});
try {
  await page.goto(`${BASE}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager?.layers &&
      document.getElementById('data-toggles')?.children.length > 0,
    { timeout: 120000 },
  );
  for (const id of layers)
    await page.evaluate((l) => window.__godsEyeView.dataManager.setEnabled(l, true), id);
  if (layers.includes('kenya-flood-footprints')) {
    await page
      .waitForFunction(
        () =>
          (window.__godsEyeView.dataManager.layers
            .get('kenya-flood-footprints')
            ?.module?.getStats?.()?.count || 0) > 0 ||
          Boolean(
            window.__godsEyeView.dataManager.layers
              .get('kenya-flood-footprints')
              ?.module?.getStats?.()?.error,
          ),
        { timeout: 300000 },
      )
      .catch(() => log.push('footprints wait timeout'));
  }
  await page.evaluate((v) => {
    const viewer = window.__godsEyeView.viewer;
    viewer.camera.cancelFlight?.();
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.height),
      orientation: {
        heading: Cesium.Math.toRadians(v.heading),
        pitch: Cesium.Math.toRadians(v.pitch),
        roll: 0,
      },
    });
  }, view);
  for (let i = 0; i < 25; i++) {
    await page.evaluate(() => window.__godsEyeView.requestRender?.());
    await new Promise((r) => setTimeout(r, 1000));
  }
  const out = await page.evaluate(() => {
    const m = window.__godsEyeView.dataManager;
    const f = m.layers.get('kenya-flood-footprints')?.module;
    const g = m.layers.get('kenya-river-gauges')?.module;
    return {
      footprints: f?.getStats?.(),
      gauges: g?.getStats?.(),
      records: f?.getAnalystRecords?.(30) || [],
    };
  });
  await page.screenshot({ path: OUT, type: 'png' });
  console.log(JSON.stringify({ out: OUT, footprints: out.footprints, gauges: out.gauges, log }, null, 1));
  for (const r of out.records) {
    console.log(
      `${r.name.padEnd(36)} ch ${r.channelHeightM} m · Q2 ${Math.round(r.bankfullM3s || 0)} · central ${r.centralPeakM3s?.toFixed?.(0) ?? '—'} → ${r.centralFloodedHa} ha (max ${r.centralMaxDepthM ?? '—'} m) · upper ${Math.round(r.upperPeakM3s || 0)} → ${r.upperFloodedHa} ha (max ${r.upperMaxDepthM} m)${r.clipped ? ' · clipped' : ''} · terrain ${r.terrainSampled}/${r.gridCells}`,
    );
  }
} finally {
  await browser.close();
}
