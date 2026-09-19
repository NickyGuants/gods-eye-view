import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { alertRank } from './records.js';
export * from './records.js';
export { createGdacsFloodSource, buildGdacsUrl } from './source.js';

export const GDACS_FLOODS_LAYER_ID = 'gdacs-flood-alerts';
export const GDACS_OVERLAY_SOURCE_ID = 'gdacs-flood-alerts';
/** GDACS re-scores a few times a day; hourly is plenty. */
const REFRESH_MS = 60 * 60 * 1000;

const LEVEL_COLORS = Object.freeze({
  red: Cesium.Color.fromCssColorString('#d00000'),
  orange: Cesium.Color.fromCssColorString('#f48c06'),
  green: Cesium.Color.fromCssColorString('#2a9d8f'),
});

export function alertColor(level) {
  return LEVEL_COLORS[String(level || '').toLowerCase()] || LEVEL_COLORS.green;
}

function shortDate(iso) {
  return iso ? iso.slice(0, 10) : '—';
}

/** Card lines for a GDACS flood event. Pure. */
export function gdacsReadoutDetails(row) {
  const lines = [];
  lines.push(
    `${row.alertLevel.toUpperCase()} alert · ${row.country}${row.current ? ' · current' : ' · closed'}`,
  );
  lines.push(
    `${shortDate(row.fromDate)} → ${shortDate(row.toDate)} · episode ${row.episodeId ?? '—'}`,
  );
  if (row.severityText) lines.push(row.severityText);
  if (row.affectedIso3.length > 1)
    lines.push(`Also affects ${row.affectedIso3.join(', ')}`);
  lines.push(`GDACS event ${row.eventId} · gdacs.org (JRC/OCHA)`);
  return lines;
}

/**
 * GDACS flood events in Kenya and its neighbours as pins with alert colour,
 * ambient cards and a click readout. An empty result is "no GDACS flood
 * reports in the window", which the status line says in those words.
 * @param {object} options
 * @param {{getSnapshot:function}} options.source
 * @param {object} options.services Overlay host, context store and render governor.
 */
