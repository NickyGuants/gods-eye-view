/**
 * @module nasaFloodWater/model
 * @description Constants for the NASA observed-flood overlay (MODIS and VIIRS
 * NRT Global Flood Products via GIBS). No Cesium so the tests stay plain.
 */

/** GIBS identifiers. MODIS 250 m, VIIRS 375 m; composites of 1, 2 or 3 days. */
export const FLOOD_PRODUCTS = Object.freeze({
  modis3: 'MODIS_Combined_Flood_3-Day',
  modis2: 'MODIS_Combined_Flood_2-Day',
  viirs3: 'VIIRS_Combined_Flood_3-Day',
  viirs1: 'VIIRS_Combined_Flood_1-Day',
});

export const FLOOD_TILE_MATRIX_SET = 'GoogleMapsCompatible_Level9';
export const FLOOD_MAX_LEVEL = 9;
export const FLOOD_DEFAULT_ALPHA = 0.85;

/**
 * Colour classes of the NASA flood products, as the GIBS colormap
 * (MODIS_Flood.xml, values 1/2/3/255) draws them. Shown on the panel so
 * nobody reads cyan as flood. "Insufficient data" is cloud, terrain shadow
 * or no clear observation in the composite window, not dry ground.
 * @see https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_Flood.xml
 */
export const FLOOD_LEGEND = Object.freeze([
  {
    value: 1,
    color: '#32d2f5',
    short: 'cyan usual water',
    label: 'Surface water (usual)',
  },
  {
    value: 2,
    color: '#ffff00',
    short: 'yellow recurring flood',
    label: 'Recurring flood',
  },
  {
    value: 3,
    color: '#fa1e24',
    short: 'red flood',
    label: 'Flood water (unusual)',
  },
  {
    value: 255,
    color: '#afafaf',
    short: 'grey no clear view',
    label: 'Insufficient data (cloud, shadow)',
  },
]);

/** Human title per product key. */
export function floodProductTitle(key) {
  switch (key) {
    case 'viirs1':
      return 'VIIRS 1-day composite, 375 m';
    case 'viirs3':
      return 'VIIRS 3-day composite, 375 m';
    case 'modis2':
      return 'MODIS 2-day composite, 250 m';
    default:
      return 'MODIS 3-day composite, 250 m';
  }
}
