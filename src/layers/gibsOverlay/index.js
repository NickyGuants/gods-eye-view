import * as Cesium from 'cesium';

/** GIBS WMTS endpoint (Web Mercator, "best" quality). KVP GetTile. */
export const GIBS_WMTS_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi';

/** Clamp an alpha to the range the overlay accepts. */
export function normalizeAlpha(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0.1, n));
}

/** `YYYY-MM-DD` in UTC for a timestamp, the GIBS daily TIME form. */
export function gibsDay(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/**
 * One NASA GIBS imagery overlay on the globe: owns a Cesium ImageryLayer
 * while enabled and removes it on disable, so the basemap stack never sees
 * it. The IMERG rainfall-rate and the MODIS/VIIRS observed-flood layers are
 * both instances of this. Imagery renders on the globe, which the Google 3D
 * Tiles basemap hides, so in photoreal mode the layer reports itself degraded
 * instead of pretending.
 *
 * @param {object} options
 * @param {string} options.id Layer id.
 * @param {string} options.name Panel name.
 * @param {string} options.icon
 * @param {string} options.sourceLabel Panel source line.
 * @param {string} options.logTag `[Data:<tag>]` for console lines.
 * @param {Record<string,string>} options.products key → GIBS layer identifier.
 * @param {string} options.defaultProduct Key in `products`.
 * @param {string} options.tileMatrixSet e.g. GoogleMapsCompatible_Level6.
 * @param {number} options.maximumLevel
 * @param {string} options.credit
 * @param {string} options.coverage getStats coverage text.
 * @param {number} [options.alpha]
 * @param {number} [options.refreshMs]
 * @param {boolean} [options.dated] Send an explicit daily TIME (UTC today, minus
 *   `latencyDays`) so the card can say which slot was asked for.
 * @param {number} [options.latencyDays]
 * @param {function(string):string} [options.productTitle] Optional name per product.
 * @param {function} [options.governorRequestRender]
 * @param {function():number} [options.now]
 */
export function createGibsOverlayLayer({
  id,
  name,
  icon,
  sourceLabel,
  logTag,
  products,
  defaultProduct,
  tileMatrixSet,
  maximumLevel,
  credit,
  coverage,
  alpha = 0.72,
  refreshMs = 60 * 60 * 1000,
  dated = false,
  latencyDays = 0,
  productTitle = null,
  governorRequestRender = null,
  now = () => Date.now(),
} = {}) {
  if (!id || !products || !products[defaultProduct])
    throw new TypeError('GIBS overlay needs an id and a default product');
  const defaultAlpha = normalizeAlpha(alpha, 0.72);
  let _viewer = null;
  let _imageryLayer = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _tileErrors = 0;
  let _alpha = defaultAlpha;
  let _productKey = defaultProduct;
  let _time = null;
  let _errorRemover = null;

  const resolveProduct = (key) =>
    products[key]
      ? key
      : Object.values(products).includes(key)
        ? Object.keys(products).find((k) => products[k] === key)
        : null;

  function createProvider() {
    const layer = products[_productKey];
    _time = dated ? gibsDay(now() - latencyDays * 86400000) : null;
    return new Cesium.WebMapTileServiceImageryProvider({
      url: _time ? `${GIBS_WMTS_URL}?TIME=${_time}` : GIBS_WMTS_URL,
      layer,
      style: 'default',
      format: 'image/png',
      tileMatrixSetID: tileMatrixSet,
      maximumLevel,
      credit: new Cesium.Credit(credit, false),
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
    _lastUpdate = now();
    _lastError = null;
    governorRequestRender?.(`${id}:add`);
  }

  function globeHidden() {
    return _viewer?.scene?.globe && _viewer.scene.globe.show === false;
  }

  const layer = {
    id,
    name,
    icon,
    source: sourceLabel,
    refreshInterval: refreshMs,

    init(viewer) {
      if (_viewer) throw new Error(`${name} already initialized`);
      _viewer = viewer;
      _enabled = false;
      _lastUpdate = null;
      _lastError = null;
      console.log(`[Data:${logTag}] Initialized`);
    },

    enable() {
      _enabled = true;
      try {
        addImagery();
      } catch (e) {
        _lastError = e?.message || 'GIBS overlay failed';
        console.warn(`[Data:${logTag}] Enable error:`, e);
        return false;
      }
      return true;
    },

    disable() {
      _enabled = false;
      removeImagery();
      governorRequestRender?.(`${id}:remove`);
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
      return { alpha: _alpha, product: products[_productKey], time: _time };
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
        const next = resolveProduct(params.product) || defaultProduct;
        if (next !== _productKey) {
          _productKey = next;
          if (_enabled) {
            removeImagery();
            addImagery();
          }
          changed = true;
        }
      }
      if (changed) governorRequestRender?.(`${id}:params`);
      return true;
    },

    getStats() {
      const hidden = globeHidden();
      const title = productTitle?.(_productKey);
      return {
        count: _imageryLayer ? 1 : 0,
        lastUpdate: _lastUpdate,
        error: _lastError,
        degraded: Boolean(hidden) || _tileErrors > 8,
        status: hidden
          ? 'Needs a globe basemap: switch off Google 3D to see this overlay'
          : _tileErrors > 8
            ? 'GIBS tiles failing'
            : _time
              ? `${title ? `${title} · ` : ''}slot ${_time} (UTC)`
              : title,
        coverage,
        product: products[_productKey],
        time: _time,
      };
    },
  };
  return layer;
}
