import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { activeAlerts, recentlyExpiredAlerts } from './cap.js';
export * from './cap.js';

export const KMD_ALERTS_LAYER_ID = 'kmd-alerts';
export const KMD_OVERLAY_SOURCE_ID = 'kmd-alerts';
/** The same-origin extract is refreshed hourly by the Pages workflow. */
const REFRESH_MS = 30 * 60 * 1000;
/** Expired alerts younger than this are still drawn, faded, for context. */
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

const SEVERITY_COLORS = Object.freeze({
  extreme: Cesium.Color.fromCssColorString('#9d0208'),
  severe: Cesium.Color.fromCssColorString('#e5383b'),
  moderate: Cesium.Color.fromCssColorString('#f48c06'),
  minor: Cesium.Color.fromCssColorString('#f2c14e'),
  unknown: Cesium.Color.fromCssColorString('#8fa3b8'),
});

export function capSeverityColor(severity) {
  return (
    SEVERITY_COLORS[String(severity || '').toLowerCase()] ||
    SEVERITY_COLORS.unknown
  );
}

/** Default same-origin extract URL, honouring the Vite base path. */
export function defaultKmdExtractUrl() {
  const base = import.meta.env?.BASE_URL || '/';
  return `${base}data/kenya/kmd-cap.json`;
}

function day(iso) {
  return iso ? iso.slice(0, 10) : '—';
}

/** Card lines for one alert. Pure. */
export function kmdReadoutDetails(alert, active) {
  const lines = [];
  lines.push(
    `${active ? 'IN FORCE' : 'EXPIRED'} · ${String(alert.severity || '').toUpperCase()} · ${alert.urgency || ''} · ${alert.certainty || ''}`,
  );
  lines.push(`${day(alert.effective || alert.sent)} → ${day(alert.expires)}`);
  if (alert.description) lines.push(alert.description.slice(0, 220));
  if (alert.instruction) lines.push(alert.instruction.slice(0, 160));
  lines.push(
    `${alert.areas.length} area${alert.areas.length === 1 ? '' : 's'}: ${alert.areas
      .map((a) => a.description)
      .filter(Boolean)
      .slice(0, 6)
      .join(', ')}${alert.areas.length > 6 ? '…' : ''}`,
  );
  lines.push('Kenya Meteorological Department · CAP 1.2 · meteo.go.ke');
  return lines;
}

/**
 * Official KMD warnings (CAP) drawn as their warning polygons, from the
 * same-origin extract that scripts/fetch-kenya-feeds.mjs writes. Active
 * alerts are solid; alerts expired within 30 days are faded so a reader sees
 * what was warned and when. A stale extract says so in the status line.
 * @param {object} options
 * @param {object} options.services Overlay host, context store and render governor.
 * @param {string} [options.url] Extract URL.
 * @param {function} [options.fetchImpl]
 * @param {function():number} [options.now]
 */
