/**
 * @module kenyaFloodFootprints/model
 * @description First-order forecast inundation footprints from terrain plus
 * discharge, pure maths so it can be unit-tested. The Cesium layer samples
 * the terrain mesh around each river site into a grid; this module turns a
 * discharge into a water-surface height above the channel and floods the
 * grid from the channel outward (a HAND-style fill: only cells connected to
 * the channel below the water surface count).
 *
 * Hydraulic geometry (global, Andreadis, Schumann & Pavelsky 2013, WRR):
 * bankfull depth D = 0.27·Qbf^0.30 m and width W = 7.2·Qbf^0.50 m, with the
 * 2-year return level standing in for bankfull discharge. At-a-station stage
 * scales with the same exponent, so stage(Q) = D·(Q/Q2)^0.30. Water above the
 * channel bed at discharge Q is stage(Q); the flood-plain footprint is every
 * connected cell whose ground sits below bed + stage(Q). This is not a
 * hydraulic model: no roughness, no dykes, no timing. It is where water of
 * that volume can physically sit on this terrain, which is what a county
 * officer asks first.
 */

/** Water shallower than this (m) is not counted or drawn. */
export const MIN_DEPTH_M = 0.05;
/** Beyond this Q/Q2 the stage curve is outside anything we can defend. */
export const MAX_RATIO = 10;

/** Andreadis et al. 2013 global bankfull relations. */
export const HG_DEPTH_COEF = 0.27;
export const HG_DEPTH_EXP = 0.3;
export const HG_WIDTH_COEF = 7.2;
export const HG_WIDTH_EXP = 0.5;

/** Bankfull depth (m) for a bankfull discharge (m³/s). */
export function bankfullDepth(qBankfull) {
  if (!(qBankfull > 0)) return 0;
  return HG_DEPTH_COEF * Math.pow(qBankfull, HG_DEPTH_EXP);
}

/** Bankfull width (m) for a bankfull discharge (m³/s). */
export function bankfullWidth(qBankfull) {
  if (!(qBankfull > 0)) return 0;
  return HG_WIDTH_COEF * Math.pow(qBankfull, HG_WIDTH_EXP);
}

/**
 * Stage (m above the channel bed) at discharge `q` given bankfull `qBankfull`.
 * Above bankfull the flood plain is wide, so stage grows more slowly: the
 * excess uses a flat-plain exponent of 0.15 on the ratio.
 */
export function stageForDischarge(q, qBankfull) {
  if (!(q > 0) || !(qBankfull > 0)) return 0;
  const depth = bankfullDepth(qBankfull);
  const ratio = q / qBankfull;
  if (ratio <= 1) return depth * Math.pow(ratio, HG_DEPTH_EXP);
  return depth * (1 + 0.5 * (Math.pow(ratio, 0.15) - 1) * 4);
}

/**
 * Channel bed elevation: the lowest ground in the core of the grid (the
 * site sits on the GloFAS cell, which is ~5 km, so search a window).
 * @param {Float32Array|number[]} heights Row-major grid, NaN for unknown.
 * @param {number} cols
 * @param {number} rows
 * @param {number} [coreRadius] Cells around the centre to search.
 * @returns {{index:number,height:number}|null}
 */
export function findChannel(
  heights,
  cols,
  rows,
  coreRadius = Math.floor(Math.min(cols, rows) / 4),
) {
  const cr = Math.floor(rows / 2);
  const cc = Math.floor(cols / 2);
  let best = null;
  for (
    let r = Math.max(0, cr - coreRadius);
    r <= Math.min(rows - 1, cr + coreRadius);
    r++
  ) {
    for (
      let c = Math.max(0, cc - coreRadius);
      c <= Math.min(cols - 1, cc + coreRadius);
      c++
    ) {
      const i = r * cols + c;
      const h = heights[i];
      if (!Number.isFinite(h)) continue;
      if (!best || h < best.height) best = { index: i, height: h };
    }
  }
  return best;
}

/**
 * Flood-fill from the channel: cells connected (4-neighbour) to the seed
 * whose ground is at or below `waterSurface`. Returns depth per cell (0 =
 * dry) and the flooded cell count.
 * @param {Float32Array|number[]} heights
 * @param {number} cols
 * @param {number} rows
 * @param {number} seedIndex
 * @param {number} waterSurface Absolute height of the water surface.
 * @returns {{depths:Float32Array, flooded:number, maxDepth:number}}
 */
