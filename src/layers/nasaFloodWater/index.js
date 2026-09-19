import { createGibsOverlayLayer } from '../gibsOverlay/index.js';
import {
  FLOOD_PRODUCTS,
  FLOOD_TILE_MATRIX_SET,
  FLOOD_MAX_LEVEL,
  FLOOD_DEFAULT_ALPHA,
  FLOOD_LEGEND,
  floodProductTitle,
} from './model.js';
export * from './model.js';

export const NASA_FLOOD_WATER_LAYER_ID = 'nasa-flood-water';

/**
 * Observed surface water and flood water from the NASA NRT Global Flood
 * Products (MODIS/VIIRS) on GIBS: water the satellites actually saw, not a
 * forecast. Cloud hides it; the legend says so. Daily product, re-pulled
 * hourly so the day rolls over.
 * @param {object} [options]
 * @param {string} [options.product] Key of FLOOD_PRODUCTS.
 * @param {number} [options.alpha]
 * @param {function} [options.governorRequestRender]
 * @param {function():number} [options.now]
 */
export function createNasaFloodWaterLayer({
  product = 'modis3',
  alpha = FLOOD_DEFAULT_ALPHA,
  governorRequestRender = null,
  now,
} = {}) {
  const layer = createGibsOverlayLayer({
    id: NASA_FLOOD_WATER_LAYER_ID,
    name: 'Satellite flood water (observed)',
    icon: '≈',
    sourceLabel: 'NASA GIBS · MODIS/VIIRS NRT Flood · LIVE',
    logTag: 'NasaFloodWater',
    products: FLOOD_PRODUCTS,
    defaultProduct: FLOOD_PRODUCTS[product] ? product : 'modis3',
    tileMatrixSet: FLOOD_TILE_MATRIX_SET,
    maximumLevel: FLOOD_MAX_LEVEL,
    credit:
      'Observed flood water: NASA GIBS · MODIS/VIIRS NRT Global Flood Product',
    coverage: 'Global · 250–375 m · daily composites',
    alpha,
    dated: true,
    latencyDays: 0,
    productTitle: floodProductTitle,
    governorRequestRender,
    now,
  });
  const baseStats = layer.getStats.bind(layer);
  /** Stats carry the NASA class legend so the panel never reads blue as flood. */
  layer.getStats = () => {
    const stats = baseStats();
    const legend = FLOOD_LEGEND.map((c) => c.short).join(' · ');
    return {
      ...stats,
      legend: FLOOD_LEGEND,
      status: stats.status ? `${stats.status} · ${legend}` : legend,
    };
  };
  return layer;
}
