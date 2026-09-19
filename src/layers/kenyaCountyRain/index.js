import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  KENYA_RAIN_OVERLAY_SOURCE_ID,
  KENYA_RAIN_OVERLAY_COHORT_LIMIT,
  KENYA_RAIN_OVERLAY_COLLISION_CAPACITY,
  bandColor,
  bandFillAlpha,
  createRainOverlayEntry,
  selectRainOverlayCohort,
  rainReadoutDetails,
  mapRainAnalystRecord,
  formatMm,
} from './model.js';
export * from './model.js';
export { createOpenMeteoRainSource } from './source.js';
export { KENYA_COUNTIES } from './counties.js';

export const KENYA_COUNTY_RAIN_LAYER_ID = 'kenya-county-rain';
/** Open-Meteo refreshes hourly; match it. */
const REFRESH_MS = 60 * 60 * 1000;

// Resolved by Vite in builds and relative to this module in other consumers.
const DEFAULT_COUNTIES_URL = new URL(
  '../../data/local_data/kenya/counties.json',
  import.meta.url,
).href;

/**
 * Paint every Kenyan county by its 7-day rainfall forecast, with a card per
 * county and a click readout of the daily numbers.
 *
 * @param {object} options
 * @param {{getSnapshot:function}} options.source Open-Meteo rain source.
 * @param {object} options.services Overlay host, context store, render governor.
 * @param {string} [options.countiesUrl] Bundled county polygons (GeoJSON).
 * @param {function} [options.fetchImpl] For the polygon file only.
 */
