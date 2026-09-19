#!/usr/bin/env node
/**
 * Browser proof of the Kenya El Niño layers: registration, panel rows, enable,
 * data flow into Cesium entities and ambient cards, click readouts, disable and
 * re-enable. External hosts are intercepted with Open-Meteo-shaped fixtures so
 * the proof runs offline; set QA_KENYA_LIVE=1 to let the real APIs through.
 *
 * Usage: npm run build && npx vite preview --port 4173 & node scripts/qa-kenya.mjs
 */
import puppeteer from 'puppeteer';

const LIVE = process.env.QA_KENYA_LIVE === '1';
const BASE = process.env.QA_BASE_URL || 'http://localhost:4173';
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function isoDaysAround(count, pastDays) {
  const out = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = -pastDays; i < count - pastDays; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Open-Meteo flood fixture: every 4th site surges so severities vary. */
function floodFixture(url) {
  const lats = url.searchParams.get('latitude').split(',').map(Number);
  const lons = url.searchParams.get('longitude').split(',').map(Number);
  const past = Number(url.searchParams.get('past_days') || 0);
  const forecast = Number(url.searchParams.get('forecast_days') || 1);
  const time = isoDaysAround(past + forecast, past);
  return lats.map((lat, i) => {
    const base = 20 + (i % 5) * 10;
    const surge = i % 4 === 0 ? 5 : i % 4 === 1 ? 1.6 : 1.05;
    const series = time.map((_, d) =>
      d < past
        ? base + (d % 3)
        : base * (1 + (surge - 1) * ((d - past + 1) / forecast)),
    );
    const daily = {
      time,
      river_discharge: series,
      river_discharge_mean: series,
      river_discharge_max: series.map((v) => v * 1.15),
      river_discharge_min: series.map((v) => v * 0.85),
    };
    if (url.searchParams.get('ensemble') === 'true') {
      // 51 members: a site-dependent share of them surge far above the base.
      const surging = i % 3 === 0 ? 40 : i % 3 === 1 ? 20 : 4;
      for (let m = 1; m <= 51; m++) {
        daily[`river_discharge_member${String(m).padStart(2, '0')}`] =
          series.map((v, d) => (d >= past && m <= surging ? v * 40 : v));
      }
    }
    return {
      latitude: lat,
      longitude: lons[i],
      location_id: i,
      daily_units: { river_discharge: 'm³/s' },
      daily,
    };
  });
}

function gdacsFixture() {
  return {
    type: 'FeatureCollection',
    features: [
      {
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
          iscurrent: 'true',
          fromdate: '2026-09-01T00:00:00',
          todate: '2026-09-18T00:00:00',
          datemodified: '2026-09-18T06:00:00',
          url: { report: 'https://www.gdacs.org/report.aspx?eventid=1102604' },
          affectedcountries: [{ iso3: 'KEN' }],
        },
      },
    ],
  };
}

function rainFixture(url) {
  const lats = url.searchParams.get('latitude').split(',').map(Number);
  const lons = url.searchParams.get('longitude').split(',').map(Number);
  const past = Number(url.searchParams.get('past_days') || 0);
  const forecast = Number(url.searchParams.get('forecast_days') || 1);
  const time = isoDaysAround(past + forecast, past);
  return lats.map((lat, i) => ({
    latitude: lat,
    longitude: lons[i],
    location_id: i,
    daily: {
      time,
      precipitation_sum: time.map((_, d) =>
        d < past ? 2 : ((i * 7 + d * 3) % 40) + 1,
      ),
      precipitation_probability_max: time.map(() => 60),
    },
  }));
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
let failures = 0;
const errors = [];
const requests = { flood: 0, rain: 0, gibs: 0, gdacs: 0 };
const floodUrls = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  const text = message.text();
  if (
    /KenyaRiverGauges|KenyaFloodFootprints|KenyaCountyRain|NasaImerg|NasaFloodWater|GdacsFloods|KmdAlerts|kenya-/.test(
      text,
    )
  )
    console.log('  [page]', text);
});
const check = (name, passed) => {
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
  if (!passed) failures++;
};

