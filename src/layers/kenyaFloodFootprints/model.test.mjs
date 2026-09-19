import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bankfullDepth,
  bankfullWidth,
  stageForDischarge,
  findChannel,
  floodFill,
  computeFootprint,
  gridSpec,
} from './model.js';

test('hydraulic geometry follows Andreadis et al. 2013', () => {
  assert.ok(Math.abs(bankfullDepth(1000) - 0.27 * Math.pow(1000, 0.3)) < 1e-9);
  assert.ok(Math.abs(bankfullWidth(1000) - 7.2 * Math.sqrt(1000)) < 1e-9);
  assert.equal(bankfullDepth(0), 0);
  assert.equal(stageForDischarge(500, 1000) < bankfullDepth(1000), true);
  assert.ok(Math.abs(stageForDischarge(1000, 1000) - bankfullDepth(1000)) < 1e-9);
  assert.ok(stageForDischarge(4000, 1000) > bankfullDepth(1000));
  assert.ok(stageForDischarge(4000, 1000) < 2 * bankfullDepth(1000) + 1, 'flood plain grows slowly');
});

test('channel is the lowest core cell and the fill only reaches connected low ground', () => {
  // 5×5: a valley down the middle column at 10 m, banks at 12, and a pit at
  // 5 m in the top-right corner walled off by 20 m ground.
  const h = [
    20, 12, 10, 20, 5,
    20, 12, 10, 12, 20,
    20, 12, 10, 12, 20,
    20, 12, 10, 12, 20,
    20, 12, 10, 12, 20,
  ];
  const ch = findChannel(h, 5, 5);
  assert.equal(ch.height, 10);
  const fill = floodFill(h, 5, 5, ch.index, 12.5);
  assert.equal(fill.flooded, 14); // the 10 m column and the 12 m bank cells
  assert.ok(Math.abs(fill.maxDepth - 2.5) < 1e-6);
  assert.equal(fill.depths[4], 0, 'the walled-off pit stays dry');
  const dry = floodFill(h, 5, 5, ch.index, 9);
  assert.equal(dry.flooded, 0);
  // A surface exactly at the channel bed floods nothing: zero discharge, zero area.
  assert.equal(floodFill(h, 5, 5, ch.index, 10).flooded, 0);
});

test('computeFootprint scales with discharge and handles missing terrain', () => {
  const h = new Float32Array(31 * 31).fill(97);
  h[15 * 31 + 15] = 95; // channel, 2 m below the plain
  const small = computeFootprint({ heights: h, cols: 31, rows: 31, discharge: 10, qBankfull: 500 });
  const big = computeFootprint({ heights: h, cols: 31, rows: 31, discharge: 5000, qBankfull: 500 });
  assert.equal(small.flooded, 1);
  assert.ok(big.flooded > small.flooded);
  const nan = computeFootprint({ heights: new Float32Array(9).fill(NaN), cols: 3, rows: 3, discharge: 10, qBankfull: 5 });
  assert.equal(nan.channel, null);
  assert.equal(nan.flooded, 0);
  const zero = computeFootprint({ heights: h, cols: 31, rows: 31, discharge: 0, qBankfull: 500 });
  assert.equal(zero.flooded, 0);
  assert.equal(big.clipped, true, 'a plain-wide flood reaches the grid edge');
  assert.equal(small.clipped, false);
  assert.equal(computeFootprint({ heights: h, cols: 31, rows: 31, discharge: 6000, qBankfull: 500 }).beyondRange, true);
});

test('grid centres span the box symmetrically', () => {
  const g = gridSpec({ lat: 0, lon: 34, halfKm: 3, cells: 31 });
  const nw = g.center(0, 0);
  const se = g.center(30, 30);
  assert.ok(Math.abs(nw.lat - 3 / 111.32) < 1e-9);
  assert.ok(Math.abs(se.lat + 3 / 111.32) < 1e-9);
  assert.ok(nw.lon < 34 && se.lon > 34);
  assert.ok(Math.abs(g.center(15, 15).lat) < 1e-9);
});
