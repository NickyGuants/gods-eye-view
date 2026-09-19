import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  KENYA_GAUGE_OVERLAY_SOURCE_ID,
  KENYA_GAUGE_OVERLAY_COHORT_LIMIT,
  KENYA_GAUGE_OVERLAY_COLLISION_CAPACITY,
  severityColor,
  severityLabel,
  severityRank,
  severityCounts,
  discRadiusMeters,
  createGaugeOverlayEntry,
  selectGaugeOverlayCohort,
  gaugeReadoutDetails,
  mapGaugeAnalystRecord,
} from './model.js';
export * from './model.js';
export { createOpenMeteoFloodSource } from './source.js';
export { KENYA_GAUGE_SITES } from './sites.js';

export const KENYA_RIVER_GAUGES_LAYER_ID = 'kenya-river-gauges';
/** GloFAS updates once a day; hourly is plenty and kind to Open-Meteo. */
const REFRESH_MS = 60 * 60 * 1000;

/**
 * Own the Kenya river gauge display: one ground disc and anchor per site,
 * coloured by how far the forecast peak sits above the recent median, an
 * ambient card per gauge, and a click readout with the numbers.
 *
 * @param {object} options
 * @param {{getSnapshot:function}} options.source Open-Meteo flood source.
 * @param {object} options.services Overlay host, context store and render governor.
 */
