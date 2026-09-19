import * as Cesium from 'cesium';
import {
  GIBS_WMTS_URL,
  IMERG_TILE_MATRIX_SET,
  IMERG_MAX_LEVEL,
  IMERG_FORMAT,
  IMERG_DEFAULT_ALPHA,
  normalizeAlpha,
  resolveImergLayer,
} from './model.js';
export * from './model.js';

export const NASA_IMERG_LAYER_ID = 'nasa-imerg-rain';
/** GIBS publishes a new half-hour slot every 30 minutes; re-pull hourly. */
const REFRESH_MS = 60 * 60 * 1000;

/**
 * A live rainfall-rate overlay from NASA GIBS (GPM IMERG), painted on the
 * globe above the basemap. It owns one Cesium ImageryLayer while enabled and
 * removes it on disable, so the basemap stack never sees it.
 *
 * Imagery layers render on the globe, which the Google 3D Tiles basemap hides,
 * so in photoreal mode the layer reports itself degraded instead of pretending.
 *
 * @param {object} [options]
 * @param {string} [options.product] 'rate' | 'rate30' | GIBS identifier.
 * @param {number} [options.alpha]
 * @param {function} [options.governorRequestRender]
 */
export function createNasaImergLayer({
  product = 'rate',
  alpha = IMERG_DEFAULT_ALPHA,
  governorRequestRender = null,
} = {}) {
  let _viewer = null;
  let _imageryLayer = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _tileErrors = 0;
  let _alpha = normalizeAlpha(alpha);
  let _product = resolveImergLayer(product);
  let _errorRemover = null;

  function createProvider() {
    return new Cesium.WebMapTileServiceImageryProvider({
      url: GIBS_WMTS_URL,
      layer: _product,
      style: 'default',
      format: IMERG_FORMAT,
      tileMatrixSetID: IMERG_TILE_MATRIX_SET,
      maximumLevel: IMERG_MAX_LEVEL,
      credit: new Cesium.Credit(
        'Rainfall: NASA GIBS · GPM IMERG (Early run)',
        false,
      ),
    });
  }

  function removeImagery() {
    _errorRemover?.();
    _errorRemover = null;
    if (_imageryLayer && _viewer?.imageryLayers) {
      _viewer.imageryLayers.remove(_imageryLayer, true);
    }
    _imageryLayer = null;
  }

  function addImagery() {
    if (!_viewer || _imageryLayer) return;
    const provider = createProvider();
    _tileErrors = 0;
    _errorRemover =
      provider.errorEvent?.addEventListener?.(() => {
        _tileErrors += 1;
      }) || null;
    _imageryLayer = _viewer.imageryLayers.addImageryProvider(provider);
    _imageryLayer.alpha = _alpha;
    _lastUpdate = Date.now();
    _lastError = null;
    governorRequestRender?.('nasa-imerg:add');
  }

  function globeHidden() {
    return _viewer?.scene?.globe && _viewer.scene.globe.show === false;
  }

  const layer = {
    id: NASA_IMERG_LAYER_ID,
    name: 'Rainfall now (NASA IMERG)',
    icon: '☁',
    source: 'NASA GIBS · LIVE',
    refreshInterval: REFRESH_MS,

    init(viewer) {
      if (_viewer) throw new Error('NASA IMERG layer already initialized');
      _viewer = viewer;
      _enabled = false;
      _lastUpdate = null;
      _lastError = null;
      console.log('[Data:NasaImerg] Initialized');
    },

    enable() {
      _enabled = true;
      try {
        addImagery();
      } catch (e) {
        _lastError = e?.message || 'GIBS overlay failed';
        console.warn('[Data:NasaImerg] Enable error:', e);
        return false;
      }
      return true;
    },

    disable() {
      _enabled = false;
      removeImagery();
      governorRequestRender?.('nasa-imerg:remove');
    },

    /** Re-create the provider so the newest GIBS slot replaces cached tiles. */
    update() {
      if (!_enabled || !_viewer) return false;
      try {
        removeImagery();
        addImagery();
        return true;
      } catch (e) {
        _lastError = e?.message || 'GIBS overlay failed';
        return false;
      }
    },

    destroy() {
      _enabled = false;
      removeImagery();
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
    },

    getParams() {
      return { alpha: _alpha, product: _product };
    },

    setParams(params = {}) {
      let changed = false;
      if (params.alpha !== undefined) {
        const next = normalizeAlpha(params.alpha, _alpha);
        if (next !== _alpha) {
          _alpha = next;
          if (_imageryLayer) _imageryLayer.alpha = _alpha;
          changed = true;
        }
      }
      if (params.product !== undefined) {
        const next = resolveImergLayer(params.product);
        if (next !== _product) {
          _product = next;
          if (_enabled) {
            removeImagery();
            addImagery();
          }
          changed = true;
        }
      }
      if (changed) governorRequestRender?.('nasa-imerg:params');
      return true;
    },

    getStats() {
      const hidden = globeHidden();
      return {
        count: _imageryLayer ? 1 : 0,
        lastUpdate: _lastUpdate,
        error: _lastError,
        degraded: Boolean(hidden) || _tileErrors > 8,
        status: hidden
          ? 'Needs a globe basemap: switch off Google 3D to see rainfall'
          : _tileErrors > 8
            ? 'GIBS tiles failing'
            : undefined,
        coverage: 'Global · 0.1° · 30-min slots',
      };
    },
  };
  return layer;
}
