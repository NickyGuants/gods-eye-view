/**
 * @module kenyaRiverGauges/returnPeriods
 * @description Gumbel (EV1) return levels from annual maxima, fitted by
 * L-moments, the way CEMS GloFAS derives its flood thresholds. Pure maths,
 * shared by the offline thresholds script and the browser layer.
 */

/** Euler–Mascheroni constant. */
const EULER_GAMMA = 0.5772156649015329;

/** Return periods (years) we publish thresholds for. */
export const RETURN_PERIODS = Object.freeze([1.5, 2, 5, 20]);

/** Threshold key for a return period: 1.5 → "q1_5", 20 → "q20". */
export function thresholdKey(returnPeriod) {
  return `q${String(returnPeriod).replace('.', '_')}`;
}

/**
 * Sample L-moments λ1, λ2 of a series (Hosking 1990, unbiased estimators).
 * @param {number[]} values
 * @returns {{l1:number,l2:number}|null}
 */
export function sampleLMoments(values) {
  const x = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = x.length;
  if (n < 2) return null;
  let b0 = 0;
  let b1 = 0;
  for (let i = 0; i < n; i++) {
    b0 += x[i];
    b1 += (i / (n - 1)) * x[i];
  }
  b0 /= n;
  b1 /= n;
  return { l1: b0, l2: 2 * b1 - b0 };
}

/**
 * Fit a Gumbel distribution to annual maxima by L-moments.
 * β = λ2 / ln 2, μ = λ1 − γ·β. Return level for period T:
 * μ − β·ln(−ln(1 − 1/T)).
 * @param {number[]} annualMaxima One value per year (≥ 10 years to be useful).
 * @returns {{mu:number,beta:number,years:number,thresholds:Record<string,number>}|null}
 */
export function gumbelFromAnnualMaxima(annualMaxima) {
  const lm = sampleLMoments(annualMaxima);
  if (!lm || !(lm.l2 > 0)) return null;
  const beta = lm.l2 / Math.LN2;
  const mu = lm.l1 - EULER_GAMMA * beta;
  const thresholds = {};
  for (const T of RETURN_PERIODS) {
    thresholds[thresholdKey(T)] =
      Math.round(gumbelQuantile(mu, beta, T) * 100) / 100;
  }
  return {
    mu,
    beta,
    years: annualMaxima.filter(Number.isFinite).length,
    thresholds,
  };
}

/** Return level (discharge) for return period T under Gumbel(μ, β). */
export function gumbelQuantile(mu, beta, T) {
  if (!(T > 1)) return mu;
  return mu - beta * Math.log(-Math.log(1 - 1 / T));
}

/** Return period (years) of a discharge x under Gumbel(μ, β); Infinity-safe. */
export function gumbelReturnPeriod(mu, beta, x) {
  if (!Number.isFinite(x) || !(beta > 0)) return null;
  const p = 1 - Math.exp(-Math.exp(-(x - mu) / beta)); // annual exceedance
  if (!(p > 0)) return Infinity;
  return 1 / p;
}