export function createKenyaCountyRainLayer({
  source,
  services,
  countiesUrl = DEFAULT_COUNTIES_URL,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Kenya county rain requires a snapshot source');
  const {
    overlayHost,
    registerEntityContext,
    selectEntityContext,
    clearSelectedEntityContextForLayer,
    removeEntityContextsForLayer,
    governorRequestRender,
  } = services || {};
  if (!overlayHost)
    throw new TypeError('Kenya county rain requires an overlay host');

  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _clickHandler = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _rows = [];
  /** @type {object|null} Parsed county GeoJSON, kept for the layer's lifetime. */
  let _counties = null;
  /** county id → { fills: Entity[], outlines: Entity[], anchor: Entity } */
  const _entities = new Map();

  async function loadCounties(signal) {
    if (_counties) return _counties;
    const response = await fetchImpl(countiesUrl, { signal });
    if (!response.ok)
      throw new Error(`County polygons HTTP ${response.status}`);
    const geojson = await response.json();
    if (!Array.isArray(geojson?.features)) {
      throw new Error('County polygons malformed');
    }
    _counties = geojson;
    return geojson;
  }

  function ringToPositions(ring) {
    const flat = [];
    for (const [lon, lat] of ring) flat.push(lon, lat);
    return Cesium.Cartesian3.fromDegreesArray(flat);
  }

  function polygonsOf(feature) {
    const geometry = feature?.geometry;
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates;
    return [];
  }

  function ensureEntities(feature, row) {
    const id = String(feature.id);
    if (_entities.has(id)) return _entities.get(id);
    const fills = [];
    const outlines = [];
    polygonsOf(feature).forEach((polygon, index) => {
      const outer = ringToPositions(polygon[0]);
      const fill = new Cesium.Entity({
        id: `kenya-rain:${id}:${index}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(outer),
          material: Cesium.Color.WHITE.withAlpha(0.1),
          classificationType: Cesium.ClassificationType.BOTH,
        },
        properties: { countyId: id },
      });
      fill.__gevKenyaCountyId = id;
      fills.push(fill);
      outlines.push(
        new Cesium.Entity({
          id: `kenya-rain-outline:${id}:${index}`,
          polyline: {
            positions: outer,
            width: 1.5,
            material: Cesium.Color.WHITE.withAlpha(0.6),
            clampToGround: true,
          },
        }),
      );
    });
    const anchor = new Cesium.Entity({
      id: `kenya-rain-anchor:${id}`,
      position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
      point: {
        pixelSize: 6,
        color: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    anchor.__gevKenyaCountyId = id;
    const group = { fills, outlines, anchor };
    _entities.set(id, group);
    for (const entity of [...fills, ...outlines, anchor])
      _dataSource.entities.add(entity);
    return group;
  }

  function installClickHandler(viewer) {
    if (_clickHandler) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!isPointerFree()) return;
      if (!_enabled) return;
      const picked = viewer.scene.pick(click.position);
      const entity = picked?.id;
      const countyId = entity?.__gevKenyaCountyId;
      if (!countyId) return;
      const anchor = _entities.get(countyId)?.anchor;
      if (!anchor) return;
      viewer.selectedEntity = anchor;
      selectEntityContext?.(anchor);
      governorRequestRender?.('kenya-county-rain:select');
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const layer = {
    id: KENYA_COUNTY_RAIN_LAYER_ID,
    name: 'Kenya county rainfall (7d)',
    icon: '☂',
    source: 'Open-Meteo · LIVE',
    refreshInterval: REFRESH_MS,

    init(viewer) {
      if (_viewer) throw new Error('Kenya county rain already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(KENYA_COUNTY_RAIN_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(KENYA_RAIN_OVERLAY_SOURCE_ID, false);
      console.log('[Data:KenyaCountyRain] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(KENYA_RAIN_OVERLAY_SOURCE_ID, true);
      installClickHandler(viewer);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      clearSelectedEntityContextForLayer?.(KENYA_COUNTY_RAIN_LAYER_ID);
      overlayHost.clearSource(KENYA_RAIN_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(KENYA_RAIN_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const [rows, geojson] = await Promise.all([
          source.getSnapshot({ signal: request.signal }),
          loadCounties(request.signal),
        ]);
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const featuresById = new Map(
          geojson.features.map((f) => [String(f.id), f]),
        );
        const overlayEntries = [];
        for (const row of rows) {
          const feature = featuresById.get(row.id);
          if (!feature) continue;
          const group = ensureEntities(feature, row);
          const color = bandColor(row.band);
          for (const fill of group.fills) {
            fill.polygon.material = new Cesium.ColorMaterialProperty(
              color.withAlpha(bandFillAlpha(row.band)),
            );
          }
          for (const outline of group.outlines) {
            outline.polyline.material = new Cesium.ColorMaterialProperty(
              color.brighten(0.35, new Cesium.Color()).withAlpha(0.85),
            );
          }
          const anchor = group.anchor;
          const anchorPosition = Cesium.Cartesian3.fromDegrees(
            row.lon,
            row.lat,
          );
          anchor.point.color = color;
          anchor.gevTrackedId = `kenya-rain:${row.id}`;
          anchor.gevDisplayPosition = () => anchorPosition;
          anchor.gevLabelModel = {
            title: `${row.name} · ${formatMm(row.next7Mm)}`,
            details: rainReadoutDetails(row),
            accent: color.toCssColorString(),
            cardStyle: 'tactical',
            selected: true,
            leaderStyle: 'elbow',
            leaderAnimationMs: 440,
            leaderDrawRatio: 0.68,
            anchorRadiusPx: 6,
            anchorRadiusScale: null,
          };
          registerEntityContext?.(anchor, {
            id: `${KENYA_COUNTY_RAIN_LAYER_ID}:${row.id}`,
            layerId: KENYA_COUNTY_RAIN_LAYER_ID,
            layerName: layer.name,
            source: layer.source,
            dataSource: _dataSource,
            label: row.name,
            latitude: Number(row.lat.toFixed(6)),
            longitude: Number(row.lon.toFixed(6)),
            properties: {
              band: row.band,
              next7Mm: row.next7Mm,
              next3Mm: row.next3Mm,
              past7Mm: row.past7Mm,
              wettestDay: row.wettestDay,
              wettestMm: row.wettestMm,
            },
          });
          overlayEntries.push(
            createRainOverlayEntry({ row, position: anchorPosition }),
          );
        }
        if (_enabled) {
          overlayHost.setEntries(
            KENYA_RAIN_OVERLAY_SOURCE_ID,
            selectRainOverlayCohort(overlayEntries),
            {
              cohortLimit: KENYA_RAIN_OVERLAY_COHORT_LIMIT,
              collisionCapacity: KENYA_RAIN_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }
        _rows = rows;
        _count = rows.length;
        _lastUpdate = Date.now();
        _lastError = null;
        const wet = rows.filter(
          (r) => r.band === 'heavy' || r.band === 'extreme',
        ).length;
        console.log(
          `[Data:KenyaCountyRain] Updated: ${_count} counties, ${wet} heavy or worse`,
        );
        governorRequestRender?.('kenya-county-rain:update');
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:KenyaCountyRain] Fetch error:', e);
        _lastError = e?.message || 'Open-Meteo forecast unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      _clickHandler?.destroy?.();
      _clickHandler = null;
      removeEntityContextsForLayer?.(KENYA_COUNTY_RAIN_LAYER_ID);
      overlayHost.clearSource(KENYA_RAIN_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(KENYA_RAIN_OVERLAY_SOURCE_ID, false);
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _entities.clear();
      _viewer = null;
      _rows = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_rows.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return _rows.slice(0, limit).map(mapRainAnalystRecord);
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        coverage: 'Kenya · 47 counties',
      };
    },
  };
  return layer;
}