export function createKmdAlertsLayer({
  services,
  url = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const {
    overlayHost,
    registerEntityContext,
    selectEntityContext,
    clearSelectedEntityContextForLayer,
    removeEntityContextsForLayer,
    governorRequestRender,
  } = services || {};
  if (!overlayHost) throw new TypeError('KMD alerts require an overlay host');

  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _clickHandler = null;
  let _doc = null;
  let _active = [];
  let _drawn = 0;
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
      if (!entity || entity.__gevKmdId === undefined) return;
      viewer.selectedEntity = entity;
      selectEntityContext?.(entity);
      governorRequestRender?.('kmd-alerts:select');
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const layer = {
    id: KMD_ALERTS_LAYER_ID,
    name: 'KMD official warnings (CAP)',
    icon: '⚑',
    source: 'Kenya Met Department · CAP · hourly extract',
    refreshInterval: REFRESH_MS,

    init(viewer) {
      if (_viewer) throw new Error('KMD alerts already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(KMD_ALERTS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(KMD_OVERLAY_SOURCE_ID, false);
      console.log('[Data:KmdAlerts] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(KMD_OVERLAY_SOURCE_ID, true);
      installClickHandler(viewer);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      clearSelectedEntityContextForLayer?.(KMD_ALERTS_LAYER_ID);
      overlayHost.clearSource(KMD_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(KMD_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const response = await fetchImpl(url || defaultKmdExtractUrl(), {
          signal: request.signal,
          cache: 'no-cache',
        });
        if (!response.ok)
          throw new Error(`KMD extract HTTP ${response.status}`);
        const doc = await response.json();
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        if (!doc || !Array.isArray(doc.alerts))
          throw new Error('Malformed KMD extract');
        const t = now();
        const active = activeAlerts(doc.alerts, t);
        const activeIds = new Set(active.map((a) => a.identifier));
        const recent = recentlyExpiredAlerts(doc.alerts, t, RECENT_MS).filter(
          (a) => !activeIds.has(a.identifier),
        );
        removeEntityContextsForLayer?.(KMD_ALERTS_LAYER_ID);
        _dataSource.entities.removeAll();
        const entries = [];
        let drawn = 0;
        const draw = (alert, isActive) => {
          const color = capSeverityColor(alert.severity);
          const alpha = isActive ? 0.28 : 0.1;
          let anchorArea = null;
          alert.areas.forEach((area, ai) => {
            area.polygons.forEach((ring, pi) => {
              const flat = ring.flat();
              const entity = new Cesium.Entity({
                id: `kmd:${alert.identifier}:${ai}:${pi}`,
                polygon: {
                  hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
                  material: new Cesium.ColorMaterialProperty(
                    color.withAlpha(alpha),
                  ),
                  outline: false,
                  heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                  classificationType: Cesium.ClassificationType.TERRAIN,
                },
                polyline: {
                  positions: Cesium.Cartesian3.fromDegreesArray(flat),
                  width: isActive ? 2 : 1,
                  material: color.withAlpha(isActive ? 0.9 : 0.4),
                  clampToGround: true,
                },
              });
              entity.__gevKmdId = alert.identifier;
              entity.gevLabelModel = {
                title: alert.headline || alert.event || 'KMD alert',
                details: kmdReadoutDetails(alert, isActive),
                accent: color.toCssColorString(),
                cardStyle: 'tactical',
                selected: true,
              };
              _dataSource.entities.add(entity);
              drawn++;
              if (!anchorArea && area.centroid) anchorArea = area;
            });
          });
          const centroid =
            anchorArea?.centroid ||
            alert.areas.find((a) => a.centroid)?.centroid ||
            null;
          if (!centroid) return;
          const position = Cesium.Cartesian3.fromDegrees(
            centroid[0],
            centroid[1],
            80,
          );
          const pin = new Cesium.Entity({
            id: `kmd:${alert.identifier}:pin`,
            position,
            point: {
              pixelSize: isActive ? 12 : 8,
              color: color.withAlpha(isActive ? 1 : 0.5),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
          pin.__gevKmdId = alert.identifier;
          pin.gevTrackedId = `kmd:${alert.identifier}`;
          pin.gevDisplayPosition = () => position;
          pin.gevLabelModel = {
            title: alert.headline || alert.event || 'KMD alert',
            details: kmdReadoutDetails(alert, isActive),
            accent: color.toCssColorString(),
            cardStyle: 'tactical',
            selected: true,
            leaderStyle: 'elbow',
            leaderAnimationMs: 440,
            leaderDrawRatio: 0.68,
            anchorRadiusPx: 8,
            anchorRadiusScale: null,
          };
          _dataSource.entities.add(pin);
          registerEntityContext?.(pin, {
            id: `${KMD_ALERTS_LAYER_ID}:${alert.identifier}`,
            layerId: KMD_ALERTS_LAYER_ID,
            layerName: layer.name,
            source: layer.source,
            dataSource: _dataSource,
            label: alert.headline || alert.event,
            latitude: Number(centroid[1].toFixed(5)),
            longitude: Number(centroid[0].toFixed(5)),
            properties: {
              event: alert.event,
              severity: alert.severity,
              inForce: isActive,
              effective: alert.effective,
              expires: alert.expires,
              areas: alert.areas.map((a) => a.description).filter(Boolean),
              url: alert.url,
            },
          });
          entries.push({
            id: String(alert.identifier),
            source: KMD_OVERLAY_SOURCE_ID,
            position,
            variant: 'card',
            title: alert.headline || alert.event,
            details: [
              `${isActive ? 'IN FORCE' : 'expired'} · ${alert.severity || ''} · until ${day(alert.expires)}`,
            ],
            accent: color.toCssColorString(),
            priority: (isActive ? 10000 : 0) + (alert.areas.length || 0),
            collisionGroup: 'ambient-card',
            zIndex: 32,
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
        };
        for (const alert of active) draw(alert, true);
        for (const alert of recent) draw(alert, false);
        if (_enabled)
          overlayHost.setEntries(KMD_OVERLAY_SOURCE_ID, entries, {
            cohortLimit: 12,
            collisionCapacity: 8,
            moving: false,
          });
        _doc = doc;
        _active = active;
        _drawn = drawn;
        _lastUpdate = t;
        _lastError = null;
        console.log(
          `[Data:KmdAlerts] Updated: ${active.length} in force, ${recent.length} recent (feed built ${day(doc.feedBuiltAt)}, fetched ${day(doc.fetchedAt)})`,
        );
        governorRequestRender?.('kmd-alerts:update');
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:KmdAlerts] Fetch error:', e);
        _lastError = e?.message || 'KMD extract unavailable';
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
      removeEntityContextsForLayer?.(KMD_ALERTS_LAYER_ID);
      overlayHost.clearSource(KMD_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(KMD_OVERLAY_SOURCE_ID, false);
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _doc = null;
      _active = [];
      _lastUpdate = null;
      _lastError = null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_doc) return [];
      return (_doc.alerts || [])
        .slice(0, Math.max(1, Math.floor(maxCount) || 2000))
        .map((a) => ({
          identifier: a.identifier,
          event: a.event,
          headline: a.headline,
          severity: a.severity,
          inForce: _active.includes(a),
          effective: a.effective,
          expires: a.expires,
          areas: a.areas.map((x) => x.description).filter(Boolean),
          url: a.url,
        }));
    },

    getStats() {
      const stale =
        _doc?.fetchedAt &&
        now() - new Date(_doc.fetchedAt).getTime() > 6 * 3600 * 1000;
      const status = _doc
        ? `${_active.length} in force · feed built ${day(_doc.feedBuiltAt)} · extract ${day(_doc.fetchedAt)}${stale ? ' (stale)' : ''}${_doc.error ? ' · feed error' : ''}`
        : undefined;
      return {
        count: _doc ? _drawn : 0,
        lastUpdate: _lastUpdate,
        error: _lastError,
        degraded: Boolean(stale || _doc?.error),
        status,
        inForce: _active.length,
        coverage: 'Kenya · KMD CAP alerts',
      };
    },
  };
  return layer;
}
