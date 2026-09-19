import { createLocalGeoJsonLayer } from './localGeojsonCore.js';

// Resolved by Vite in builds and relative to this module in other consumers.
const matatuRoutesUrl = new URL(
  './local_data/kenya/matatu_routes.geojsonl',
  import.meta.url,
).href;
const floodHotspotsUrl = new URL(
  './local_data/kenya/flood_hotspots.geojsonl',
  import.meta.url,
).href;

export const KENYA_MATATU_ROUTES_LAYER_ID = 'kenya-matatu-routes';
export const KENYA_FLOOD_HOTSPOTS_LAYER_ID = 'kenya-flood-hotspots';

/**
 * Create the bundled Kenya reference layers without starting or loading them:
 * Nairobi's matatu network (Digital Matatus GTFS shapes plus termini) and the
 * flood and landslide hotspots named by KMD or recurring in past seasons.
 * @param {object} services Caller-owned context, overlay and render operations.
 * @returns {object[]} Matatu routes then hotspots, with stable identities.
 */
export function createKenyaLocalLayers(services) {
  const matatu = createLocalGeoJsonLayer(
    {
      id: KENYA_MATATU_ROUTES_LAYER_ID,
      url: matatuRoutesUrl,
      name: 'Nairobi matatu routes',
      color: '#ffb000', // Matatu amber
      icon: '⛟',
      source: 'Digital Matatus 2019',
      labels: true,
      labelMax: 200,
      labelGridPx: 120,
    },
    services,
  );

  const hotspots = createLocalGeoJsonLayer(
    {
      id: KENYA_FLOOD_HOTSPOTS_LAYER_ID,
      url: floodHotspotsUrl,
      name: 'Kenya flood hotspots',
      color: '#ff4d6d', // Alert rose
      icon: '⚠',
      source: 'KMD · past seasons',
      labels: true,
      labelMax: 60,
      labelGridPx: 110,
    },
    services,
  );

  return [matatu, hotspots];
}
