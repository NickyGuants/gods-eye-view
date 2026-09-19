import * as Cesium from 'cesium';
import {
  computeFootprint,
  gridSpec,
  depthColor,
  bankfullWidth,
  MIN_DEPTH_M,
} from './model.js';
export * from './model.js';

export const KENYA_FLOOD_FOOTPRINTS_LAYER_ID = 'kenya-flood-footprints';
export const FOOTPRINT_OVERLAY_SOURCE_ID = 'kenya-flood-footprints';
/** Follows the river sites: GloFAS updates daily, hourly is plenty. */
const REFRESH_MS = 60 * 60 * 1000;
/** Grid: 31 × 31 cells over ±3 km (about 200 m cells) around each site. */
const GRID_CELLS = 31;
const GRID_HALF_KM = 3;
/** Terrain samples per request batch. */
const SAMPLE_BATCH = 512;
/** A grid with fewer valid samples than this share is not used or cached. */
const MIN_TERRAIN_COVERAGE = 0.95;
/** The sentence a county officer must read before trusting a footprint. */
export const FOOTPRINT_CAVEAT =
  'Uncalibrated terrain scenario driven by a ~5 km river-flow forecast: 200 m blocks are not 200 m accuracy; verify river position, depths and defences locally before operational use.';

/** Hectares of one grid cell at a latitude. */
function cellHectares(spec, lat) {
  const mLat = spec.cellLatDeg * 111320;
  const mLon = spec.cellLonDeg * 111320 * Math.cos((lat * Math.PI) / 180);
  return (mLat * mLon) / 10000;
}

function fmtHa(ha) {
  if (!Number.isFinite(ha)) return '—';
  if (ha >= 1000) return `${(ha / 1000).toFixed(1)} k ha`;
  return `${Math.round(ha)} ha`;
}

/**
 * Forecast inundation footprints in 3D: for every rated river site the layer
 * samples the terrain mesh into a grid, finds the channel, lifts a water
 * surface by the stage that the forecast discharge implies (global hydraulic
 * geometry, bankfull = Q2) and floods the connected low ground. Two
 * scenarios per site: the ensemble's central peak (solid) and its upper peak
 * (faint). Water is drawn as columns from the ground to the water surface,
 * so from an oblique camera it reads as depth, not paint. First-order only:
 * no roughness, no dykes, no timing; the card says so.
 *
 * @param {object} options
 * @param {{getSnapshot:function}} options.source The Kenya flood source (shared with the sites layer).
 * @param {object} options.services Overlay host and render governor.
 * @param {number} [options.cells]
 * @param {number} [options.halfKm]
 */
