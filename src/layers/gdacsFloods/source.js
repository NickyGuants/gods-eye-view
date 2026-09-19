/**
 * @module gdacsFloods/source
 * @description Fetch GDACS flood events (CORS-open JSON, no key) for the last
 * `days` days. https://www.gdacs.org/ — data © EC JRC / UN OCHA, free reuse
 * with attribution.
 */
import { normalizeGdacsEvents } from './records.js';

export const GDACS_SEARCH_URL =
  'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
export const GDACS_WINDOW_DAYS = 90;

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Build the search URL. Exported for tests. */
export function buildGdacsUrl({ now, days = GDACS_WINDOW_DAYS } = {}) {
  const to = now ?? Date.now();
  const params = new URLSearchParams({
    eventlist: 'FL',
    fromDate: isoDate(to - days * 86400000),
    toDate: isoDate(to),
  });
  return `${GDACS_SEARCH_URL}?${params}`;
}

/**
 * @param {object} [options]
 * @param {function} [options.fetchImpl]
 * @param {function():number} [options.now]
 * @param {number} [options.days]
 */
export function createGdacsFloodSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  days = GDACS_WINDOW_DAYS,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const url = buildGdacsUrl({ now: now(), days });
      const response = await fetchImpl(url, { signal });
      if (!response.ok) throw new Error(`GDACS HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeGdacsEvents(payload);
      if (!rows) throw new Error('Malformed GDACS response');
      return {
        rows,
        fromDate: isoDate(now() - days * 86400000),
        toDate: isoDate(now()),
      };
    },
  };
}
