/**
 * @module kenyaCountyRain/source
 * @description Fetch a daily rainfall forecast for every Kenyan county from
 * the Open-Meteo forecast API (https://open-meteo.com, CC BY 4.0, no key,
 * CORS-enabled). One request carries all 47 centroids. Portable: `fetchImpl`
 * is injected and nothing here touches the browser.
 */
import { KENYA_COUNTIES } from './counties.js';
import { normalizeRainSnapshot } from './records.js';

export const FORECAST_API_URL = 'https://api.open-meteo.com/v1/forecast';
export const RAIN_PAST_DAYS = 7;
export const RAIN_FORECAST_DAYS = 10;
export const RAIN_TIMEZONE = 'Africa/Nairobi';

/** Build the multi-location forecast URL. Exported for tests. */
export function buildForecastUrl(counties) {
  const params = new URLSearchParams({
    latitude: counties.map((c) => c.lat.toFixed(4)).join(','),
    longitude: counties.map((c) => c.lon.toFixed(4)).join(','),
    daily: 'precipitation_sum,precipitation_probability_max',
    past_days: String(RAIN_PAST_DAYS),
    forecast_days: String(RAIN_FORECAST_DAYS),
    timezone: RAIN_TIMEZONE,
  });
  return `${FORECAST_API_URL}?${params.toString()}`;
}

/** Local calendar date for a timezone, `YYYY-MM-DD`. */
export function localDateIso(timestampMs, timeZone = RAIN_TIMEZONE) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(timestampMs));
  } catch {
    return new Date(timestampMs).toISOString().slice(0, 10);
  }
}

/**
 * @param {object} [options]
 * @param {function} [options.fetchImpl]
 * @param {readonly object[]} [options.counties]
 * @param {function():number} [options.now]
 */
export function createOpenMeteoRainSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  counties = KENYA_COUNTIES,
  now = () => Date.now(),
} = {}) {
  return {
    counties,
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(buildForecastUrl(counties), { signal });
      if (!response.ok)
        throw new Error(`Open-Meteo forecast HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeRainSnapshot(payload, counties, {
        todayIso: localDateIso(now()),
      });
      if (!rows) throw new Error('Malformed Open-Meteo forecast response');
      return rows;
    },
  };
}