export function createKenyaFloodFootprintsLayer({
  source,
  services,
  cells = GRID_CELLS,
  halfKm = GRID_HALF_KM,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Flood footprints require the flood snapshot source');
  const { overlayHost, governorRequestRender } = services || {};
  if (!overlayHost)
    throw new TypeError('Flood footprints require an overlay host');

  let _viewer = null;
  let _request = null;
  let _primitive = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _records = [];
  let _progress = null;
  /** Terrain grids per site id; terrain does not change between refreshes. */
  const _grids = new Map();

  async function sampleGrid(viewer, row, signal) {
    const cached = _grids.get(row.id);
    if (cached) return cached;
    const provider = viewer?.terrainProvider;
    if (!provider || typeof Cesium.sampleTerrainMostDetailed !== 'function')
      throw new Error('terrain provider unavailable');
    const spec = gridSpec({ lat: row.lat, lon: row.lon, halfKm, cells });
    const cartos = [];
    for (let r = 0; r < spec.rows; r++) {
      for (let c = 0; c < spec.cols; c++) {
        const p = spec.center(r, c);
        cartos.push(Cesium.Cartographic.fromDegrees(p.lon, p.lat));
      }
    }
    const heights = new Float32Array(cartos.length).fill(NaN);
    for (let start = 0; start < cartos.length; start += SAMPLE_BATCH) {
      signal?.throwIfAborted();
      const batch = cartos.slice(start, start + SAMPLE_BATCH);
      const sampled = await Cesium.sampleTerrainMostDetailed(provider, batch);
      sampled.forEach((carto, i) => {
        const h = Number(carto?.height);
        heights[start + i] = Number.isFinite(h) ? h : NaN;
      });
    }
    const valid = heights.reduce((a, h) => a + (Number.isFinite(h) ? 1 : 0), 0);
    const grid = { spec, heights, valid, total: heights.length };
    // A tile failure must not become a permanent wall: keep incomplete grids
    // out of the cache so the next refresh samples again.
    if (valid >= MIN_TERRAIN_COVERAGE * heights.length)
      _grids.set(row.id, grid);
    return grid;
  }

  function removePrimitive() {
    if (_primitive && _viewer?.scene?.primitives) {
      _viewer.scene.primitives.remove(_primitive);
    }
    _primitive = null;
  }

  function instancesFor(row, grid, footprint, alpha, tag) {
    const { spec } = grid;
    const out = [];
    const halfLat = spec.cellLatDeg / 2;
    const halfLon = spec.cellLonDeg / 2;
    for (let r = 0; r < spec.rows; r++) {
      for (let c = 0; c < spec.cols; c++) {
        const i = r * spec.cols + c;
        const depth = footprint.depths[i];
        if (!(depth > MIN_DEPTH_M)) continue;
        const p = spec.center(r, c);
        const ground = grid.heights[i];
        out.push(
          new Cesium.GeometryInstance({
            id: `${KENYA_FLOOD_FOOTPRINTS_LAYER_ID}:${row.id}:${tag}:${i}`,
            geometry: new Cesium.RectangleGeometry({
              rectangle: Cesium.Rectangle.fromDegrees(
                p.lon - halfLon,
                p.lat - halfLat,
                p.lon + halfLon,
                p.lat + halfLat,
              ),
              height: ground,
              extrudedHeight: footprint.waterSurface,
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                Cesium.Color.fromCssColorString(depthColor(depth)).withAlpha(
                  alpha,
                ),
              ),
            },
          }),
        );
      }
    }
    return out;
  }

  const layer = {
    id: KENYA_FLOOD_FOOTPRINTS_LAYER_ID,
    name: 'Forecast flood footprints (3D)',
    icon: '▲',
    source: 'Terrain × GloFAS · hydraulic geometry · LIVE',
    refreshInterval: REFRESH_MS,

    init(viewer) {
      if (_viewer) throw new Error('Flood footprints already initialized');
      _viewer = viewer;
      _enabled = false;
      overlayHost.setVisible(FOOTPRINT_OVERLAY_SOURCE_ID, false);
      console.log('[Data:KenyaFloodFootprints] Initialized');
    },

    enable() {
      _enabled = true;
      if (_primitive) _primitive.show = true;
      overlayHost.setVisible(FOOTPRINT_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_primitive) _primitive.show = false;
      overlayHost.clearSource(FOOTPRINT_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FOOTPRINT_OVERLAY_SOURCE_ID, false);
      governorRequestRender?.('kenya-flood-footprints:hide');
    },

    async update(viewer) {
      if (!_enabled || !_viewer) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const rated = rows.filter(
          (row) =>
            row.thresholds?.q2 > 0 && Number.isFinite(row.peak) && row.peak > 0,
        );
        const instances = [];
        const entries = [];
        const records = [];
        let done = 0;
        for (const row of rated) {
          _progress = `sampling terrain ${done + 1}/${rated.length}`;
          const grid = await sampleGrid(viewer || _viewer, row, request.signal);
          if (request.signal.aborted || _request !== request || !_enabled)
            return false;
          const qBankfull = row.thresholds.q2;
          const terrainOk = grid.valid >= MIN_TERRAIN_COVERAGE * grid.total;
          if (!terrainOk) {
            records.push({
              id: row.id,
              name: row.name,
              river: row.river,
              county: row.county,
              lat: row.lat,
              lon: row.lon,
              severity: row.severity,
              terrainSampled: grid.valid,
              gridCells: grid.total,
              unavailable: 'terrain incomplete',
              centralFloodedHa: 0,
              upperFloodedHa: 0,
            });
            done++;
            continue;
          }
          // No ensemble median means no central scenario: never relabel the max.
          const central = Number.isFinite(row.medianPeak)
            ? computeFootprint({
                heights: grid.heights,
                cols: grid.spec.cols,
                rows: grid.spec.rows,
                discharge: row.medianPeak,
                qBankfull,
              })
            : null;
          const upper = computeFootprint({
            heights: grid.heights,
            cols: grid.spec.cols,
            rows: grid.spec.rows,
            discharge: row.peak,
            qBankfull,
          });
          const ha = cellHectares(grid.spec, row.lat);
          instances.push(...instancesFor(row, grid, upper, 0.22, 'upper'));
          if (central)
            instances.push(
              ...instancesFor(row, grid, central, 0.55, 'central'),
            );
          const anchor = central || upper;
          const record = {
            id: row.id,
            name: row.name,
            river: row.river,
            county: row.county,
            lat: row.lat,
            lon: row.lon,
            severity: row.severity,
            channelHeightM: anchor.channel
              ? Math.round(anchor.channel.height)
              : null,
            bankfullM3s: qBankfull,
            bankfullWidthM: Math.round(bankfullWidth(qBankfull)),
            centralAvailable: Boolean(central),
            centralPeakM3s: central ? row.medianPeak : null,
            centralStageM: central
              ? Math.round(central.stage * 100) / 100
              : null,
            centralFloodedHa: central ? Math.round(central.flooded * ha) : 0,
            centralMaxDepthM: central
              ? Math.round(central.maxDepth * 10) / 10
              : null,
            upperPeakM3s: row.peak,
            upperStageM: Math.round(upper.stage * 100) / 100,
            upperFloodedHa: Math.round(upper.flooded * ha),
            upperMaxDepthM: Math.round(upper.maxDepth * 10) / 10,
            clipped: Boolean(upper.clipped || central?.clipped),
            beyondRange: Boolean(upper.beyondRange || central?.beyondRange),
            unratedReason: row.unratedReason || null,
            terrainSampled: grid.valid,
            gridCells: grid.total,
            caveat: FOOTPRINT_CAVEAT,
          };
          records.push(record);
          if (anchor.channel) {
            const flags = [
              record.clipped ? 'cut at grid edge' : null,
              record.beyondRange ? 'beyond curve range' : null,
              record.unratedReason ? 'site unrated' : null,
            ].filter(Boolean);
            const position = Cesium.Cartesian3.fromDegrees(
              row.lon,
              row.lat,
              (anchor.channel.height || 0) + 120,
            );
            entries.push({
              id: `footprint:${row.id}`,
              source: FOOTPRINT_OVERLAY_SOURCE_ID,
              position,
              variant: 'card',
              title: `${row.name} · footprint`,
              details: [
                (central
                  ? `central ${fmtHa(record.centralFloodedHa)} (scenario max depth ${record.centralMaxDepthM} m) · upper ${fmtHa(record.upperFloodedHa)}`
                  : `upper only ${fmtHa(record.upperFloodedHa)} (scenario max depth ${record.upperMaxDepthM} m) · no ensemble median`) +
                  (flags.length ? ` · ${flags.join(' · ')}` : '') +
                  ' · first-order, level surface from the lowest core cell',
              ],
              accent: '#2171b5',
              priority: record.upperFloodedHa,
              collisionGroup: 'ambient-card',
              zIndex: 29,
              interactive: false,
              minDistance: 0,
              maxDistance: 400000,
              distanceFadeStartRatio: 0.6,
              edgeFade: 'keyhole',
              horizonCull: true,
              terrainOcclusion: false,
              gapPx: 15,
              placement: 'below',
            });
          }
          done++;
        }
        removePrimitive();
        if (instances.length) {
          _primitive = (viewer || _viewer).scene.primitives.add(
            new Cesium.Primitive({
              geometryInstances: instances,
              appearance: new Cesium.PerInstanceColorAppearance({
                translucent: true,
                closed: true,
              }),
              asynchronous: true,
              allowPicking: false,
            }),
          );
          _primitive.show = _enabled;
        }
        if (_enabled)
          overlayHost.setEntries(FOOTPRINT_OVERLAY_SOURCE_ID, entries, {
            cohortLimit: 24,
            collisionCapacity: 16,
            moving: false,
          });
        _records = records;
        _progress = null;
        _lastUpdate = Date.now();
        _lastError = null;
        const totalUpper = records.reduce((a, r) => a + r.upperFloodedHa, 0);
        console.log(
          `[Data:KenyaFloodFootprints] Updated: ${records.length} sites, ${instances.length} water cells, upper scenario ${fmtHa(totalUpper)}`,
        );
        governorRequestRender?.('kenya-flood-footprints:update');
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:KenyaFloodFootprints] Update error:', e);
        _lastError = e?.message || 'footprints unavailable';
        _progress = null;
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      _request?.abort();
      _request = null;
      _enabled = false;
      removePrimitive();
      overlayHost.clearSource(FOOTPRINT_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FOOTPRINT_OVERLAY_SOURCE_ID, false);
      _viewer = null;
      _records = [];
      _grids.clear();
      _lastUpdate = null;
      _lastError = null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_records.length) return [];
      return _records.slice(0, Math.max(1, Math.floor(maxCount) || 2000));
    },

    getStats() {
      const totalUpper = _records.reduce((a, r) => a + r.upperFloodedHa, 0);
      const totalCentral = _records.reduce((a, r) => a + r.centralFloodedHa, 0);
      return {
        count: _records.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        status:
          _progress ||
          (_records.length
            ? `central ${fmtHa(totalCentral)} · upper ${fmtHa(totalUpper)} · terrain mesh × hydraulic geometry, first order`
            : undefined),
        coverage: `Kenya · ${cells}×${cells} cells over ±${halfKm} km per site`,
      };
    },
  };
  return layer;
}
