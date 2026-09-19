import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAlpha,
  resolveImergLayer,
  imergTimeFor,
  IMERG_PRODUCTS,
  GIBS_WMTS_URL,
} from './model.js';

test('alpha is clamped and falls back when not a number', () => {
  assert.equal(normalizeAlpha(0.5), 0.5);
  assert.equal(normalizeAlpha(5), 1);
  assert.equal(normalizeAlpha(-1), 0.1);
  assert.equal(normalizeAlpha('x', 0.7), 0.7);
});

test('products resolve by key or identifier, unknown falls back to rate', () => {
  assert.equal(resolveImergLayer('rate'), IMERG_PRODUCTS.rate);
  assert.equal(resolveImergLayer('rate30'), IMERG_PRODUCTS.rate30);
  assert.equal(resolveImergLayer(IMERG_PRODUCTS.rate30), IMERG_PRODUCTS.rate30);
  assert.equal(resolveImergLayer('bogus'), IMERG_PRODUCTS.rate);
  assert.equal(resolveImergLayer(undefined), IMERG_PRODUCTS.rate);
});

test('explicit IMERG times land on a completed half-hour after latency', () => {
  const t = imergTimeFor(Date.UTC(2026, 8, 19, 12, 47, 13), 5 * 3600 * 1000);
  assert.equal(t, '2026-09-19T07:30:00Z');
});

test('the WMTS endpoint is the GIBS Web Mercator best endpoint', () => {
  assert.match(
    GIBS_WMTS_URL,
    /^https:\/\/gibs\.earthdata\.nasa\.gov\/wmts\/epsg3857\/best\//,
  );
});