export function floodFill(heights, cols, rows, seedIndex, waterSurface) {
  const depths = new Float32Array(cols * rows);
  let flooded = 0;
  let maxDepth = 0;
  if (seedIndex < 0 || !Number.isFinite(heights[seedIndex]))
    return { depths, flooded, maxDepth };
  const stack = [seedIndex];
  const seen = new Uint8Array(cols * rows);
  seen[seedIndex] = 1;
  while (stack.length) {
    const i = stack.pop();
    const h = heights[i];
    if (!Number.isFinite(h) || h > waterSurface) continue;
    const d = waterSurface - h;
    // Traverse level ground for connectivity, but only water deeper than
    // MIN_DEPTH_M counts as flooded (zero discharge floods nothing).
    if (d > MIN_DEPTH_M) {
      depths[i] = d;
      flooded++;
      if (d > maxDepth) maxDepth = d;
    }
    const r = Math.floor(i / cols);
    const c = i - r * cols;
    const next = [];
    if (c > 0) next.push(i - 1);
    if (c < cols - 1) next.push(i + 1);
    if (r > 0) next.push(i - cols);
    if (r < rows - 1) next.push(i + cols);
    for (const n of next) {
      if (!seen[n]) {
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
  return { depths, flooded, maxDepth };
}

/**
 * Footprint for one site and one discharge scenario.
 * @param {object} input
 * @param {Float32Array|number[]} input.heights Sampled grid.
 * @param {number} input.cols
 * @param {number} input.rows
 * @param {number} input.discharge Scenario discharge (m³/s).
 * @param {number} input.qBankfull Bankfull (Q2) discharge (m³/s).
 * @returns {{stage:number, waterSurface:number|null, channel:object|null, depths:Float32Array, flooded:number, maxDepth:number}}
 */
export function computeFootprint({
  heights,
  cols,
  rows,
  discharge,
  qBankfull,
}) {
  const channel = findChannel(heights, cols, rows);
  const stage = stageForDischarge(discharge, qBankfull);
  const beyondRange = qBankfull > 0 && discharge / qBankfull > MAX_RATIO;
  if (!channel) {
    return {
      stage,
      waterSurface: null,
      channel: null,
      depths: new Float32Array(cols * rows),
      flooded: 0,
      maxDepth: 0,
      clipped: false,
      beyondRange,
    };
  }
  const waterSurface = channel.height + stage;
  const fill = floodFill(heights, cols, rows, channel.index, waterSurface);
  return {
    stage,
    waterSurface,
    channel,
    ...fill,
    clipped: touchesEdge(fill.depths, cols, rows),
    beyondRange,
  };
}

/** True when any flooded cell lies on the grid boundary: the footprint is cut off. */
export function touchesEdge(depths, cols, rows) {
  for (let c = 0; c < cols; c++) {
    if (depths[c] > 0 || depths[(rows - 1) * cols + c] > 0) return true;
  }
  for (let r = 0; r < rows; r++) {
    if (depths[r * cols] > 0 || depths[r * cols + cols - 1] > 0) return true;
  }
  return false;
}

/**
 * Grid geometry helper: cell centre for (row, col) in a box of `halfKm`
 * around (lat, lon). Rows go north to south.
 */
export function gridSpec({ lat, lon, halfKm = 3, cells = 31 }) {
  const dLat = halfKm / 111.32;
  const dLon = halfKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const step = 2 / (cells - 1);
  return {
    cols: cells,
    rows: cells,
    cellLatDeg: (2 * dLat) / (cells - 1),
    cellLonDeg: (2 * dLon) / (cells - 1),
    center(r, c) {
      return {
        lat: lat + dLat - r * step * dLat,
        lon: lon - dLon + c * step * dLon,
      };
    },
  };
}

/** Depth → colour ramp (CSS) for the water surface. */
export function depthColor(depth) {
  if (depth >= 3) return '#08306b';
  if (depth >= 1.5) return '#2171b5';
  if (depth >= 0.5) return '#6baed6';
  return '#c6dbef';
}