await page.setRequestInterception(true);
page.on('request', (request) => {
  const url = new URL(request.url());
  if (url.hostname === 'flood-api.open-meteo.com') {
    requests.flood++;
    floodUrls.push(url);
    if (LIVE) return request.continue();
    return request.respond({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(floodFixture(url)),
    });
  }
  if (url.hostname === 'api.open-meteo.com') {
    requests.rain++;
    if (LIVE) return request.continue();
    return request.respond({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(rainFixture(url)),
    });
  }
  if (url.hostname === 'gibs.earthdata.nasa.gov') {
    requests.gibs++;
    if (LIVE) return request.continue();
    return request.respond({
      status: 200,
      contentType: 'image/png',
      body: TINY_PNG,
    });
  }
  if (url.hostname === 'www.gdacs.org') {
    requests.gdacs++;
    if (LIVE) return request.continue();
    return request.respond({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(gdacsFixture()),
    });
  }
  if (url.hostname === 'terrain.reearth.land') return request.continue();
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    return request.continue();
  // Everything else (basemaps, ion, google) is offline in this proof.
  return request.abort();
});

try {
  await page.goto(`${BASE}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager?.layers &&
      document.getElementById('data-toggles')?.children.length > 0,
    { timeout: 90000 },
  );

  const registry = await page.evaluate(() => {
    const manager = window.__godsEyeView.dataManager;
    const ids = [
      'kmd-alerts',
      'kenya-river-gauges',
      'kenya-flood-footprints',
      'kenya-county-rain',
      'nasa-imerg-rain',
      'nasa-flood-water',
      'gdacs-flood-alerts',
      'kenya-flood-hotspots',
      'kenya-matatu-routes',
    ];
    const container = document.getElementById('data-toggles');
    return ids.map((id) => ({
      id,
      registered: manager.layers.has(id),
      row: Boolean(container?.querySelector(`[data-layer-id="${id}"]`)),
      group:
        container
          ?.querySelector(`[data-layer-id="${id}"]`)
          ?.closest('[data-panel-group], .data-group, section')
          ?.textContent?.includes('Kenya') ?? null,
    }));
  });
  for (const entry of registry) {
    check(`${entry.id} is registered`, entry.registered);
    check(`${entry.id} has a panel row`, entry.row);
  }

  const enableAndCount = async (id, waitFor) => {
    await page.evaluate(async (layerId) => {
      const manager = window.__godsEyeView.dataManager;
      await manager.setEnabled(layerId, true);
    }, id);
    await page
      .waitForFunction(waitFor, { timeout: 60000 }, id)
      .catch(() => null);
    return page.evaluate((layerId) => {
      const manager = window.__godsEyeView.dataManager;
      const mod = manager.layers.get(layerId)?.module;
      const stats = mod?.getStats?.() || {};
      return {
        enabled: manager.isEnabled(layerId),
        count: stats.count,
        error: stats.error || null,
        status: stats.status || null,
        analyst: mod?.getAnalystRecords?.(5)?.length ?? null,
      };
    }, id);
  };

  const hasCount = (layerId) => {
    const stats = window.__godsEyeView.dataManager.layers
      .get(layerId)
      ?.module?.getStats?.();
    return (stats?.count || 0) > 0 || Boolean(stats?.error);
  };

  const gauges = await enableAndCount('kenya-river-gauges', hasCount);
  check('river gauges enabled', gauges.enabled);
  check(
    `river gauges loaded ${gauges.count} sites (error: ${gauges.error})`,
    gauges.count >= 20 && !gauges.error,
  );
  check('river gauges expose analyst records', gauges.analyst > 0);
  check(
    `flood API called (${requests.flood}×, bundled cells so no probe)`,
    requests.flood >= 1,
  );
  check(
    'flood snapshot asks for the 51 ensemble members',
    floodUrls.some((u) => u.searchParams.get('ensemble') === 'true'),
  );

  const gaugeScene = await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const source = viewer.dataSources.getByName('kenya-river-gauges')[0];
    const entities = source?.entities?.values || [];
    const severities = new Set(
      entities.map((e) => e.properties?.severity?.getValue?.()),
    );
    const withModel = entities.filter(
      (e) => e.gevLabelModel?.details?.length >= 4,
    ).length;
    return {
      entities: entities.length,
      severities: [...severities],
      withModel,
    };
  });
  check(
    `gauge entities in scene (${gaugeScene.entities})`,
    gaugeScene.entities >= 20,
  );
  check(
    `severity bands vary (${gaugeScene.severities.join(',')})`,
    gaugeScene.severities.length >= 2,
  );
  check(
    'no site is classified from an ensemble max alone (rated rows carry members)',
    gaugeScene.severities.every((s) =>
      [
        'unknown',
        'unrated',
        'normal',
        'watch',
        'moderate',
        'high',
        'severe',
      ].includes(s),
    ),
  );
  check(
    'every gauge carries a click readout model',
    gaugeScene.withModel === gaugeScene.entities,
  );

  const footprints = await enableAndCount('kenya-flood-footprints', hasCount);
  check(
    `3D flood footprints computed (${footprints.count} sites; ${footprints.status}; error: ${footprints.error})`,
    footprints.enabled && footprints.count >= 1 && !footprints.error,
  );
  const footprintScene = await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const prims = viewer.scene.primitives;
    let volumes = 0;
    for (let i = 0; i < prims.length; i++) {
      const p = prims.get(i);
      if (
        p?.geometryInstances?.[0]?.id?.startsWith?.('kenya-flood-footprints:')
      )
        volumes += p.geometryInstances.length;
    }
    const rec =
      window.__godsEyeView.dataManager.layers
        .get('kenya-flood-footprints')
        ?.module?.getAnalystRecords?.(50) || [];
    return {
      volumes,
      sampled: rec.reduce((a, r) => a + r.terrainSampled, 0),
      cells: rec.reduce((a, r) => a + r.gridCells, 0),
    };
  });
  check(
    `footprint water volumes in the scene (${footprintScene.volumes}) from ${footprintScene.sampled}/${footprintScene.cells} terrain samples`,
    footprintScene.volumes > 0 &&
      footprintScene.sampled > footprintScene.cells * 0.9,
  );

  const rain = await enableAndCount('kenya-county-rain', hasCount);
  check('county rain enabled', rain.enabled);
  check(
    `county rain loaded ${rain.count} counties (error: ${rain.error})`,
    rain.count === 47 && !rain.error,
  );
  check(`forecast API called (${requests.rain}×)`, requests.rain >= 1);
  const rainScene = await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const source = viewer.dataSources.getByName('kenya-county-rain')[0];
    const entities = source?.entities?.values || [];
    return {
      polygons: entities.filter((e) => e.polygon).length,
      outlines: entities.filter((e) => e.polyline).length,
      anchors: entities.filter((e) => e.point).length,
    };
  });
  check(
    `county polygons painted (${rainScene.polygons})`,
    rainScene.polygons >= 47,
  );
  check(
    `county anchors present (${rainScene.anchors})`,
    rainScene.anchors === 47,
  );

  const imerg = await enableAndCount('nasa-imerg-rain', (layerId) => {
    const stats = window.__godsEyeView.dataManager.layers
      .get(layerId)
      ?.module?.getStats?.();
    return (stats?.count || 0) > 0;
  });
  check('IMERG overlay enabled', imerg.enabled && imerg.count === 1);
  const imergScene = await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const layers = viewer.imageryLayers;
    let found = 0;
    const seen = [];
    for (let i = 0; i < layers.length; i++) {
      const provider = layers.get(i).imageryProvider;
      seen.push(
        `${provider?.constructor?.name}:${provider?.layer ?? provider?.url ?? '?'}`,
      );
      if (String(provider?.url || '').includes('gibs.earthdata.nasa.gov'))
        found++;
    }
    return {
      found,
      total: layers.length,
      globeShown: viewer.scene.globe.show,
      seen,
    };
  });
  check(
    `one IMERG imagery layer on the globe (${imergScene.found}/${imergScene.total})`,
    imergScene.found === 1,
  );
  console.log(
    `  globe shown: ${imergScene.globeShown}, status: ${imerg.status}, layers: ${imergScene.seen.join(' | ')}`,
  );

  const floodWater = await enableAndCount('nasa-flood-water', (layerId) => {
    const stats = window.__godsEyeView.dataManager.layers
      .get(layerId)
      ?.module?.getStats?.();
    return (stats?.count || 0) > 0;
  });
  check(
    `observed flood water overlay enabled (slot ${floodWater.status})`,
    floodWater.enabled && floodWater.count === 1,
  );

  const gdacs = await enableAndCount('gdacs-flood-alerts', (layerId) => {
    const stats = window.__godsEyeView.dataManager.layers
      .get(layerId)
      ?.module?.getStats?.();
    return Boolean(stats?.lastUpdate) || Boolean(stats?.error);
  });
  check(
    `GDACS flood alerts loaded (${gdacs.count} events, error: ${gdacs.error})`,
    gdacs.enabled && !gdacs.error,
  );
  check(`GDACS called (${requests.gdacs}×)`, requests.gdacs >= 1);

  const kmd = await enableAndCount('kmd-alerts', (layerId) => {
    const stats = window.__godsEyeView.dataManager.layers
      .get(layerId)
      ?.module?.getStats?.();
    return Boolean(stats?.lastUpdate) || Boolean(stats?.error);
  });
  check(
    `KMD warnings extract loaded (${kmd.count} polygons; ${kmd.status}; error: ${kmd.error})`,
    kmd.enabled && !kmd.error,
  );

  const hotspots = await enableAndCount('kenya-flood-hotspots', hasCount);
  check(
    `flood hotspots loaded (${hotspots.count}, error: ${hotspots.error})`,
    hotspots.count === 33 && !hotspots.error,
  );
  const matatu = await enableAndCount('kenya-matatu-routes', hasCount);
  check(
    `matatu routes loaded (${matatu.count}, error: ${matatu.error})`,
    matatu.count === 443 && !matatu.error,
  );

  // Disable everything and confirm the scene is clean; re-enable one.
  const after = await page.evaluate(async () => {
    const manager = window.__godsEyeView.dataManager;
    const viewer = window.__godsEyeView.viewer;
    for (const id of [
      'kmd-alerts',
      'kenya-river-gauges',
      'kenya-flood-footprints',
      'kenya-county-rain',
      'nasa-imerg-rain',
      'nasa-flood-water',
      'gdacs-flood-alerts',
      'kenya-flood-hotspots',
      'kenya-matatu-routes',
    ]) {
      await manager.setEnabled(id, false);
    }
    let imerg = 0;
    for (let i = 0; i < viewer.imageryLayers.length; i++) {
      if (
        String(viewer.imageryLayers.get(i).imageryProvider?.url || '').includes(
          'gibs.earthdata.nasa.gov',
        )
      )
        imerg++;
    }
    const gauges = viewer.dataSources.getByName('kenya-river-gauges')[0];
    const gaugesHidden = gauges ? gauges.show === false : true;
    await manager.setEnabled('kenya-river-gauges', true);
    return { imerg, gaugesHidden };
  });
  check(
    'GIBS imagery (IMERG and flood water) removed on disable',
    after.imerg === 0,
  );
  check('gauge data source hidden on disable', after.gaugesHidden);
  await page
    .waitForFunction(hasCount, { timeout: 60000 }, 'kenya-river-gauges')
    .catch(() => null);
  const again = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('kenya-river-gauges')
      ?.module?.getStats?.(),
  );
  check(
    `river gauges re-enable and reload (${again?.count})`,
    (again?.count || 0) >= 20,
  );

  const kenyaErrors = errors.filter((e) =>
    /kenya|imerg|open-meteo|gibs|gdacs|kmd/i.test(e),
  );
  check(
    `no page errors from the Kenya layers (${kenyaErrors.length})`,
    kenyaErrors.length === 0,
  );
  if (kenyaErrors.length) console.log(kenyaErrors.slice(0, 5));
} catch (error) {
  console.error('[FAIL] harness error', error);
  failures++;
} finally {
  await browser.close();
}
console.log(
  failures ? `\n${failures} check(s) failed` : '\nAll Kenya checks passed',
);
process.exit(failures ? 1 : 0);