export function createGdacsFloodsLayer({ source, services } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('GDACS floods require a snapshot source');
  const {
    overlayHost,
    registerEntityContext,
    selectEntityContext,
    clearSelectedEntityContextForLayer,
    removeEntityContextsForLayer,
    governorRequestRender,
  } = services || {};
  if (!overlayHost) throw new TypeError('GDACS floods require an overlay host');

  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _clickHandler = null;
  let _rows = [];
  let _window = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  function installClickHandler(viewer) {
    if (_clickHandler) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!isPointerFree() || !_enabled) return;
      const picked = viewer.scene.pick(click.position);
      const entity = picked?.id;
      if (!entity || entity.__gevGdacsId === undefined) return;
      viewer.selectedEntity = entity;
      selectEntityContext?.(entity);
      governorRequestRender?.('gdacs-flood-alerts:select');
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const layer = {
    id: GDACS_FLOODS_LAYER_ID,
    name: 'GDACS flood alerts (East Africa)',
    icon: '◉',
    source: 'GDACS · JRC/OCHA · LIVE',
    refreshInterval: REFRESH_MS,

    init(viewer) {
      if (_viewer) throw new Error('GDACS floods already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(GDACS_FLOODS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(GDACS_OVERLAY_SOURCE_ID, false);
      console.log('[Data:GdacsFloods] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(GDACS_OVERLAY_SOURCE_ID, true);
      installClickHandler(viewer);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      clearSelectedEntityContextForLayer?.(GDACS_FLOODS_LAYER_ID);
      overlayHost.clearSource(GDACS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(GDACS_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const { rows, fromDate, toDate } = await source.getSnapshot({
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        removeEntityContextsForLayer?.(GDACS_FLOODS_LAYER_ID);
        _dataSource.entities.removeAll();
        const entries = [];
        for (const row of rows) {
          const color = alertColor(row.alertLevel);
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 60);
          const entity = new Cesium.Entity({
            id: `gdacs:${row.id}`,
            position,
            point: {
              pixelSize: 10 + alertRank(row.alertLevel) * 3,
              color: row.current ? color : color.withAlpha(0.55),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            properties: { eventId: row.eventId, alertLevel: row.alertLevel },
          });
          entity.__gevGdacsId = row.id;
          entity.gevTrackedId = `gdacs:${row.id}`;
          entity.gevDisplayPosition = () => position;
          entity.gevLabelModel = {
            title: row.name,
            details: gdacsReadoutDetails(row),
            accent: color.toCssColorString(),
            cardStyle: 'tactical',
            selected: true,
            leaderStyle: 'elbow',
            leaderAnimationMs: 440,
            leaderDrawRatio: 0.68,
            anchorRadiusPx: 8,
            anchorRadiusScale: null,
          };
          _dataSource.entities.add(entity);
          registerEntityContext?.(entity, {
            id: `${GDACS_FLOODS_LAYER_ID}:${row.id}`,
            layerId: GDACS_FLOODS_LAYER_ID,
            layerName: layer.name,
            source: layer.source,
            dataSource: _dataSource,
            label: row.name,
            latitude: Number(row.lat.toFixed(6)),
            longitude: Number(row.lon.toFixed(6)),
            properties: {
              country: row.country,
              alertLevel: row.alertLevel,
              current: row.current,
              fromDate: row.fromDate,
              toDate: row.toDate,
              reportUrl: row.reportUrl,
            },
          });
          entries.push({
            id: String(row.id),
            source: GDACS_OVERLAY_SOURCE_ID,
            position,
            variant: 'card',
            title: row.name,
            details: [
              `${row.alertLevel.toUpperCase()} · ${shortDate(row.fromDate)} → ${shortDate(row.toDate)}${row.current ? '' : ' · closed'}`,
            ],
            accent: color.toCssColorString(),
            priority:
              alertRank(row.alertLevel) * 1000 + (row.current ? 500 : 0),
            collisionGroup: 'ambient-card',
            zIndex: 31,
            interactive: false,
            minDistance: 0,
            maxDistance: 14000000,
            distanceFadeStartRatio: 250000 / 14000000,
            distanceScale: {
              near: 250000,
              nearValue: 1,
              far: 9000000,
              farValue: 0.7,
            },
            edgeFade: 'keyhole',
            horizonCull: true,
            terrainOcclusion: false,
            gapPx: 15,
            placement: 'above',
          });
        }
        if (_enabled)
          overlayHost.setEntries(GDACS_OVERLAY_SOURCE_ID, entries, {
            cohortLimit: 24,
            collisionCapacity: 16,
            moving: false,
          });
        _rows = rows;
        _window = { fromDate, toDate };
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:GdacsFloods] Updated: ${rows.length} East Africa flood events ${fromDate}→${toDate}`,
        );
        governorRequestRender?.('gdacs-flood-alerts:update');
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:GdacsFloods] Fetch error:', e);
        _lastError = e?.message || 'GDACS unavailable';
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
      removeEntityContextsForLayer?.(GDACS_FLOODS_LAYER_ID);
      overlayHost.clearSource(GDACS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(GDACS_OVERLAY_SOURCE_ID, false);
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _rows = [];
      _lastUpdate = null;
      _lastError = null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_rows.length) return [];
      return _rows
        .slice(0, Math.max(1, Math.floor(maxCount) || 2000))
        .map((r) => ({
          id: r.id,
          name: r.name,
          country: r.country,
          alertLevel: r.alertLevel,
          current: r.current,
          fromDate: r.fromDate,
          toDate: r.toDate,
          lat: r.lat,
          lon: r.lon,
          reportUrl: r.reportUrl,
        }));
    },

    getStats() {
      return {
        count: _rows.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        status:
          _lastUpdate && !_rows.length && _window
            ? `No GDACS flood reports for East Africa ${_window.fromDate} → ${_window.toDate}`
            : undefined,
        coverage: 'Kenya + neighbours · last 90 days',
      };
    },
  };
  return layer;
}
