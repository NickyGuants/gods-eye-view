import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleLMoments,
  gumbelFromAnnualMaxima,
  gumbelQuantile,
  gumbelReturnPeriod,
  thresholdKey,
} from './returnPeriods.js';

test('L-moments of a known sample', () => {
  // Hosking's unbiased estimators on 1..10: λ1 = 5.5, λ2 = 1.8333…
  const lm = sampleLMoments([3, 1, 10, 2, 9, 4, 8, 5, 7, 6]);
  assert.ok(Math.abs(lm.l1 - 5.5) < 1e-9);
  assert.ok(Math.abs(lm.l2 - 11 / 6) < 1e-9);
});

test('Gumbel fit reproduces the parameters of a synthetic Gumbel sample', () => {
  // Exact quantiles of Gumbel(mu=100, beta=25) at plotting positions.
  const n = 40;
  const sample = [];
  for (let i = 1; i <= n; i++) {
    const p = (i - 0.44) / (n + 0.12); // Gringorten
    sample.push(100 - 25 * Math.log(-Math.log(p)));
  }
  const fit = gumbelFromAnnualMaxima(sample);
  assert.ok(Math.abs(fit.mu - 100) < 2, `mu ${fit.mu}`);
  assert.ok(Math.abs(fit.beta - 25) < 2, `beta ${fit.beta}`);
  assert.equal(fit.years, 40);
  assert.ok(fit.thresholds.q1_5 < fit.thresholds.q2);
  assert.ok(fit.thresholds.q2 < fit.thresholds.q5);
  assert.ok(fit.thresholds.q5 < fit.thresholds.q20);
});

test('quantile and return period invert each other', () => {
  for (const T of [1.5, 2, 5, 20, 100]) {
    const q = gumbelQuantile(100, 25, T);
    assert.ok(Math.abs(gumbelReturnPeriod(100, 25, q) - T) < 1e-9);
  }
  assert.equal(gumbelReturnPeriod(100, 25, null), null);
  assert.equal(gumbelReturnPeriod(100, 0, 5), null);
});

test('degenerate samples do not fit', () => {
  assert.equal(gumbelFromAnnualMaxima([5]), null);
  assert.equal(gumbelFromAnnualMaxima([5, 5, 5, 5]), null);
});

test('threshold keys', () => {
  assert.equal(thresholdKey(1.5), 'q1_5');
  assert.equal(thresholdKey(20), 'q20');
});