export function createKenyaRiverGaugesLayer({ source, services } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Kenya river gauges require a snapshot source');
  const {
    overlayHost,
    registerEntityContext,
    selectEntityContext,
    clearSelectedEntityContextForLayer,
    removeEntityContextsForLayer,
    governorRequestRender,
  } = services || {};
  if (!overlayHost)
    throw new TypeError('Kenya river gauges require an overlay host');

  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _clickHandler = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  /** @type {object[]} Latest normalized rows, for the analyst seam. */
  let _rows = [];
  /** Rows per severity band, for the panel status line. */
  let _counts = {};
  /** Sampled terrain height per site id (metres above the ellipsoid). */
  const _heights = new Map();

  async function sampleHeights(viewer, rows, signal) {
    const provider = viewer?.terrainProvider;
    if (!provider || typeof Cesium.sampleTerrainMostDetailed !== 'function')
      return;
    const pending = rows.filter((row) => !_heights.has(row.id));
    if (!pending.length) return;
    try {
      const cartos = pending.map((row) =>
        Cesium.Cartographic.fromDegrees(row.lon, row.lat),
      );
      const sampled = await Cesium.sampleTerrainMostDetailed(provider, cartos);
      if (signal?.aborted) return;
      sampled.forEach((carto, index) => {
        const height = Number(carto?.height);
        _heights.set(pending[index].id, Number.isFinite(height) ? height : 0);
      });
    } catch {
      /* Ellipsoid heights are an acceptable fallback. */
    }
  }

  function anchorFor(row) {
    return Cesium.Cartesian3.fromDegrees(
      row.lon,
      row.lat,
      (_heights.get(row.id) || 0) + 40,
    );
  }

  function installClickHandler(viewer) {
    if (_clickHandler) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!isPointerFree()) return;
      if (!_enabled) return;
      const picked = viewer.scene.pick(click.position);
      const entity = picked?.id;
      if (!entity || entity.__gevKenyaGaugeId === undefined) return;
      viewer.selectedEntity = entity;
      selectEntityContext?.(entity);
      governorRequestRender?.('kenya-river-gauges:select');
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const layer = {
    id: KENYA_RIVER_GAUGES_LAYER_ID,
    name: 'Kenya river sites (GloFAS)',
    icon: '≋',
    source: 'GloFAS · Open-Meteo · LIVE',
    refreshInterval: REFRESH_MS,

    init(viewer) {
      if (_viewer) throw new Error('Kenya river gauges already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(KENYA_RIVER_GAUGES_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(KENYA_GAUGE_OVERLAY_SOURCE_ID, false);
      console.log('[Data:KenyaRiverGauges] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(KENYA_GAUGE_OVERLAY_SOURCE_ID, true);
      installClickHandler(viewer);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      clearSelectedEntityContextForLayer?.(KENYA_RIVER_GAUGES_LAYER_ID);
      overlayHost.clearSource(KENYA_GAUGE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(KENYA_GAUGE_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        await sampleHeights(viewer, rows, request.signal);
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const nextEntities = [];
        const overlayEntries = [];
        for (const row of rows) {
          const color = severityColor(row.severity);
          const radius = discRadiusMeters(row);
          const ground = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const anchor = anchorFor(row);
          const entity = new Cesium.Entity({
            id: `kenya-gauge:${row.id}`,
            position: ground,
            ellipse: {
              semiMajorAxis: radius,
              semiMinorAxis: radius,
              material: new Cesium.ColorMaterialProperty(color.withAlpha(0.28)),
              outline: true,
              outlineColor: color.withAlpha(0.95),
              outlineWidth: severityRank(row.severity) >= 3 ? 3 : 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            point: {
              pixelSize: severityRank(row.severity) === 0 ? 9 : 12,
              color,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            properties: {
              siteId: row.id,
              severity: row.severity,
              current: row.current,
              peak: row.peak,
              medianPeak: row.medianPeak,
              reachedKey: row.reachedKey,
            },
          });
          entity.__gevKenyaGaugeId = row.id;
          entity.gevTrackedId = `kenya-gauge:${row.id}`;
          entity.gevDisplayPosition = () => anchor;
          entity.gevLabelModel = {
            title: row.name,
            details: gaugeReadoutDetails(row),
            accent: color.toCssColorString(),
            cardStyle: 'tactical',
            selected: true,
            leaderStyle: 'elbow',
            leaderAnimationMs: 440,
            leaderDrawRatio: 0.68,
            anchorRadiusPx: 8,
            anchorRadiusScale: null,
          };
          nextEntities.push(entity);
          overlayEntries.push(
            createGaugeOverlayEntry({ row, position: anchor }),
          );
        }

        removeEntityContextsForLayer?.(KENYA_RIVER_GAUGES_LAYER_ID);
        _dataSource.entities.removeAll();
        for (const entity of nextEntities) {
          _dataSource.entities.add(entity);
          const row = rows.find((r) => r.id === entity.__gevKenyaGaugeId);
          registerEntityContext?.(entity, {
            id: `${KENYA_RIVER_GAUGES_LAYER_ID}:${row.id}`,
            layerId: KENYA_RIVER_GAUGES_LAYER_ID,
            layerName: layer.name,
            source: layer.source,
            dataSource: _dataSource,
            label: row.name,
            latitude: Number(row.lat.toFixed(6)),
            longitude: Number(row.lon.toFixed(6)),
            properties: {
              river: row.river,
              county: row.county,
              severity: severityLabel(row.severity, row.unratedReason),
              withinThreeDays: row.soon,
              currentM3s: row.current,
              medianM3s: row.baseline,
              centralPeakM3s: row.medianPeak,
              upperPeakM3s: row.peak,
              peakDate: row.peakDate,
              thresholdsM3s: row.thresholds,
              note: row.note,
            },
          });
        }
        if (_enabled) {
          overlayHost.setEntries(
            KENYA_GAUGE_OVERLAY_SOURCE_ID,
            selectGaugeOverlayCohort(overlayEntries),
            {
              cohortLimit: KENYA_GAUGE_OVERLAY_COHORT_LIMIT,
              collisionCapacity: KENYA_GAUGE_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }
        _rows = rows;
        _count = rows.length;
        _lastUpdate = Date.now();
        _lastError = null;
        _counts = severityCounts(rows);
        const alarming = rows.filter(
          (r) => severityRank(r.severity) >= 2,
        ).length;
        const watch = rows.filter((r) => r.severity === 'watch').length;
        console.log(
          `[Data:KenyaRiverGauges] Updated: ${_count} sites, ${alarming} at Q2 or worse, ${watch} on watch`,
        );
        governorRequestRender?.('kenya-river-gauges:update');
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:KenyaRiverGauges] Fetch error:', e);
        _lastError = e?.message || 'Open-Meteo flood source unavailable';
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
      removeEntityContextsForLayer?.(KENYA_RIVER_GAUGES_LAYER_ID);
      overlayHost.clearSource(KENYA_GAUGE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(KENYA_GAUGE_OVERLAY_SOURCE_ID, false);
      if (_dataSource && viewer) {
        viewer.dataSources.remove(_dataSource, true);
      }
      _dataSource = null;
      _viewer = null;
      _rows = [];
      _counts = {};
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /** Plain records for the voice analyst; [] while disabled. */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_rows.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return _rows.slice(0, limit).map(mapGaugeAnalystRecord);
    },

    getStats() {
      const c = _counts;
      const alarming = (c.moderate || 0) + (c.high || 0) + (c.severe || 0);
      const status = _count
        ? `${alarming} at Q2+ · ${c.watch || 0} watch · ${c.normal || 0} normal` +
          (c.unrated ? ` · ${c.unrated} unrated` : '') +
          (c.unknown ? ` · ${c.unknown} no data` : '')
        : undefined;
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        status,
        bands: { ...c },
        coverage: 'Kenya · 24 modelled river sites',
      };
    },
  };
  return layer;
}
